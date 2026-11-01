import { fallbackRows } from '../lib/rows.mjs';
import { moneyOf, parseTables, requireMatch } from '../lib/markdown.mjs';

export const META = { sheet: 'openai', serviceProviderName: 'OpenAI' };

const TIERS = { Standard: 'standard', Batch: 'batch', Flex: 'flex', Fast: 'fast', Ultrafast: 'ultrafast' };
const SECTIONS = [
  'Flagship models',
  'Cyber models',
  'Life sciences models',
  'Legal model configurations',
  'Multimodal models',
  'GPT-Live sessions',
  'Realtime and audio generation models',
  'Image generation models',
  'Transcription models',
  'Tools',
  'Specialized models',
  'Finetuning',
  'Cloud platforms',
];
const PRICED_SECTIONS = new Set([
  'Flagship models',
  'Cyber models',
  'Life sciences models',
  'Legal model configurations',
  'Specialized models',
]);
const CHAT_CATEGORIES = new Set(['ChatGPT', 'Codex', 'Search']);
const LIMITED_SECTIONS = new Set(['Life sciences models']);
const CONTEXT_CLASSES = [
  ['input', 'input_uncached'],
  ['output', 'output'],
  ['cached input', 'cache_read'],
  ['30m write', 'cache_write_30m'],
  ['12h write', 'cache_write_12h'],
];

function locate(lines, tableLine) {
  let section = null;
  let tier = null;
  for (let index = tableLine; index >= 0 && !(section && tier); index -= 1) {
    const line = lines[index].trim();
    if (!section && SECTIONS.includes(line)) section = line;
    const word = /^(?:#### )?(Standard|Batch|Flex|Fast|Ultrafast)$/.exec(line);
    const data = /^### (Standard|Fast|Ultrafast) pricing data$/.exec(line);
    if (!tier && (word || data)) tier = TIERS[(word ?? data)[1]];
  }
  return { section, tier: tier ?? 'standard' };
}

const statusIn = (section) => (LIMITED_SECTIONS.has(section) ? 'limited' : 'unstated');

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
  const promotions = new Map([
    [
      'gpt-5.6-sol',
      requireMatch(
        page,
        /GPT-5\.6 Sol’s promotional pricing is available at least through ([A-Z][a-z]+ \d+, \d{4})\./,
        'GPT-5.6 Sol promotion',
      )[1],
    ],
    [
      'gpt-6-astra-law',
      requireMatch(
        page,
        /GPT-6 Astra for Law promotional pricing is available at least through ([A-Z][a-z]+ \d+, \d{4})\./,
        'GPT-6 Astra for Law promotion',
      )[1],
    ],
  ]);

  const byId = new Map();
  const flagship = new Set();
  const add = (fields) => {
    const promotion = promotions.get(fields.ModelId);
    const row = factory.price(
      pricing,
      promotion ? { ...fields, Note: `Promotional price, available at least through ${promotion}.` } : fields,
    );
    const seen = byId.get(row.SkuPriceId);
    if (seen && seen.ListUnitPrice !== row.ListUnitPrice) throw new Error(`openai: ${row.SkuPriceId} has two prices`);
    byId.set(row.SkuPriceId, row);
  };

  for (const table of parseTables(page)) {
    const { section, tier } = locate(lines, table.line);
    if (!PRICED_SECTIONS.has(section)) continue;
    const isContextTable = table.header.includes('Short context input');
    if (isContextTable && section === 'Flagship models' && tier === 'standard') {
      for (const row of table.rows) flagship.add(row.Model.replace(/ \(.*$/, ''));
    }
    for (const row of table.rows) {
      if (row.Category && !CHAT_CATEGORIES.has(row.Category)) continue;
      const ModelId = (row.Model ?? row['Model configuration']).replace(/ \(.*$/, '');
      const identity = { ModelId, ModelName: ModelId, ModelStatus: statusIn(section), ServiceTier: tier };
      if (isContextTable) {
        for (const [column, TokenClass] of CONTEXT_CLASSES) {
          const short = moneyOf(row[`Short context ${column}`]);
          if (short !== null)
            add({ ...identity, ContextTierMaxInputTokens: threshold, TokenClass, ListUnitPrice: short });
          const long = moneyOf(row[`Long context ${column}`]);
          if (long !== null)
            add({ ...identity, ContextTierMinInputTokens: threshold, TokenClass, ListUnitPrice: long });
        }
      } else {
        for (const [column, TokenClass] of [
          ['Input', 'input_uncached'],
          ['Output', 'output'],
          ['Cached input', 'cache_read'],
        ]) {
          const price = moneyOf(row[column]);
          if (price !== null) add({ ...identity, TokenClass, ListUnitPrice: price });
        }
      }
    }
  }

  const rows = [...byId.values()];

  const residencyDate = requireMatch(
    page,
    /Regional processing \(data residency\) endpoints are charged a 10% uplift for models released on or after ([A-Z][a-z]+ \d+, \d{4})/,
    'data residency uplift',
  )[1];
  requireMatch(page, /Starting Nov 1, 2026, FedRAMP endpoints are also charged a 10% uplift\./, 'FedRAMP uplift');
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
      EffectiveStart: '2026-11-01',
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
      ListUnitPrice: toolPrice('Web search (all models)'),
      PricingUnit: '1000 Requests',
      Condition: 'Plus search content tokens at model rates.',
    }),
    factory.fee(pricing, {
      key: 'web-search-preview-non-reasoning',
      FeeName: 'web_search_preview_non_reasoning',
      ListUnitPrice: toolPrice('Web search preview (non-reasoning models)'),
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

  rows.push(
    ...fallbackRows(factory, pricing, rows, {
      inScope: (row) => flagship.has(row.ModelId),
      basis:
        'Highest standard-tier, short-context list price per token class across the first table of the Flagship models section.',
    }),
  );

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
        reason: 'On the page, outside the text-token scope of release 0.1.',
      },
      {
        item: 'Containers (Hosted Shell, Code Interpreter) and file search storage',
        reason: 'On the page, not modelled in schema 0.1.',
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
