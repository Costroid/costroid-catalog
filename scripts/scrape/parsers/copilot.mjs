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

const DATE = '([A-Z][a-z]+ \\d+, \\d{4})';
const PROMOTION_END = new RegExp(`(through|until) ${DATE}\\.$`);
const NEXT_PRICE = new RegExp(
  `^Starting ${DATE}, pricing is \\$([\\d.]+) per 1M input tokens, \\$([\\d.]+) per 1M cached input tokens, and \\$([\\d.]+) per 1M output tokens\\.$`,
);

// A footnote's first sentence ends the promotion on a date. A second sentence may state the price from a later date.
function readFootnote(id, text) {
  const [first, ...rest] = text.split(/(?<=\.) (?=[A-Z])/);
  const ending = PROMOTION_END.exec(first);
  if (!ending) throw new Error(`copilot: unread footnote ${id}`);
  const end = ending[1] === 'through' ? dayAfter(isoDate(ending[2])) : isoDate(ending[2]);
  if (rest.length === 0) return { end, next: null };
  const next = NEXT_PRICE.exec(rest.join(' '));
  if (!next) throw new Error(`copilot: unread sentence after the date in footnote ${id}`);
  const start = isoDate(next[1]);
  if (start !== end)
    throw new Error(`copilot: footnote ${id} ends its promotion on ${end} and states a price from ${start}`);
  return { end, next: { start, prices: { input_uncached: next[2], cache_read: next[3], output: next[4] } } };
}

function promotions(page) {
  const found = new Map();
  for (const [, id, text] of page.matchAll(/^\[\^([\w-]+)\]: (.*)$/gm)) found.set(id, readFootnote(id, text));
  return found;
}

export const PROMOTION_NOTE = {
  ending: 'Promotional price. The page states no price after it ends.',
  followed: 'Promotional price. The page states the price that follows it.',
};

export function parse(pages, factory) {
  const pricing = pages['github-copilot-pricing'];
  const page = pricing.text;
  const footnotes = promotions(page);
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
        const promotion = footnote ? footnotes.get(footnote) : undefined;
        if (promotion && !promotion.next) promoted.push(ModelName);
        const identity = {
          ModelId: slug(ModelName),
          ModelName,
          ModelIdBasis: 'display_name_slug',
          ModelPublisher: heading,
          ModelStatus: row['Release status'] === 'GA' ? 'active' : 'preview',
          ServiceTier: fast ? 'fast' : 'standard',
          ...thresholdOf(row['Threshold (input tokens)']),
        };
        const ending = promotion
          ? { EffectiveEnd: promotion.end, Note: PROMOTION_NOTE[promotion.next ? 'followed' : 'ending'] }
          : {};
        const prices = {
          input_uncached: moneyOf(row.Input),
          cache_read: moneyOf(row['Cached input']),
          [CACHE_WRITE]: row['Cache write'] === undefined ? null : moneyOf(row['Cache write']),
          output: moneyOf(row.Output),
        };
        for (const [TokenClass, ListUnitPrice] of Object.entries(prices)) {
          if (ListUnitPrice !== null)
            rows.push(factory.price(pricing, { ...identity, ...ending, TokenClass, ListUnitPrice }));
        }
        const next = promotion?.next;
        for (const [TokenClass, ListUnitPrice] of Object.entries(next?.prices ?? {})) {
          rows.push(factory.price(pricing, { ...identity, EffectiveStart: next.start, TokenClass, ListUnitPrice }));
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
      { item: 'GPT Image 2.5 Flare', reason: 'On the page, outside the text-token scope of the catalog.' },
      { item: 'Copilot code review per-review figures', reason: 'The page calls them estimates, not prices.' },
    ],
  };
}
