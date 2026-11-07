import { compareDecimals } from '../lib/decimal.mjs';
import { moneyOf, parseTables, requireMatch, stripMarkup } from '../lib/markdown.mjs';
import { slug } from './copilot.mjs';

export const META = { sheet: 'cursor', serviceProviderName: 'Cursor' };

const CACHE_WRITE = 'cache_write_unspecified';

function readModel(cell, notes) {
  let name = stripMarkup(cell);
  const fast = /(?: \(Fast\)| \(fast mode\)| Fast)$/.exec(name);
  if (fast) name = name.slice(0, fast.index);
  const tier = fast ? { ServiceTier: 'fast' } : {};
  const windowed = / (500k|1M)$/.exec(name);
  if (!windowed) return { name, tier };
  name = name.slice(0, windowed.index);
  if (windowed[1] === '500k') {
    const [, from, to] = requireMatch(
      notes,
      /Long context \(>(\d+)k input tokens\).*?up to (\d+)k/,
      'long context note',
    );
    return {
      name,
      tier: { ...tier, ContextTierMinInputTokens: Number(from) * 1000, ContextTierMaxInputTokens: Number(to) * 1000 },
    };
  }
  const [, from] = requireMatch(notes, /exceeds (\d+)k tokens/, 'long context note');
  return { name, tier: { ...tier, ContextTierMinInputTokens: Number(from) * 1000 } };
}

// The page states the exemption as a rule, not a list: every cache-read price of the model below the threshold.
function exemptModels(rows, below) {
  const cacheReads = new Map();
  for (const row of rows) {
    if (row.ModelPublisher === 'Cursor' || row.TokenClass !== 'cache_read') continue;
    cacheReads.set(row.ModelId, [...(cacheReads.get(row.ModelId) ?? []), row.ListUnitPrice]);
  }
  return [...cacheReads]
    .filter(([, prices]) => prices.every((price) => compareDecimals(price, below) < 0))
    .map(([ModelId]) => ModelId);
}

export function parse(pages, factory) {
  const pricing = pages['cursor-pricing'];
  const page = pricing.text;
  const tables = parseTables(page).filter(({ header }) => header.includes('US data residency'));
  if (tables.length !== 2) throw new Error(`cursor: expected two model tables, found ${tables.length}`);
  const usEligible = new Set();
  const entries = [];

  for (const table of tables) {
    for (const row of table.rows) {
      const { name, tier } = readModel(row.Model, row.Notes);
      const identity = {
        ModelId: slug(name),
        ModelName: name,
        ModelIdBasis: 'display_name_slug',
        ModelPublisher: row.Provider,
        ...tier,
      };
      if (row['US data residency'] === 'Yes') usEligible.add(identity.ModelId);
      const prices = {
        input_uncached: moneyOf(row.Input),
        [CACHE_WRITE]: moneyOf(row['Cache write']),
        cache_read: moneyOf(row['Cache read']),
        output: moneyOf(row.Output),
      };
      entries.push({ identity, prices });
    }
  }

  // A model with a long-context row prices its plain row up to where the long context starts.
  const tierKey = ({ ModelId, ServiceTier = 'standard' }) => `${ModelId}:${ServiceTier}`;
  const longFrom = new Map(
    entries
      .filter(({ identity }) => identity.ContextTierMinInputTokens !== undefined)
      .map(({ identity }) => [tierKey(identity), identity.ContextTierMinInputTokens]),
  );
  const rows = entries.flatMap(({ identity, prices }) => {
    const bounded =
      identity.ContextTierMinInputTokens === undefined && longFrom.has(tierKey(identity))
        ? { ...identity, ContextTierMaxInputTokens: longFrom.get(tierKey(identity)) }
        : identity;
    return Object.entries(prices)
      .filter(([, ListUnitPrice]) => ListUnitPrice !== null)
      .map(([TokenClass, ListUnitPrice]) => factory.price(pricing, { ...bounded, TokenClass, ListUnitPrice }));
  });

  requireMatch(
    page,
    /Opting in to regional data residency incurs a 10% uplift on Model pricing for eligible Models\./,
    'data residency uplift',
  );
  rows.push(
    factory.multiplier(pricing, {
      key: 'data-residency-us',
      ModifierKind: 'data_residency',
      RegionId: 'us',
      Multiplier: '1.1',
      AppliesToModels: [...usEligible],
      Condition: 'Models whose row says US data residency: Yes.',
    }),
  );

  requireMatch(page, /billed at the model's API rate plus 20%/, 'Max Mode rate');
  rows.push(
    factory.multiplier(pricing, {
      key: 'max-mode',
      ModifierKind: 'max_mode',
      Multiplier: '1.2',
      Condition: 'Max Mode on legacy request-based plans.',
    }),
  );

  const exemptBelow = requireMatch(
    page,
    /The Cursor Token Rate also does not apply to third-party models whose cache-read price is strictly below \$([\d.]+) per million tokens across every pricing tier\./,
    'Cursor Token Rate exemption',
  )[1];
  rows.push(
    factory.additiveRate(pricing, {
      key: 'cursor-token-rate',
      RateName: 'Cursor Token Rate',
      ListUnitPrice: requireMatch(page, /a Cursor Token Rate of \$([\d.]+) per million tokens/, 'Cursor Token Rate')[1],
      ExcludedModels: exemptModels(rows, exemptBelow),
      Condition: `Teams and Enterprise plans, on eligible third-party models, for input, output and cached tokens, including with your own API key. Never on Cursor models or Cost mode requests. ExcludedModels are the third-party models whose cache read is below USD ${exemptBelow} per 1M tokens on every row, as the page's rule states.`,
    }),
  );

  return {
    rows,
    omissions: [
      { item: 'Credit rate', reason: 'The page sells prepaid credit at model rates and states no unit conversion.' },
      {
        item: 'Weekly pool draw-down rates',
        reason: 'The page says models draw at different rates and publishes none.',
      },
      {
        item: 'cache_write_5m and cache_write_1h',
        reason: 'The page publishes one "Cache write" column with no duration. Rows carry cache_write_unspecified.',
      },
      { item: 'Batch and reasoning rows', reason: 'Not on the page.' },
      {
        item: 'Per-model long-context prices stated only in notes',
        reason: 'Row notes state multipliers in prose. Only rows with their own figures are carried.',
      },
    ],
  };
}
