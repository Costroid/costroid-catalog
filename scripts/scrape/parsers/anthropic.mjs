import { moneyOf, parseTables, requireMatch, sections, stripMarkup } from '../lib/markdown.mjs';

export const META = { sheet: 'anthropic', serviceProviderName: 'Anthropic' };

const TOKEN_CLASSES = ['input_uncached', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'output'];
const STATUS = { Active: 'active', Deprecated: 'deprecated', Retired: 'retired' };

const findTable = (tables, column) => {
  const table = tables.find(({ header }) => header.includes(column));
  if (!table) throw new Error(`anthropic: no table with column ${JSON.stringify(column)}`);
  return table;
};

const displayName = (cell) =>
  requireMatch(stripMarkup(cell), /^Claude [A-Z][a-z]+ \d+(?:\.\d+)?/, `model in ${cell}`)[0];

function statusIndex(statusPage) {
  const table = findTable(parseTables(statusPage), 'API model name');
  return table.rows.map((row) => ({
    id: row['API model name'],
    status: STATUS[row['Current state']],
  }));
}

function resolveModel(name, index) {
  const [, family, major, minor] = requireMatch(name, /^Claude (\w+) (\d+)(?:\.(\d+))?$/, name);
  const version = minor === undefined ? major : `${major}-${minor}`;
  const lower = family.toLowerCase();
  const shapes = [
    new RegExp(`^claude-${lower}-${version}(-\\d{8})?$`),
    new RegExp(`^claude-${version}-${lower}(-\\d{8})?$`),
  ];
  const entry = index.find(({ id }) => shapes.some((shape) => shape.test(id)));
  if (!entry) throw new Error(`anthropic: ${name} has no id on the status page`);
  return entry;
}

function contextTier(cell) {
  const upTo = /for prompts up to ([\d,]+) tokens/.exec(cell);
  if (upTo) return { ContextTierMaxInputTokens: Number(upTo[1].replaceAll(',', '')) };
  const over = /for prompts over ([\d,]+) tokens/.exec(cell);
  return over ? { ContextTierMinInputTokens: Number(over[1].replaceAll(',', '')) } : {};
}

function versionOf(name) {
  const [, major, minor = '0'] = /(\d+)(?:\.(\d+))?$/.exec(name);
  return Number(major) * 100 + Number(minor);
}

const FIRST_US_REGION_VERSION = 406;

// Each row of the cache hit table names one or more models and their multiplier. "All other models"
// restates the default, which must agree with the cache operation table.
function cacheReadMultipliers(table, index, defaultRead) {
  const own = [];
  let others = null;
  for (const row of table.rows) {
    const multiplier = requireMatch(
      row['Cache hit multiplier'],
      /^([\d.]+)x$/,
      `cache hit multiplier of ${row.Model}`,
    )[1];
    if (row.Model === 'All other models') {
      others = multiplier;
      continue;
    }
    const names = row.Model.split(/,? and |, /);
    own.push({ ids: names.map((name) => resolveModel(name.trim(), index).id), multiplier });
  }
  if (others !== defaultRead)
    throw new Error(`anthropic: the cache hit table gives other models ${others}x, the cache read row ${defaultRead}x`);
  return own;
}

// A model the previous release read its own cache read multiplier for, still priced on the page, must still
// have one. Without it, the default multiplier would price its cache reads and nothing would say so.
function requireOwnReads(previous, ownReads, models) {
  const covered = new Set(ownReads.flatMap(({ ids }) => ids));
  const earlier = (previous?.rows ?? []).filter(
    (row) => row.RowType === 'multiplier' && row.ModifierKind === 'prompt_cache' && row.AppliesToModels.length > 0,
  );
  for (const { AppliesToModels } of earlier) {
    for (const id of AppliesToModels.filter((model) => models.has(model) && !covered.has(model)))
      throw new Error(
        `anthropic: ${id} had its own cache read multiplier in ${previous.CatalogVersion} and the page names none`,
      );
  }
}

export function parse(pages, factory, previous) {
  const pricing = pages['anthropic-pricing'];
  const page = pricing.text;
  const tables = parseTables(page);
  const index = statusIndex(pages['anthropic-model-status'].text);
  const rows = [];
  const models = new Map();
  const limited = new Set();

  const describe = (cell) => {
    const name = displayName(cell);
    const entry = resolveModel(name, index);
    if (cell.includes('limited availability')) limited.add(entry.id);
    const identity = {
      ModelId: entry.id,
      ModelName: name,
      ModelStatus: limited.has(entry.id) ? 'limited' : entry.status,
    };
    models.set(entry.id, name);
    return identity;
  };

  const emit = (identity, fields) => {
    for (const [TokenClass, ListUnitPrice] of Object.entries(fields.prices)) {
      if (ListUnitPrice !== null) {
        rows.push(factory.price(pricing, { ...identity, ...fields.tier, TokenClass, ListUnitPrice }));
      }
    }
  };

  for (const row of findTable(tables, 'Base input tokens').rows) {
    emit(describe(row.Model), {
      tier: contextTier(row.Model),
      prices: {
        input_uncached: moneyOf(row['Base input tokens']),
        cache_write_5m: moneyOf(row['5m cache writes']),
        cache_write_1h: moneyOf(row['1h cache writes']),
        cache_read: moneyOf(row['Cache hits and refreshes']),
        output: moneyOf(row['Output tokens']),
      },
    });
  }

  for (const row of findTable(tables, 'Batch input').rows) {
    emit(describe(row.Model), {
      tier: { ...contextTier(row.Model), ServiceTier: 'batch' },
      prices: { input_uncached: moneyOf(row['Batch input']), output: moneyOf(row['Batch output']) },
    });
  }

  const fastSection = sections(page, 3).find(({ heading }) => heading === 'Fast mode pricing');
  for (const row of parseTables(fastSection.body)[0].rows) {
    for (const cell of row.Model.split(' / ')) {
      emit(describe(cell), {
        tier: { ServiceTier: 'fast' },
        prices: { input_uncached: moneyOf(row.Input), output: moneyOf(row.Output) },
      });
    }
  }

  const noChoiceOverhead = [];
  for (const row of findTable(tables, 'Tool use system prompt tokens: auto, none').rows) {
    const { ModelId } = describe(row.Model);
    const counts = {
      auto_none: row['Tool use system prompt tokens: auto, none'],
      any_tool: row['Tool use system prompt tokens: any, tool'],
    };
    for (const [ToolChoice, cell] of Object.entries(counts)) {
      const count = /^(\d+) tokens$/.exec(cell);
      if (count) rows.push(factory.toolOverhead(pricing, { ModelId, ToolChoice, OverheadTokens: Number(count[1]) }));
      else noChoiceOverhead.push(`${ModelId} ${ToolChoice}`);
    }
  }

  const cacheTable = findTable(tables, 'Cache operation');
  const multiplierOf = (operation) => {
    const row = cacheTable.rows.find((candidate) => candidate['Cache operation'] === operation);
    return requireMatch(row?.Multiplier ?? '', /^([\d.]+)x base input price/, operation)[1];
  };
  const defaultRead = multiplierOf('Cache read (hit)');
  rows.push(
    factory.multiplier(pricing, {
      key: 'prompt-cache-write-5m',
      ModifierKind: 'prompt_cache',
      Multiplier: multiplierOf('5-minute cache write'),
      AppliesToTokenClasses: ['cache_write_5m'],
      Condition: 'Multiplies the base input price. Stacks with batch, data residency and fast mode.',
    }),
    factory.multiplier(pricing, {
      key: 'prompt-cache-write-1h',
      ModifierKind: 'prompt_cache',
      Multiplier: multiplierOf('1-hour cache write'),
      AppliesToTokenClasses: ['cache_write_1h'],
      Condition: 'Multiplies the base input price. Stacks with batch, data residency and fast mode.',
    }),
    factory.multiplier(pricing, {
      key: 'prompt-cache-read',
      ModifierKind: 'prompt_cache',
      Multiplier: defaultRead,
      AppliesToTokenClasses: ['cache_read'],
      Condition: 'Multiplies the base input price, except on models a narrower row names.',
    }),
  );
  const ownReads = cacheReadMultipliers(findTable(tables, 'Cache hit multiplier'), index, defaultRead);
  for (const { ids, multiplier } of ownReads) {
    rows.push(
      factory.multiplier(pricing, {
        key: `prompt-cache-read-${ids[0]}`,
        ModifierKind: 'prompt_cache',
        Multiplier: multiplier,
        AppliesToModels: ids,
        AppliesToTokenClasses: ['cache_read'],
        Condition: 'Multiplies the base input price. Stacks with batch, data residency and fast mode.',
      }),
    );
  }
  requireOwnReads(previous, ownReads, models);

  requireMatch(page, /50 percent discount on both input and output tokens/, 'batch discount');
  rows.push(
    factory.multiplier(pricing, {
      key: 'batch',
      ModifierKind: 'batch',
      Multiplier: '0.5',
      AppliesToTokenClasses: TOKEN_CLASSES,
      Condition: 'Stacks with prompt caching. Not available with fast mode.',
    }),
  );

  const residency = requireMatch(
    page,
    /For Claude 4\.6 and later models, specifying US-only inference through the `inference_geo` parameter incurs a ([\d.]+)x multiplier/,
    'data residency multiplier',
  )[1];
  rows.push(
    factory.multiplier(pricing, {
      key: 'data-residency-us',
      ModifierKind: 'data_residency',
      RegionId: 'us',
      Multiplier: residency,
      AppliesToModels: [...models].filter(([, name]) => versionOf(name) >= FIRST_US_REGION_VERSION).map(([id]) => id),
      AppliesToTokenClasses: TOKEN_CLASSES,
      Condition:
        'inference_geo set to "us" on the Claude API, Claude Platform on AWS and Claude Models on Google Cloud (Anthropic managed), or a US Data Zone Standard deployment on Microsoft Foundry. Stacks with fast mode.',
    }),
  );

  rows.push(
    factory.fee(pricing, {
      key: 'web-search',
      FeeName: 'web_search',
      ListUnitPrice: requireMatch(page, /\*\*\$(\d+) USD per 1,000 searches\*\*/, 'web search fee')[1],
      PricingUnit: '1000 Requests',
      Condition: 'Plus standard token costs for search-generated content.',
    }),
    factory.fee(pricing, {
      key: 'code-execution',
      FeeName: 'code_execution',
      ListUnitPrice: requireMatch(page, /\*\*\$([\d.]+) USD per hour, per container\*\*/, 'code execution fee')[1],
      PricingUnit: 'Container-Hours',
      Condition: 'Beyond 1,550 free hours per organization per month; free with web search or web fetch.',
    }),
    factory.fee(pricing, {
      key: 'managed-agents-session',
      FeeName: 'managed_agents_session_runtime',
      ListUnitPrice: requireMatch(
        page,
        /\| Session runtime \| \$([\d.]+) USD per session-hour/,
        'session runtime fee',
      )[1],
      PricingUnit: 'Session-Hours',
      Condition: 'While the session status is running.',
    }),
    factory.creditRate(pricing, {
      key: 'ccu',
      CreditName: 'Claude Consumption Unit',
      ListUnitPrice: requireMatch(page, /converted to CCUs at \$([\d.]+) USD per CCU/, 'CCU rate')[1],
      Condition: 'Claude Platform on AWS and Claude in Microsoft Foundry.',
    }),
  );

  const thinking = pages['anthropic-thinking'];
  requireMatch(thinking.text, /the tokens Claude spends reasoning are billed as output tokens/, 'thinking billing');
  rows.push(factory.reasoning(thinking, { key: 'thinking' }));

  const statusOnly = index.filter(({ id, status }) => !models.has(id) && status !== 'retired').map(({ id }) => id);
  return {
    rows,
    omissions: [
      ...statusOnly.map((id) => ({ item: id, reason: 'On the model status page with no row on the pricing page.' })),
      ...noChoiceOverhead.map((item) => ({
        item: `tool overhead ${item}`,
        reason: 'The cell is blank on the pricing page.',
      })),
      {
        item: 'Batch, fast-mode and US-residency cache prices',
        reason: 'Published as stacking multipliers, not as prices. The multiplier rows carry them.',
      },
      { item: 'US-residency token prices', reason: 'Published as a multiplier, not as prices.' },
      {
        item: 'Amazon Bedrock and Claude Models on Google Cloud (Google managed) prices',
        reason: 'The pricing page points to the cloud providers. Not read for this release.',
      },
      {
        item: 'Tokenizer version',
        reason: 'The page says Claude 4.7 and later use a newer tokenizer and names no version.',
      },
      {
        item: 'Per-tool token overhead (bash, text editor, computer use, browser use)',
        reason: 'Not modelled in schema 0.1. Only the per-model tool system prompt is.',
      },
    ],
  };
}
