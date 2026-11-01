import { fallbackRows } from '../lib/rows.mjs';
import { dayAfter, isoDate, parseTables, sections, stripMarkup } from '../lib/markdown.mjs';

export const META = { sheet: 'google', serviceProviderName: 'Google' };

const NOT_TEXT_MODEL =
  /Live|Translate|Transcribe|TTS|Image|Banana|Lyria|Embedding|Robotics|Omni|Gemma|Pricing for|Notes/;
const TIERS = { Standard: 'standard', Batch: 'batch', Flex: 'flex', Priority: 'priority', Contributor: 'contributor' };
const STORAGE_UNIT = '1000000 Token-Hours';
const DATE = '([A-Z][a-z]+ \\d{1,2}, \\d{4})';

function schedule(words) {
  const through = new RegExp(`through ${DATE}`).exec(words);
  if (through) return { EffectiveEnd: dayAfter(isoDate(through[1])) };
  const starting = new RegExp(`starting ${DATE}`).exec(words);
  return starting ? { EffectiveStart: isoDate(starting[1]) } : {};
}

function context(words) {
  const under = /prompts <= (\d+)k/.exec(words);
  if (under) return { ContextTierMaxInputTokens: Number(under[1]) * 1000 };
  const over = /prompts > (\d+)k/.exec(words);
  return over ? { ContextTierMinInputTokens: Number(over[1]) * 1000 } : {};
}

const KNOWN_QUALIFIER =
  /^(?:,? ?\(?text(?: \/ image)?(?: \/ video)?(?: \/ audio)?\)?|, prompts <= \d+k(?: tokens)?|, prompts > \d+k(?: tokens)?|\/ 1,000,000 tokens per hour \(storage price\)(?: (?:through|starting) .*)?|(?:through|starting) .*|Implicit caching only.*|)$/;

// One cell can hold several prices: dated steps, prompt-length tiers, modalities and a storage price.
export function readPriceCell(cell) {
  const text = cell
    .replaceAll('\\<', '<')
    .replaceAll('\\>', '>')
    .replace(/\^\\\*.*$/, '')
    .trim();
  const pieces = text.split('$').slice(1);
  const found = [];
  for (const piece of pieces) {
    const [, amount, rest] = /^(\d+(?:\.\d+)?)\s*(.*)$/s.exec(piece);
    const qualifier = rest.trim().replace(/\.$/, '');
    if (qualifier.startsWith('(audio)') || qualifier.startsWith('(video)')) continue;
    if (!KNOWN_QUALIFIER.test(qualifier))
      throw new Error(`google: unread qualifier ${JSON.stringify(qualifier)} in ${JSON.stringify(cell)}`);
    found.push({
      amount,
      storage: qualifier.includes('storage price'),
      ...schedule(qualifier),
      ...context(qualifier),
    });
  }
  return found;
}

const plainHeading = (heading) =>
  stripMarkup(heading)
    .replace(/[^\x20-\x7E]/g, '')
    .trim();

const idsOf = (body) => {
  const line = body.split('\n').find((candidate) => candidate.startsWith('*['));
  if (!line) throw new Error(`google: no model id in ${body.slice(0, 80)}`);
  return [...line.matchAll(/`([a-z0-9.-]+)`/g)].map((match) => match[1]);
};

const paidColumn = ({ header }) => {
  const column = header.find((name) => name.startsWith('Paid Tier'));
  if (!column) throw new Error(`google: no paid column in ${header.join(' | ')}`);
  return column;
};

export function parse(pages, factory) {
  const pricing = pages['google-pricing'];
  const rows = [];
  const omittedHeadings = [];
  const thinkingIncluded = new Set();
  const thinkingUnstated = new Set();

  for (const { heading, body } of sections(pricing.text, 2)) {
    if (NOT_TEXT_MODEL.test(heading)) {
      if (!/Pricing for|Notes/.test(heading)) omittedHeadings.push(heading);
      continue;
    }
    const ids = idsOf(body);
    const ModelStatus = /Preview/.test(heading) ? 'preview' : 'unstated';
    for (const { heading: tierName, body: tierBody } of sections(body, 3)) {
      const ServiceTier = TIERS[tierName];
      if (!ServiceTier) throw new Error(`google: unknown tier ${tierName} under ${heading}`);
      const table = parseTables(tierBody)[0];
      const paid = paidColumn(table);
      for (const row of table.rows) {
        const label = row[table.header[0]];
        const TokenClass = /^Input price/.test(label)
          ? 'input_uncached'
          : /^Output price/.test(label)
            ? 'output'
            : /^Context caching price/.test(label)
              ? 'cache_read'
              : null;
        if (!TokenClass) continue;
        if (TokenClass === 'output') {
          const statement = label.includes('thinking') ? thinkingIncluded : thinkingUnstated;
          for (const id of ids) statement.add(id);
        }
        for (const { amount, storage, ...scope } of readPriceCell(row[paid])) {
          for (const ModelId of ids) {
            rows.push(
              factory.price(pricing, {
                ModelId,
                ModelName: heading,
                ModelStatus,
                ServiceTier,
                ...scope,
                ...(storage ? { TokenClass: 'cache_storage', PricingUnit: STORAGE_UNIT } : { TokenClass }),
                ListUnitPrice: amount,
              }),
            );
          }
        }
      }
    }
  }

  if (thinkingIncluded.size === 0) throw new Error('google: no output row says thinking tokens are included');
  rows.push(factory.reasoning(pricing, { key: 'thinking-tokens', AppliesToModels: [...thinkingIncluded] }));

  rows.push(
    ...fallbackRows(factory, pricing, rows, {
      inScope: (row) => row.TokenClass !== 'cache_storage',
      basis:
        'Highest paid-tier standard list price per token class across every text model on the page, scheduled rises included.',
    }),
  );

  return {
    rows,
    omissions: [
      {
        item: omittedHeadings.map(plainHeading).join('; '),
        reason: 'On the page, outside the text-token scope of release 0.1.',
      },
      ...[...thinkingUnstated].map((id) => ({
        item: `reasoning billing for ${id}`,
        reason: 'Its output row does not say thinking tokens are included.',
      })),
      {
        item: 'Audio and video input rates inside text models',
        reason: 'On the page, outside the text-token scope of release 0.1.',
      },
      {
        item: 'cache_write_5m and cache_write_1h',
        reason: 'The page publishes a context caching read price and an hourly storage price, no write price.',
      },
      {
        item: 'Grounding, Maps and other tool prices',
        reason: 'On the page with per-generation free allowances. Not modelled in schema 0.1.',
      },
      { item: 'Fast mode', reason: 'The page has no tier by that name. Priority rows carry the page’s own word.' },
      { item: 'Data-residency prices', reason: 'Not on the page.' },
      {
        item: 'Gemini Enterprise Agent Platform prices',
        reason: 'The page says they may differ and points elsewhere. Not read for this release.',
      },
      { item: 'Tool overhead tokens and tokenizer version', reason: 'Not on the page.' },
    ],
  };
}
