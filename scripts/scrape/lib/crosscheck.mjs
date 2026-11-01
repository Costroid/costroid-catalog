import { NOTES } from '../crosscheck-notes.mjs';
import { compareDecimals, perTokenToPerMillion } from './decimal.mjs';

const FIRST_PARTY = new Set(['anthropic', 'openai', 'google']);
const LITELLM_ATTRIBUTE = {
  input_uncached: 'input_cost_per_token',
  output: 'output_cost_per_token',
  cache_read: 'cache_read_input_token_cost',
  cache_write_5m: 'cache_creation_input_token_cost',
  cache_write_30m: 'cache_creation_input_token_cost',
  cache_write_1h: 'cache_creation_input_token_cost_above_1hr',
  cache_write_12h: 'cache_creation_input_token_cost_above_12hr',
};
const LITELLM_TIER = {
  standard: '',
  batch: '_batches',
  flex: '_flex',
  fast: '_priority',
  priority: '_priority',
  ultrafast: '_ultrafast',
};
const OPENROUTER_ATTRIBUTE = {
  input_uncached: 'prompt',
  output: 'completion',
  cache_read: 'input_cache_read',
  cache_write_5m: 'input_cache_write',
  cache_write_30m: 'input_cache_write',
  cache_write_1h: 'input_cache_write_1h',
};

const inForce = (row, sheetDate) =>
  row.EffectiveStart <= sheetDate && (row.EffectiveEnd === null || row.EffectiveEnd > sheetDate);

function pricedRows(sheets) {
  return sheets
    .filter(({ Provider }) => FIRST_PARTY.has(Provider))
    .flatMap((sheet) =>
      sheet.rows
        .filter(
          (row) =>
            row.RowType === 'unit_price' && row.PricingUnit === '1000000 Tokens' && inForce(row, sheet.SheetDate),
        )
        .map((row) => ({ provider: sheet.Provider, row })),
    );
}

function litellmEntry(map, provider, row) {
  if (provider === 'google') return map[`gemini/${row.ModelId}`];
  return map[row.ModelId] ?? map[row.ModelId.replace(/-\d{8}$/, '')];
}

function litellmValue(entry, row) {
  const attribute = LITELLM_ATTRIBUTE[row.TokenClass];
  const suffix = LITELLM_TIER[row.ServiceTier];
  if (attribute === undefined || suffix === undefined) return undefined;
  const context =
    row.ContextTierMinInputTokens === null ? '' : `_above_${row.ContextTierMinInputTokens / 1000}k_tokens`;
  return entry[`${attribute}${context}${suffix}`];
}

const openrouterId = (provider, row) => {
  const name = provider === 'anthropic' ? row.ModelName.toLowerCase().replaceAll(' ', '-') : row.ModelId;
  const publisher = provider === 'google' ? 'google' : provider;
  return `${publisher}/${name}${row.ServiceTier === 'batch' ? ':batch' : ''}`;
};

function openrouterValue(entry, row) {
  const attribute = OPENROUTER_ATTRIBUTE[row.TokenClass];
  if (attribute === undefined) return undefined;
  if (row.ContextTierMinInputTokens === null) return entry.pricing[attribute];
  const override = entry.pricing.overrides?.find(({ min_prompt_tokens: min }) => min === row.ContextTierMinInputTokens);
  return override?.[attribute];
}

function compareAll(entries, find, valueOf, nameOf) {
  const tally = new Map();
  const disagreements = [];
  const absentModels = new Set();
  for (const { provider, row } of entries) {
    const count = tally.get(provider) ?? { rows: 0, compared: 0, agreed: 0, noField: 0, noModel: 0 };
    tally.set(provider, count);
    count.rows += 1;
    const entry = find(provider, row);
    if (!entry) {
      count.noModel += 1;
      absentModels.add(nameOf(provider, row));
      continue;
    }
    const value = valueOf(entry, row);
    if (value === undefined || value === null) {
      count.noField += 1;
      continue;
    }
    const theirs = perTokenToPerMillion(value);
    count.compared += 1;
    if (compareDecimals(row.ListUnitPrice, theirs) === 0) count.agreed += 1;
    else disagreements.push({ id: row.SkuPriceId, ours: row.ListUnitPrice, theirs });
  }
  return { tally, disagreements, absentModels };
}

const reseller = (name) => {
  const reordered = /^claude (\d[\d.]*) (\w+)$/.exec(name.toLowerCase());
  return reordered ? `claude ${reordered[2]} ${reordered[1]}` : name.toLowerCase();
};

const firstPartyKey = (row) => reseller(row.ModelName);
const sameClass = (ours, theirs) =>
  ours === theirs ||
  (ours === 'cache_write_unspecified' && (theirs === 'cache_write_5m' || theirs === 'cache_write_30m'));
const longContext = (row) => row.ContextTierMinInputTokens !== null;

function compareResellers(sheets) {
  const firstParty = pricedRows(sheets).map(({ row }) => row);
  const byModel = new Map();
  for (const row of firstParty) {
    for (const key of new Set([firstPartyKey(row), row.ModelId])) {
      byModel.set(key, [...(byModel.get(key) ?? []), row]);
    }
  }
  const rows = [];
  const thresholds = new Map();
  const unmatched = new Map();
  let compared = 0;
  for (const sheet of sheets.filter(({ Provider }) => !FIRST_PARTY.has(Provider))) {
    for (const row of sheet.rows.filter(
      (candidate) => candidate.RowType === 'unit_price' && inForce(candidate, sheet.SheetDate),
    )) {
      const candidates = byModel.get(reseller(row.ModelName)) ?? byModel.get(row.ModelId);
      if (!candidates) {
        const models = unmatched.get(sheet.Provider) ?? new Set();
        unmatched.set(sheet.Provider, models.add(`${row.ModelName} (${row.ModelPublisher})`));
        continue;
      }
      const match = candidates.find(
        (other) =>
          sameClass(row.TokenClass, other.TokenClass) &&
          other.ServiceTier === row.ServiceTier &&
          longContext(other) === longContext(row),
      );
      if (!match) continue;
      compared += 1;
      if (compareDecimals(row.ListUnitPrice, match.ListUnitPrice) !== 0) {
        rows.push({
          sheet: sheet.Provider,
          id: row.SkuPriceId,
          ours: row.ListUnitPrice,
          firstParty: match.ListUnitPrice,
          against: match.SkuPriceId,
        });
      }
      const key = row.ContextTierMaxInputTokens ?? row.ContextTierMinInputTokens;
      const other = match.ContextTierMaxInputTokens ?? match.ContextTierMinInputTokens;
      if (key !== null && other !== null && key !== other) {
        thresholds.set(`${sheet.Provider} ${row.ModelName}`, { reseller: key, firstParty: other });
      }
    }
  }
  return { compared, rows, thresholds, unmatched };
}

function unlistedOnOpenRouter(sheets, listing) {
  const known = new Set(
    pricedRows(sheets).map(({ provider, row }) => openrouterId(provider, { ...row, ServiceTier: 'standard' })),
  );
  const prefixes = ['anthropic/', 'openai/', 'google/'];
  return listing
    .map(({ id }) => id)
    .filter((id) => prefixes.some((prefix) => id.startsWith(prefix)) && !id.includes(':') && !known.has(id));
}

function table(header, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map((cell) => '-'.repeat(cell.length))), ...rows.map(line)];
}

function sourceSection(title, source, { tally, disagreements, absentModels }) {
  const summary = [...tally].map(([provider, c]) => [
    provider,
    c.rows,
    c.compared,
    c.agreed,
    c.compared - c.agreed,
    c.noField,
    c.noModel,
  ]);
  return [
    `## ${title}`,
    '',
    `Snapshot: ${source.url}, retrieved ${source.retrievedAt}, SHA-256 \`${source.sha256}\`.`,
    '',
    ...table(['Sheet', 'Rows in force', 'Compared', 'Agree', 'Disagree', 'No such field', 'No such model'], summary),
    '',
    ...(disagreements.length === 0
      ? ['No compared row disagrees.', '']
      : [
          '### Disagreements',
          '',
          ...table(
            ['SkuPriceId', 'Sheet (USD per 1M tokens)', title, 'Reading'],
            disagreements.map(({ id, ours, theirs }) => [`\`${id}\``, ours, theirs, NOTES[id] ?? 'Unread.']),
          ),
          '',
        ]),
    ...(absentModels.size === 0
      ? []
      : [
          `Models with no entry: ${[...absentModels]
            .sort()
            .map((id) => `\`${id}\``)
            .join(', ')}.`,
          '',
        ]),
  ];
}

export function buildCrosscheck({ sheets, litellm, openrouter, sources, version }) {
  const entries = pricedRows(sheets);
  const lite = compareAll(
    entries,
    (provider, row) => litellmEntry(litellm, provider, row),
    litellmValue,
    (provider, row) => `${provider}/${row.ModelId}`,
  );
  const listing = new Map(openrouter.data.map((entry) => [entry.id, entry]));
  const router = compareAll(
    entries.filter(({ row }) => ['standard', 'batch'].includes(row.ServiceTier)),
    (provider, row) => listing.get(openrouterId(provider, row)),
    openrouterValue,
    openrouterId,
  );
  const resold = compareResellers(sheets);
  const unlisted = unlistedOnOpenRouter(sheets, openrouter.data);
  const source = (id) => sources.find((candidate) => candidate.id === id);

  const lines = [
    `# Catalog ${version}: cross-check against LiteLLM and OpenRouter`,
    '',
    "Every sheet price comes from the provider's own page. The LiteLLM map and the OpenRouter listing are compared with the sheets and never feed them. A disagreement is a finding to read against the provider page; the sheet does not move because of it.",
    '',
    'The comparison covers Anthropic, OpenAI and Google rows in force on the sheet date, exact to the digit after both sides are expressed in USD per 1,000,000 tokens. "No such field" means the source has the model and no value for that tier, context or token class. OpenRouter is compared on the standard and batch tiers only, because its listing has no field for the others.',
    '',
    ...sourceSection('LiteLLM', source('litellm-map'), lite),
    ...sourceSection('OpenRouter', source('openrouter-listing'), router),
    '## Resellers against first-party sheets',
    '',
    `Copilot and Cursor state per-token rates. Those were compared with the first-party sheets on the same tier, for ${resold.compared} rows. Tier thresholds are compared separately because the same model can bill long context from a different token count.`,
    '',
    ...(resold.rows.length === 0
      ? ['No compared rate disagrees.', '']
      : [
          ...table(
            ['SkuPriceId', 'Reseller rate', 'First-party rate', 'Reading'],
            resold.rows.map(({ id, ours, firstParty }) => [`\`${id}\``, ours, firstParty, NOTES[id] ?? 'Unread.']),
          ),
          '',
        ]),
    ...(resold.thresholds.size === 0
      ? []
      : [
          '### Long-context thresholds that differ',
          '',
          ...table(
            ['Model', 'Reseller (input tokens)', 'First-party (input tokens)'],
            [...resold.thresholds].map(([model, { reseller: theirs, firstParty }]) => [model, theirs, firstParty]),
          ),
          '',
        ]),
    ...[...resold.unmatched].flatMap(([sheet, models]) => [
      `${sheet} models with no first-party row on these sheets: ${[...models].sort().join(', ')}.`,
      '',
    ]),
    '## Listed by OpenRouter, absent from the provider sheets',
    '',
    `${unlisted.length} OpenRouter ids under \`anthropic/\`, \`openai/\` and \`google/\` match no row. Image, audio, open-weight and dated snapshot ids are among them, and so are the \`-pro\` variants and Gemini 3.5 and 3.7 Flash, which the provider pages do not list. None gets a row from this listing: ${unlisted.map((id) => `\`${id}\``).join(', ')}.`,
    '',
  ];
  return { markdown: lines.join('\n'), lite, router, resold, unlisted };
}
