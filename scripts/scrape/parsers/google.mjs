import { dayAfter, isoDate, sections, stripMarkup } from '../lib/markdown.mjs';

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
  const pieces = cell.trim().split('$').slice(1);
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
  stripMarkup(heading.replace(/\{%.*?%\}/g, ''))
    .replace(/[^\x20-\x7E]/g, '')
    .trim();

// The ids sit in one italic run of links under the heading, which can wrap over several lines.
const idsOf = (body) => {
  const run = /^\s*\*\[[\s\S]*?\)\*$/m.exec(body);
  if (!run) throw new Error(`google: no model id in ${body.slice(0, 80)}`);
  return [...run[0].matchAll(/`([a-z0-9.-]+)`/g)].map((match) => match[1]);
};

const DEPRECATED = /\{% callout type="caution" %\}(?:(?!\{% \/callout %\})[\s\S])*\bdeprecated\b/;

const cellText = (lines) =>
  lines
    .join(' ')
    .replace(/\{% sup %\}.*?\{% \/sup %\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// A Markdoc table: "* " opens a cell, a line of "---" closes a row, and any other line continues the cell.
function markdocTable(source) {
  const rows = source
    .split(/^\s*---\s*$/m)
    .map((block) => {
      const cells = [];
      for (const line of block.split('\n').filter((candidate) => candidate.trim() !== '')) {
        const opened = /^\s*\* (.*)$/.exec(line);
        if (opened) cells.push([opened[1]]);
        else if (cells.length > 0) cells.at(-1).push(line.trim());
        else throw new Error(`google: text before the first cell: ${JSON.stringify(line.trim())}`);
      }
      return cells.map(cellText);
    })
    .filter((cells) => cells.length > 0);
  const [header, ...body] = rows;
  for (const cells of body) {
    if (cells.length !== header.length)
      throw new Error(`google: a row of ${cells.length} cells under ${header.length} columns: ${cells[0]}`);
  }
  return { header, rows: body.map((cells) => Object.fromEntries(header.map((name, at) => [name, cells[at]]))) };
}

// Each tier is a tab holding one table.
function tierTables(body) {
  const tabs = [...body.matchAll(/\{% tab title="([^"]+)" %\}([\s\S]*?)\{% \/tab %\}/g)];
  if (tabs.length === 0) throw new Error(`google: no tier tabs in ${body.slice(0, 80)}`);
  return tabs.map(([, tierName, tab]) => {
    const table = /\{% table %\}([\s\S]*?)\{% \/table %\}/.exec(tab);
    if (!table) throw new Error(`google: no table in the ${tierName} tab`);
    return { tierName, table: markdocTable(table[1]) };
  });
}

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
      if (!/Pricing for|Notes/.test(heading)) omittedHeadings.push(plainHeading(heading));
      continue;
    }
    const ids = idsOf(body);
    const ModelName = plainHeading(heading);
    const ModelStatus = DEPRECATED.test(body) ? 'deprecated' : /Preview/.test(heading) ? 'preview' : 'unstated';
    for (const { tierName, table } of tierTables(body)) {
      const ServiceTier = TIERS[tierName];
      if (!ServiceTier) throw new Error(`google: unknown tier ${tierName} under ${ModelName}`);
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
                ModelName,
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

  return {
    rows,
    omissions: [
      {
        item: omittedHeadings.join('; '),
        reason: 'On the page, outside the text-token scope of the catalog.',
      },
      ...[...thinkingUnstated].map((id) => ({
        item: `reasoning billing for ${id}`,
        reason: 'Its output row does not say thinking tokens are included.',
      })),
      {
        item: 'Audio and video input rates inside text models',
        reason: 'On the page, outside the text-token scope of the catalog.',
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
