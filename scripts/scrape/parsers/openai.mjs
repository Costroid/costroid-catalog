import { compareDecimals, multiplyDecimals } from '../lib/decimal.mjs';
import { dayAfter, isoDate, moneyOf, parseTables, requireMatch, stripMarkup } from '../lib/markdown.mjs';

export const META = { sheet: 'openai', serviceProviderName: 'OpenAI' };

const TIERS = { Standard: 'standard', Batch: 'batch', Flex: 'flex', Fast: 'fast', Ultrafast: 'ultrafast' };
const SECTIONS = [
  'Flagship models',
  'Multimodal models',
  'Images',
  'GPT-Live',
  'Realtime & Audio',
  'Transcription',
  'Specialized models',
  'Tools',
  'Fine-tuning',
  'Cloud platforms',
];
const PRICED_SECTIONS = new Set(['Flagship models', 'Specialized models']);
// The first words of a Category cell. A category the parser does not know stops the build.
const PRICED_CATEGORIES = new Set([
  'Cyber',
  'Life Sciences',
  'Legal',
  'Legal model configurations',
  'ChatGPT',
  'Codex',
  'Search',
]);
const UNPRICED_CATEGORIES = new Set(['Embedding', 'Moderation']);
const CONTEXT_CLASSES = [
  ['input', 'input_uncached'],
  ['output', 'output'],
  ['cached input', 'cache_read'],
  ['30m write', 'cache_write_30m'],
  ['12h write', 'cache_write_12h'],
];

// A tier can print a promotion table and a list table, each priced over its own dates.
const TIER_HEADING = /^(Standard|Batch|Flex|Fast|Ultrafast)(?: (promotion|list))?(?: pricing data)?$/;
const TABLE_TITLE = /^(?:Grouped )?Pricing Table data$/;
const SUBHEADINGS = new Set(['Speed']);
const MARKDOWN_HEADING = /^#{1,6} (.+)$/;
const TITLE_LINE = /^[A-Z][^.:;!?|<>[\]{}*]*[^.:;!?|<>[\]{}*\s]$/;
const blank = (line) => line === undefined || line.trim() === '';

// The page marks headings two ways: Markdown hashes, and a title-like line standing alone between blank lines.
function headingAt(lines, index) {
  const line = lines[index].trim();
  const marked = MARKDOWN_HEADING.exec(line);
  if (marked) return marked[1].trim();
  return blank(lines[index - 1]) && blank(lines[index + 1]) && TITLE_LINE.test(line) ? line : null;
}

// Walks up from a table to its section. Every heading on the way must be one the parser knows,
// so a renamed section stops the build instead of lending its table to the section above it.
function locate(lines, tableLine) {
  let nearest = null;
  for (let index = tableLine - 1; index >= 0; index -= 1) {
    const heading = headingAt(lines, index);
    if (heading === null) continue;
    const [, tierWord, phase = null] = TIER_HEADING.exec(heading) ?? [];
    if (tierWord) nearest ??= { tierWord, tier: TIERS[tierWord], phase };
    else if (SECTIONS.includes(heading)) return { section: heading, tier: 'standard', phase: null, ...nearest };
    else if (!TABLE_TITLE.test(heading) && !SUBHEADINGS.has(heading))
      throw new Error(`openai: unknown heading ${JSON.stringify(heading)} above the table at line ${tableLine + 1}`);
  }
  throw new Error(`openai: no section above the table at line ${tableLine + 1}`);
}

const DATE = '([A-Z][a-z]+ \\d{1,2}, \\d{4})';
const MODEL_NAME = 'GPT-\\d+(?:\\.\\d+)? [A-Z][a-z]+(?: for [A-Z][a-z]+)?';
const NAME_LIST = new RegExp(`^${MODEL_NAME}(?:, ${MODEL_NAME})*(?:,? and ${MODEL_NAME})?$`);
const PROMOTION = new RegExp(`^(.+?)(?:’s)? promotional pricing is available (until|at least through) ${DATE}\\.$`);
const PHASES = new RegExp(
  `^For (.+), (\\w+) costs (\\d+) times the Standard rate through ${DATE}, and (\\d+) times the Standard rate starting ${DATE}( \\([A-Za-z ]+\\))?\\.$`,
);

const sentencesWith = (page, words) =>
  page
    .split(/\n|(?<=\.) +/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => words.test(sentence));

// "GPT-6 Astra for Law" is the page's name for gpt-6-astra-law. A list that is not all model names stops the build.
function modelIds(names, sentence) {
  if (!NAME_LIST.test(names)) throw new Error(`openai: unread model names in ${JSON.stringify(sentence)}`);
  return names
    .match(new RegExp(MODEL_NAME, 'g'))
    .map((name) => name.toLowerCase().replace(' for ', ' ').replaceAll(' ', '-'));
}

// "available until November 30, 2026" and "available at least through December 31, 2026" both close
// the promotional rows after that day. Past it the page states no price, so the fallback applies.
// No promotion is required: a model whose promotion the page no longer mentions is priced with no end
// from the day the page was read, so a promotion ends on its stated day or on the day the page dropped it.
function promotions(page) {
  const found = new Map();
  for (const sentence of sentencesWith(page, /promotional/i)) {
    const match = PROMOTION.exec(sentence);
    if (!match) throw new Error(`openai: unread promotion ${JSON.stringify(sentence)}`);
    const [, names, words, date] = match;
    for (const ModelId of modelIds(names, sentence)) {
      if (found.has(ModelId)) throw new Error(`openai: two promotions for ${ModelId}`);
      found.set(ModelId, {
        EffectiveEnd: dayAfter(isoDate(date)),
        Note: `Promotional price, available ${words} ${date}.`,
      });
    }
  }
  return found;
}

// "For GPT-6.2 Astra and GPT-6.2 Sol, Ultrafast costs 3 times the Standard rate through February 28, 2027, and
// 6 times the Standard rate starting March 1, 2027 (Pacific time)." dates that tier's promotion and list tables.
function phases(page) {
  const found = new Map();
  for (const sentence of sentencesWith(page, /times the standard rate/i)) {
    const match = PHASES.exec(sentence);
    if (!match || !TIERS[match[2]]) throw new Error(`openai: unread price phases ${JSON.stringify(sentence)}`);
    const [, names, tierWord, promotionTimes, through, listTimes, starting, zone = ''] = match;
    if (found.has(tierWord)) throw new Error(`openai: two sentences date the ${tierWord} phases`);
    found.set(tierWord, {
      models: modelIds(names, sentence),
      promotion: {
        times: promotionTimes,
        fields: {
          EffectiveEnd: dayAfter(isoDate(through)),
          Note: `${tierWord} promotional price, ${promotionTimes} times the Standard rate through ${through}${zone}.`,
        },
      },
      list: {
        times: listTimes,
        fields: {
          EffectiveStart: isoDate(starting),
          Note: `${tierWord} list price, ${listTimes} times the Standard rate starting ${starting}${zone}.`,
        },
      },
    });
  }
  return found;
}

// A phase table row is read only under the sentence that dates it, for a model that sentence names.
function phaseOf(dated, { tierWord, phase }, ModelId) {
  if (phase === null) return null;
  const sentence = dated.get(tierWord);
  if (!sentence) throw new Error(`openai: no sentence dates the ${tierWord} ${phase} table`);
  if (!sentence.models.includes(ModelId))
    throw new Error(`openai: the ${tierWord} ${phase} table lists ${ModelId}, which its sentence does not name`);
  return { tierWord, phase, ...sentence[phase] };
}

const rateKey = (row) =>
  [row.ModelId, row.ContextTierMinInputTokens, row.ContextTierMaxInputTokens, row.TokenClass].join(' ');

// Every model a phase sentence names has rows in both tables, and each is the stated multiple of its Standard price.
function checkPhases(rows, dated, phased) {
  const standard = new Map(rows.filter((row) => row.ServiceTier === 'standard').map((row) => [rateKey(row), row]));
  for (const { row, times } of phased) {
    const base = standard.get(rateKey(row));
    if (!base || compareDecimals(multiplyDecimals(base.ListUnitPrice, times), row.ListUnitPrice) !== 0)
      throw new Error(`openai: ${row.SkuPriceId} is not ${times} times its Standard price`);
  }
  const read = new Set(phased.map(({ tierWord, phase, row }) => `${tierWord} ${phase} ${row.ModelId}`));
  for (const [tierWord, { models }] of dated) {
    for (const ModelId of models) {
      for (const phase of ['promotion', 'list']) {
        if (!read.has(`${tierWord} ${phase} ${ModelId}`))
          throw new Error(`openai: no ${tierWord} ${phase} price for ${ModelId}`);
      }
    }
  }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// The page has said "Starting Nov 1, 2026, FedRAMP endpoints are also charged" and, later, the same without the date.
function fedramp(page) {
  const [, month, day] = requireMatch(
    page,
    /(?:Starting ([A-Z][a-z]{2}) (\d{1,2}, \d{4}), )?FedRAMP endpoints are also charged a 10% uplift\./,
    'FedRAMP uplift',
  );
  if (!month) return {};
  const name = MONTHS.find((candidate) => candidate.startsWith(month));
  if (!name) throw new Error(`openai: unreadable FedRAMP start month ${JSON.stringify(month)}`);
  return { EffectiveStart: isoDate(`${name} ${day}`) };
}

// A Category cell reads "Cyber — Trusted Access: [Daybreak](…)", sometimes after an anchor. Trusted access is limited access.
function categoryOf(cell) {
  const text = stripMarkup(cell.replace(/<[^>]*>/g, ''));
  const [name] = text.split(' — ');
  if (UNPRICED_CATEGORIES.has(name)) return null;
  if (!PRICED_CATEGORIES.has(name)) throw new Error(`openai: unknown category ${JSON.stringify(name)}`);
  return { ModelStatus: text.includes('Trusted Access') ? 'limited' : 'unstated' };
}

// A row of a table without context columns can name its context range after the model id.
function modelRange(cell, threshold) {
  const [, ModelId, range] = requireMatch(cell, /^([\w.-]+)(?: \((short|long) context\))?$/, `model ${cell}`);
  if (range === 'short') return { ModelId, ContextTierMaxInputTokens: threshold };
  return range === 'long' ? { ModelId, ContextTierMinInputTokens: threshold } : { ModelId };
}

const COLUMN_CLASSES = CONTEXT_CLASSES.map(([column, TokenClass]) => [
  column[0].toUpperCase() + column.slice(1),
  TokenClass,
]);

export function parse(pages, factory) {
  const pricing = pages['openai-pricing'];
  const page = pricing.text;
  const lines = page.split('\n');
  const threshold =
    Number(
      requireMatch(
        page,
        /Short context: ≤(\d+)K input tokens\. Long context: >\1K input tokens\./,
        'context threshold',
      )[1],
    ) * 1000;
  const promoted = promotions(page);
  const dated = phases(page);

  const byId = new Map();
  const phased = [];
  const add = (fields, phase) => {
    if (phase && promoted.has(fields.ModelId))
      throw new Error(`openai: ${fields.ModelId} has a promotion and a ${phase.tierWord} ${phase.phase} price`);
    const row = factory.price(pricing, { ...fields, ...(phase ? phase.fields : promoted.get(fields.ModelId)) });
    const seen = byId.get(row.SkuPriceId);
    if (seen && seen.ListUnitPrice !== row.ListUnitPrice) throw new Error(`openai: ${row.SkuPriceId} has two prices`);
    byId.set(row.SkuPriceId, row);
    if (phase) phased.push({ ...phase, row });
  };

  for (const table of parseTables(page)) {
    const { section, tier, ...heading } = locate(lines, table.line);
    if (!PRICED_SECTIONS.has(section)) continue;
    const isContextTable = table.header.includes('Short context input');
    for (const row of table.rows) {
      const category = row.Category === undefined ? { ModelStatus: 'unstated' } : categoryOf(row.Category);
      if (category === null) continue;
      if (isContextTable) {
        const ModelId = row.Model.replace(/ \(.*$/, '');
        const identity = { ModelId, ModelName: ModelId, ...category, ServiceTier: tier };
        const phase = phaseOf(dated, heading, ModelId);
        for (const [column, TokenClass] of CONTEXT_CLASSES) {
          const short = moneyOf(row[`Short context ${column}`]);
          if (short !== null)
            add({ ...identity, ContextTierMaxInputTokens: threshold, TokenClass, ListUnitPrice: short }, phase);
          const long = moneyOf(row[`Long context ${column}`]);
          if (long !== null)
            add({ ...identity, ContextTierMinInputTokens: threshold, TokenClass, ListUnitPrice: long }, phase);
        }
      } else {
        const { ModelId, ...range } = modelRange(row.Model, threshold);
        const identity = { ModelId, ModelName: ModelId, ...range, ...category, ServiceTier: tier };
        const phase = phaseOf(dated, heading, ModelId);
        for (const [column, TokenClass] of COLUMN_CLASSES) {
          const price = row[column] === undefined ? null : moneyOf(row[column]);
          if (price !== null) add({ ...identity, TokenClass, ListUnitPrice: price }, phase);
        }
      }
    }
  }

  const rows = [...byId.values()];
  for (const ModelId of promoted.keys()) {
    if (!rows.some((row) => row.ModelId === ModelId))
      throw new Error(`openai: a promotion names ${ModelId}, which no priced table lists`);
  }
  checkPhases(rows, dated, phased);

  const residencyDate = requireMatch(
    page,
    /Regional processing \(data residency\) endpoints are charged a 10% uplift for models released on or after ([A-Z][a-z]+ \d+, \d{4})/,
    'data residency uplift',
  )[1];
  const fedrampStart = fedramp(page);
  rows.push(
    factory.multiplier(pricing, {
      key: 'data-residency',
      ModifierKind: 'data_residency',
      RegionId: 'regional',
      Multiplier: '1.1',
      Condition: `Regional processing endpoints, for models released on or after ${residencyDate}. The page lists no release dates.`,
    }),
    factory.multiplier(pricing, {
      key: 'fedramp',
      ModifierKind: 'data_residency',
      RegionId: 'fedramp',
      Multiplier: '1.1',
      ...fedrampStart,
      Condition: 'FedRAMP endpoints.',
    }),
  );

  const toolRows = parseTables(page)
    .flatMap((table) => table.rows)
    .filter((row) => row.Tool);
  const toolPrice = (details) => {
    const row = toolRows.find((candidate) => candidate.Details === details);
    return requireMatch(row?.Pricing ?? '', /^\$([\d.]+) \/ 1k calls/, details)[1];
  };
  rows.push(
    factory.fee(pricing, {
      key: 'web-search',
      FeeName: 'web_search',
      ListUnitPrice: toolPrice('Web search (incl. images)'),
      PricingUnit: '1000 Requests',
      Condition: 'Plus search content tokens at model rates.',
    }),
    factory.fee(pricing, {
      key: 'web-search-preview-non-reasoning',
      FeeName: 'web_search_preview_non_reasoning',
      ListUnitPrice: toolPrice('Web search preview (other models)'),
      PricingUnit: '1000 Requests',
      Condition: 'Search content tokens are free.',
    }),
    factory.fee(pricing, {
      key: 'file-search',
      FeeName: 'file_search',
      ListUnitPrice: toolPrice('Tool call'),
      PricingUnit: '1000 Requests',
      Condition: 'Responses API only.',
    }),
  );

  const reasoning = pages['openai-reasoning'];
  requireMatch(reasoning.text, /billed as \[output\s+tokens\]/, 'reasoning billing');
  rows.push(factory.reasoning(reasoning, { key: 'reasoning-tokens' }));

  return {
    rows,
    omissions: [
      {
        item: 'cache_write_5m and cache_write_1h',
        reason:
          'OpenAI publishes 30-minute and 12-hour cache writes instead. Rows carry cache_write_30m and cache_write_12h.',
      },
      {
        item: 'Realtime, audio, image, transcription, GPT-Live, embedding, moderation and fine-tuning prices',
        reason: 'On the page, outside the text-token scope of the catalog.',
      },
      {
        item: 'Containers (Hosted Shell, Code Interpreter) and file search storage',
        reason: 'On the page, not modelled in schema 0.1.',
      },
      {
        item: 'Background request rates for the 2-hour and 8-hour completion windows',
        reason: 'Published as percentages below Standard for named models. Not modelled in schema 0.1.',
      },
      {
        item: 'Data-residency token prices and the list of models the uplift covers',
        reason: 'Published as a percentage with a release-date rule. The page names no release dates.',
      },
      {
        item: 'Amazon Bedrock and Microsoft Azure prices',
        reason: 'The page points to the cloud providers. Not read for this release.',
      },
      { item: 'Tool overhead tokens and tokenizer version', reason: 'Not on the page.' },
    ],
  };
}
