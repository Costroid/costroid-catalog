import { maxDecimal } from './decimal.mjs';

export const TOKENS = '1000000 Tokens';
export const CURRENCY = 'USD';

const provenance = (source) => ({
  SourceUrl: source.url,
  RetrievalDate: source.retrievedAt.slice(0, 10),
  SourceSha256: source.sha256,
});

const contextKey = ({ ContextTierMinInputTokens: min = null, ContextTierMaxInputTokens: max = null }) => {
  if (min === null && max === null) return 'all';
  if (min === null) return `to-${max}`;
  return max === null ? `over-${min}` : `over-${min}-to-${max}`;
};

export function makeRowFactory({ provider, serviceProviderName, sheetDate }) {
  const base = (fields) => ({
    ServiceProviderName: serviceProviderName,
    EffectiveStart: sheetDate,
    EffectiveEnd: null,
    ...fields,
  });
  const dated = (start) => (start === sheetDate ? '' : `:from-${start}`);

  return {
    price(source, fields) {
      const row = base({
        ModelIdBasis: 'provider_id',
        ModelStatus: 'unstated',
        RegionId: 'global',
        ServiceTier: 'standard',
        ContextTierMinInputTokens: null,
        ContextTierMaxInputTokens: null,
        PricingUnit: TOKENS,
        PricingCurrency: CURRENCY,
        ...fields,
      });
      const key = [provider, row.ModelId, row.RegionId, row.ServiceTier, contextKey(row), row.TokenClass].join(':');
      return {
        RowType: 'unit_price',
        SkuPriceId: `${key}${dated(row.EffectiveStart)}`,
        ...row,
        ...provenance(source),
      };
    },
    multiplier(source, fields) {
      return {
        RowType: 'multiplier',
        SkuPriceId: `${provider}:multiplier:${fields.key}`,
        ...base({ AppliesToModels: [], AppliesToTokenClasses: [], Condition: null }),
        ...withoutKey(fields),
        ...provenance(source),
      };
    },
    additiveRate(source, fields) {
      return {
        RowType: 'additive_rate',
        SkuPriceId: `${provider}:additive:${fields.key}`,
        ...base({ PricingUnit: TOKENS, PricingCurrency: CURRENCY }),
        ...withoutKey(fields),
        ...provenance(source),
      };
    },
    fee(source, fields) {
      return {
        RowType: 'fee',
        SkuPriceId: `${provider}:fee:${fields.key}`,
        ...base({ PricingCurrency: CURRENCY }),
        ...withoutKey(fields),
        ...provenance(source),
      };
    },
    creditRate(source, fields) {
      return {
        RowType: 'credit_rate',
        SkuPriceId: `${provider}:credit:${fields.key}`,
        ...base({ PricingUnit: 'Credits', PricingCurrency: CURRENCY }),
        ...withoutKey(fields),
        ...provenance(source),
      };
    },
    requestMultiplier(source, fields) {
      return {
        RowType: 'request_multiplier',
        SkuPriceId: `${provider}:request-multiplier:${fields.ModelId}`,
        ...base(fields),
        ...provenance(source),
      };
    },
    toolOverhead(source, fields) {
      return {
        RowType: 'tool_overhead',
        SkuPriceId: `${provider}:tool-overhead:${fields.ModelId}:${fields.ToolChoice}`,
        ...base(fields),
        ...provenance(source),
      };
    },
    reasoning(source, fields) {
      return {
        RowType: 'reasoning',
        SkuPriceId: `${provider}:reasoning:${fields.key}`,
        ...base({ AppliesToModels: [], ReasoningBilledAs: 'output' }),
        ...withoutKey(fields),
        ...provenance(source),
      };
    },
    fallback(source, fields) {
      return {
        RowType: 'fallback',
        SkuPriceId: `${provider}:fallback:${fields.TokenClass}`,
        ...base({ ModelId: '*', PricingUnit: TOKENS, PricingCurrency: CURRENCY }),
        ...fields,
        ...provenance(source),
      };
    },
  };
}

function withoutKey({ key, ...rest }) {
  return rest;
}

// The unknown-model tier: for each token class, the highest list price among the rows `inScope` selects.
// A scheduled rise counts, so a sheet pinned past its date never prices an unknown model below the known ones.
export function fallbackRows(factory, source, rows, { inScope, basis }) {
  const eligible = rows.filter(
    (row) =>
      row.RowType === 'unit_price' &&
      row.ServiceTier === 'standard' &&
      row.RegionId === 'global' &&
      row.ContextTierMinInputTokens === null &&
      row.PricingUnit === TOKENS &&
      row.ModelStatus !== 'retired' &&
      inScope(row),
  );
  const classes = [...new Set(eligible.map((row) => row.TokenClass))].sort();
  if (classes.length === 0) throw new Error('fallback scope selected no rows');
  return classes.map((TokenClass) =>
    factory.fallback(source, {
      TokenClass,
      ListUnitPrice: maxDecimal(
        eligible.filter((row) => row.TokenClass === TokenClass).map((row) => row.ListUnitPrice),
      ),
      FallbackBasis: basis,
    }),
  );
}
