import { fallbackRows } from '../lib/rows.mjs';
import { dayAfter, isoDate, moneyOf, parseTables, requireMatch, sections, stripMarkup } from '../lib/markdown.mjs';

export const META = { sheet: 'github-copilot', serviceProviderName: 'GitHub' };

const CACHE_WRITE = 'cache_write_unspecified';
const NOT_TOKEN_TABLES = new Set(['Image generation models']);
export const slug = (name) => name.toLowerCase().replaceAll(' ', '-');

function thresholdOf(cell) {
  const under = /^≤ (\d+)K$/.exec(cell);
  if (under) return { ContextTierMaxInputTokens: Number(under[1]) * 1000 };
  const over = /^> (\d+)K$/.exec(cell);
  if (over) return { ContextTierMinInputTokens: Number(over[1]) * 1000 };
  if (cell === 'Not applicable' || cell === undefined) return {};
  throw new Error(`copilot: unreadable threshold ${JSON.stringify(cell)}`);
}

function promotionEnds(page) {
  const ends = new Map();
  for (const [, id, sentence] of page.matchAll(/^\[\^([\w-]+)\]: (.*)$/gm)) {
    const through = /through ([A-Z][a-z]+ \d+, \d{4})\.$/.exec(sentence);
    const until = /until ([A-Z][a-z]+ \d+, \d{4})\.$/.exec(sentence);
    if (through) ends.set(id, dayAfter(isoDate(through[1])));
    else if (until) ends.set(id, isoDate(until[1]));
    else throw new Error(`copilot: unread footnote ${id}`);
  }
  return ends;
}

export function parse(pages, factory) {
  const pricing = pages['github-copilot-pricing'];
  const page = pricing.text;
  const ends = promotionEnds(page);
  const rows = [];
  const promoted = [];

  const tablesBlock = sections(page, 2).find(({ heading }) => heading === 'Pricing tables').body;
  for (const { heading, body } of sections(tablesBlock, 3)) {
    if (NOT_TOKEN_TABLES.has(heading)) continue;
    for (const table of parseTables(body)) {
      for (const row of table.rows) {
        const footnote = /\[\^([\w-]+)\]/.exec(row.Model)?.[1];
        const clean = stripMarkup(row.Model);
        const fast = clean.includes('(fast mode)');
        const ModelName = clean.replace(/ \(.*$/, '');
        const end = footnote ? ends.get(footnote) : undefined;
        if (end) promoted.push(ModelName);
        const identity = {
          ModelId: slug(ModelName),
          ModelName,
          ModelIdBasis: 'display_name_slug',
          ModelPublisher: heading,
          ModelStatus: row['Release status'] === 'GA' ? 'active' : 'preview',
          ServiceTier: fast ? 'fast' : 'standard',
          ...thresholdOf(row['Threshold (input tokens)']),
          ...(end ? { EffectiveEnd: end, Note: 'Promotional price. The page states no price after it ends.' } : {}),
        };
        const prices = {
          input_uncached: moneyOf(row.Input),
          cache_read: moneyOf(row['Cached input']),
          [CACHE_WRITE]: row['Cache write'] === undefined ? null : moneyOf(row['Cache write']),
          output: moneyOf(row.Output),
        };
        for (const [TokenClass, ListUnitPrice] of Object.entries(prices)) {
          if (ListUnitPrice !== null) rows.push(factory.price(pricing, { ...identity, TokenClass, ListUnitPrice }));
        }
      }
    }
  }

  rows.push(
    factory.creditRate(pricing, {
      key: 'ai-credit',
      CreditName: 'GitHub AI Credit',
      ListUnitPrice: requireMatch(page, /1 AI credit = \$([\d.]+) USD/, 'AI credit rate')[1],
      Condition: 'Usage beyond a plan’s included allowance, billed at the per-token rates on this sheet.',
    }),
  );

  const multipliers = pages['github-copilot-legacy-multipliers'];
  const table = parseTables(multipliers.text).find(({ header }) => header.includes('Multiplier'));
  for (const row of table.rows) {
    rows.push(
      factory.requestMultiplier(multipliers, {
        ModelId: slug(row.Model),
        ModelName: row.Model,
        Multiplier: row.Multiplier,
        Condition: 'Copilot Pro and Copilot Pro+ annual plans on request-based billing.',
      }),
    );
  }

  const requests = pages['github-copilot-legacy-requests'];
  rows.push(
    factory.fee(requests, {
      key: 'premium-request',
      FeeName: 'premium_request',
      ListUnitPrice: requireMatch(
        requests.text,
        /Purchase additional premium requests at \$([\d.]+)\/request/,
        'premium request price',
      )[1],
      PricingUnit: 'Requests',
      Condition: 'Request-based billing (legacy).',
    }),
  );

  rows.push(
    ...fallbackRows(factory, pricing, rows, {
      inScope: () => true,
      basis: 'Highest default-tier list price per token class across every token model on the page.',
    }),
  );

  return {
    rows,
    omissions: [
      ...[...new Set(promoted)].map((name) => ({
        item: `${name} after its promotion`,
        reason: 'The page states the promotional price and no later price.',
      })),
      {
        item: 'cache_write_5m and cache_write_1h',
        reason: 'The page publishes one "Cache write" column with no duration. Rows carry cache_write_unspecified.',
      },
      { item: 'Batch, data-residency and reasoning rows', reason: 'Not on the page.' },
      { item: 'GPT Image 2.5 Flare', reason: 'On the page, outside the text-token scope of release 0.1.' },
      { item: 'Copilot code review per-review figures', reason: 'The page calls them estimates, not prices.' },
    ],
  };
}
