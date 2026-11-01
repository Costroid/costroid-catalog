import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHEETS = join(ROOT, 'sheets');
const TESTDATA = join(ROOT, 'scripts', 'scrape', 'testdata');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function verifiedSources() {
  const sources = new Map();
  for (const source of readJson(join(TESTDATA, 'SOURCES.json'))) {
    const digest = createHash('sha256')
      .update(readFileSync(join(TESTDATA, source.file)))
      .digest('hex');
    if (digest !== source.sha256) throw new Error(`${source.file}: saved bytes do not match SOURCES.json`);
    sources.set(source.sha256, source);
  }
  return sources;
}

function checkRows(sheet, name, sources) {
  const problems = [];
  const seen = new Set();
  for (const row of sheet.rows) {
    if (seen.has(row.SkuPriceId)) problems.push(`duplicate SkuPriceId ${row.SkuPriceId}`);
    seen.add(row.SkuPriceId);
    const source = sources.get(row.SourceSha256);
    if (!source) problems.push(`${row.SkuPriceId}: no saved page with hash ${row.SourceSha256}`);
    else if (source.url !== row.SourceUrl) problems.push(`${row.SkuPriceId}: source URL differs from the saved page`);
    else if (source.retrievedAt.slice(0, 10) !== row.RetrievalDate)
      problems.push(`${row.SkuPriceId}: retrieval date differs from the saved page`);
    if (row.EffectiveEnd !== null && row.EffectiveEnd <= row.EffectiveStart)
      problems.push(`${row.SkuPriceId}: empty effective range`);
  }
  if (name !== `${sheet.Provider}-${sheet.SheetDate}.json`)
    problems.push(`file name does not match Provider and SheetDate`);
  return problems;
}

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
  process.exit(1);
}
process.exit(failures === 0 ? 0 : 1);
