import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { compareDecimals } from './scrape/lib/decimal.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHEETS = join(ROOT, 'sheets');
const REPORTS = join(ROOT, 'reports');
const TESTDATA = join(ROOT, 'scripts', 'scrape', 'testdata');
const TOKENS = '1000000 Tokens';
// Release 0.1.0 was published before the fallback had to bound every row. A published release never changes.
const PRICE_RULES_FROM = [0, 2, 0];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// SOURCES.json holds the pages fetched last; reports/<version>-sources.json holds the pages each release was built from.
function sourceRecords() {
  const releaseRecords = readdirSync(REPORTS)
    .filter((name) => name.endsWith('-sources.json'))
    .map((name) => readJson(join(REPORTS, name)));
  return [readJson(join(TESTDATA, 'SOURCES.json')), ...releaseRecords].flat();
}

function verifiedSources() {
  const records = sourceRecords();
  // Provider pages are third-party text and are not published. Without one, its rows are
  // still held to the URL, date and digest recorded. A saved page must be bytes a record names.
  for (const file of new Set(records.map((source) => source.file))) {
    const path = join(TESTDATA, file);
    if (!existsSync(path)) continue;
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (!records.some((source) => source.file === file && source.sha256 === digest))
      throw new Error(`${file}: saved bytes match no source record`);
  }
  const byDigest = new Map();
  for (const source of records) byDigest.set(source.sha256, [...(byDigest.get(source.sha256) ?? []), source]);
  return byDigest;
}

function checkRows(sheet, name, sources) {
  const problems = [];
  const seen = new Set();
  for (const row of sheet.rows) {
    if (seen.has(row.SkuPriceId)) problems.push(`duplicate SkuPriceId ${row.SkuPriceId}`);
    seen.add(row.SkuPriceId);
    const candidates = sources.get(row.SourceSha256) ?? [];
    if (candidates.length === 0) problems.push(`${row.SkuPriceId}: no saved page with hash ${row.SourceSha256}`);
    else if (!candidates.some((source) => source.url === row.SourceUrl))
      problems.push(`${row.SkuPriceId}: source URL differs from the saved page`);
    else if (!candidates.some((source) => source.retrievedAt.slice(0, 10) === row.RetrievalDate))
      problems.push(`${row.SkuPriceId}: retrieval date differs from the saved page`);
    if (row.EffectiveEnd !== null && row.EffectiveEnd <= row.EffectiveStart)
      problems.push(`${row.SkuPriceId}: empty effective range`);
  }
  if (name !== `${sheet.Provider}-${sheet.SheetDate}.json`)
    problems.push(`file name does not match Provider and SheetDate`);
  return problems;
}

const unitPrices = (sheet) => sheet.rows.filter(({ RowType }) => RowType === 'unit_price');

// The fallback prices a model the sheet does not name, so no named row may cost more.
// Storage prices are per token-hour, and schema 0.1 gives them no fallback.
export function fallbackProblems(sheet) {
  const fallback = new Map(
    sheet.rows.filter(({ RowType }) => RowType === 'fallback').map((row) => [row.TokenClass, row.ListUnitPrice]),
  );
  return unitPrices(sheet)
    .filter(({ PricingUnit }) => PricingUnit === TOKENS)
    .flatMap(({ SkuPriceId, TokenClass, ListUnitPrice }) => {
      const bound = fallback.get(TokenClass);
      if (bound === undefined) return [`${SkuPriceId}: no fallback for ${TokenClass}`];
      return compareDecimals(ListUnitPrice, bound) > 0
        ? [`${SkuPriceId}: ${ListUnitPrice} is above the ${TokenClass} fallback ${bound}`]
        : [];
    });
}

const above = (row) => row.ContextTierMinInputTokens ?? -1;
const upTo = (row) => row.ContextTierMaxInputTokens ?? Infinity;
const until = (row) => row.EffectiveEnd ?? '9999-12-31';
const sharesContext = (a, b) => Math.max(above(a), above(b)) < Math.min(upTo(a), upTo(b));
const sharesDays = (a, b) => a.EffectiveStart < until(b) && b.EffectiveStart < until(a);

// Two rows that could price the same token on the same day would let row order choose the price.
export function overlapProblems(sheet) {
  const groups = new Map();
  for (const row of unitPrices(sheet)) {
    const key = [row.ModelId, row.ServiceTier, row.RegionId, row.TokenClass, row.PricingUnit].join(' ');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const problems = [];
  for (const rows of groups.values()) {
    rows.forEach((row, at) => {
      for (const other of rows.slice(at + 1)) {
        if (sharesContext(row, other) && sharesDays(row, other))
          problems.push(`${row.SkuPriceId} overlaps ${other.SkuPriceId}`);
      }
    });
  }
  return problems;
}

function holdsPriceRules(release) {
  const parts = release.split('.').map(Number);
  const at = parts.findIndex((part, index) => part !== PRICE_RULES_FROM[index]);
  return at === -1 || parts[at] > PRICE_RULES_FROM[at];
}

function main() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(readJson(join(ROOT, 'schema', 'v0.1', 'catalog.schema.json')));
  const sources = verifiedSources();
  let failures = 0;
  let total = 0;

  for (const release of readdirSync(SHEETS)) {
    for (const name of readdirSync(join(SHEETS, release)).filter((file) => file.endsWith('.json'))) {
      const sheet = readJson(join(SHEETS, release, name));
      const problems = validate(sheet)
        ? []
        : validate.errors.map(({ instancePath, message }) => `${instancePath} ${message}`);
      if (sheet.CatalogVersion !== release)
        problems.push(`CatalogVersion ${sheet.CatalogVersion} is not the directory ${release}`);
      problems.push(...checkRows(sheet, name, sources));
      if (holdsPriceRules(release)) problems.push(...fallbackProblems(sheet), ...overlapProblems(sheet));
      total += 1;
      if (problems.length > 0) {
        failures += 1;
        console.error(`${release}/${name}: ${problems.length} problems`);
        for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
      } else {
        console.log(`${release}/${name}: ${sheet.rows.length} rows valid`);
      }
    }
  }

  if (total === 0) {
    console.error('no sheets found');
    return 1;
  }
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
