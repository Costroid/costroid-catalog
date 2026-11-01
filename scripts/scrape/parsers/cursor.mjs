import { fallbackRows } from '../lib/rows.mjs';
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

export function parse(pages, factory) {
  const pricing = pages['cursor-pricing'];
  const page = pricing.text;
  const tables = parseTables(page).filter(({ header }) => header.includes('US data residency'));
  if (tables.length !== 2) throw new Error(`cursor: expected two model tables, found ${tables.length}`);
  const rows = [];
  const usEligible = new Set();

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
      for (const [TokenClass, ListUnitPrice] of Object.entries(prices)) {
        if (ListUnitPrice !== null) rows.push(factory.price(pricing, { ...identity, TokenClass, ListUnitPrice }));
      }
    }
  }

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

  const excludedBlock = requireMatch(
    page,
    /These models are excluded from the Cursor Token Rate:\n\n((?:- .+\n)+)/,
    'Cursor Token Rate exclusions',
  )[1];
  rows.push(
    factory.additiveRate(pricing, {
      key: 'cursor-token-rate',
      RateName: 'Cursor Token Rate',
      ListUnitPrice: requireMatch(page, /a Cursor Token Rate of \$([\d.]+) per million tokens/, 'Cursor Token Rate')[1],
      ExcludedModels: excludedBlock
        .trim()
        .split('\n')
        .map((line) => slug(line.slice(2))),
      Condition:
        'Teams and Enterprise plans, on eligible third-party models, for input, output and cached tokens. Never on Cursor models or Cost mode requests.',
    }),
  );

  rows.push(
    ...fallbackRows(factory, pricing, rows, {
      inScope: () => true,
      basis:
        'Highest list price per token class across both model tables on the page, Fast and extended-context rows left out.',
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
