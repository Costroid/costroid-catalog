import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareDecimals } from './decimal.mjs';
import { diffSheets } from './diff.mjs';
import { makeRowFactory, TOKENS } from './rows.mjs';
import { PAGES } from '../sources.mjs';
import * as anthropic from '../parsers/anthropic.mjs';
import * as copilot from '../parsers/copilot.mjs';
import * as cursor from '../parsers/cursor.mjs';
import * as google from '../parsers/google.mjs';
import * as openai from '../parsers/openai.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..', '..');
export const TESTDATA = join(HERE, '..', 'testdata');
export const SHEETS = join(ROOT, 'sheets');
export const REPORTS = join(ROOT, 'reports');
export const SCHEMA_VERSION = '0.1';

const PARSERS = [anthropic, openai, google, copilot, cursor];
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function versionParts(text) {
  const match = VERSION.exec(text ?? '');
  if (!match) throw new Error(`not a release version: ${JSON.stringify(text)}`);
  return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
  const [a, b] = [versionParts(left), versionParts(right)];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function releases() {
  return readdirSync(SHEETS)
    .filter((name) => VERSION.test(name))
    .sort(compareVersions);
}

// The newest published release: the one the saved pages are checked against.
export const CATALOG_VERSION = releases().at(-1);

export const releaseBefore = (version) =>
  releases()
    .filter((release) => compareVersions(release, version) < 0)
    .at(-1);

export function readRelease(version) {
  return readdirSync(join(SHEETS, version))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readJson(join(SHEETS, version, name)));
}

// What `npm run fetch` saved last: each page's URL, retrieval time, SHA-256 and size.
export function readSources(directory = TESTDATA) {
  return readJson(join(directory, 'SOURCES.json'));
}

export const sourcesFileName = (version) => `${version}-sources.json`;

// The pages a release was built from. Release 0.1.0 predates the per-release record and cites the committed SOURCES.json.
export function loadSources(version = CATALOG_VERSION) {
  const path = join(REPORTS, sourcesFileName(version));
  return existsSync(path) ? readJson(path) : readSources();
}

export function loadPages(sources = loadSources(), directory = TESTDATA) {
  const pages = {};
  const providerPages = new Set(PAGES.map(({ id }) => id));
  for (const source of sources.filter(({ id }) => providerPages.has(id))) {
    const bytes = readFileSync(join(directory, source.file));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== source.sha256) throw new Error(`${source.file}: hash differs from the source record`);
    pages[source.id] = { ...source, text: bytes.toString('utf8') };
  }
  return pages;
}

export function sheetFileName({ Provider, SheetDate }) {
  return `${Provider}-${SheetDate}.json`;
}

// A model the page no longer prices keeps its rows from the previous release, with the provenance they had there.
function keptFrom(previous, onPage) {
  if (!previous) return [];
  const priced = new Set(onPage.filter(({ RowType }) => RowType === 'unit_price').map(({ ModelId }) => ModelId));
  const present = new Set(onPage.map(({ SkuPriceId }) => SkuPriceId));
  return previous.rows.filter(
    ({ RowType, ModelId, SkuPriceId }) =>
      RowType !== 'fallback' && ModelId !== undefined && !priced.has(ModelId) && !present.has(SkuPriceId),
  );
}

const FALLBACK_BASIS =
  'Highest list price for the token class across every unit price row of the sheet: every model, tier, region, context tier and section, models the page no longer lists included.';

// The rate for a model the sheet does not name: per token class, the highest list price of any row,
// so an unknown model is never priced below a known one. The row that sets it is its source.
export function boundingFallback(factory, rows) {
  const highest = new Map();
  for (const row of rows) {
    if (row.RowType !== 'unit_price' || row.PricingUnit !== TOKENS) continue;
    const best = highest.get(row.TokenClass);
    if (!best || compareDecimals(row.ListUnitPrice, best.ListUnitPrice) > 0) highest.set(row.TokenClass, row);
  }
  if (highest.size === 0) throw new Error('the sheet has no unit price to bound');
  return [...highest.keys()].sort().map((TokenClass) => {
    const top = highest.get(TokenClass);
    return factory.fallback(
      { url: top.SourceUrl, retrievedAt: top.RetrievalDate, sha256: top.SourceSha256 },
      { TokenClass, ListUnitPrice: top.ListUnitPrice, FallbackBasis: `${FALLBACK_BASIS} Set by ${top.SkuPriceId}.` },
    );
  });
}

function previousOf(version) {
  const before = releaseBefore(version);
  return before ? readRelease(before) : [];
}

// With no options, the build of the newest release from its own pages.
export function buildSheets(
  pages,
  {
    version = CATALOG_VERSION,
    previous = previousOf(version),
    sheetDate = pages['anthropic-pricing'].retrievedAt.slice(0, 10),
  } = {},
) {
  versionParts(version);
  const sheets = [];
  const omissions = [];
  for (const parser of PARSERS) {
    const { sheet, serviceProviderName } = parser.META;
    const factory = makeRowFactory({ provider: sheet, serviceProviderName, sheetDate });
    const parsed = parser.parse(pages, factory);
    // The sheet's own fallback replaces any a parser states for its page alone.
    const onPage = parsed.rows.filter(({ RowType }) => RowType !== 'fallback');
    const earlier = previous.find(({ Provider }) => Provider === sheet);
    const rows = [...onPage, ...keptFrom(earlier, onPage)];
    sheets.push({
      $schema: `../../schema/v${SCHEMA_VERSION}/catalog.schema.json`,
      SchemaVersion: SCHEMA_VERSION,
      CatalogVersion: version,
      Provider: sheet,
      ServiceProviderName: serviceProviderName,
      SheetDate: sheetDate,
      rows: [...rows, ...boundingFallback(factory, rows)],
    });
    omissions.push(...parsed.omissions.map((entry) => ({ provider: sheet, ...entry })));
  }
  return { sheets, omissions };
}

// A start the page does not state is the day it was read, so it is left out of a comparison between two readings.
// A row kept from an earlier release keeps that release's retrieval date.
const comparable = (sheets) =>
  sheets.map((sheet) => ({
    ...sheet,
    rows: sheet.rows.map(({ EffectiveStart, ...row }) =>
      [row.RetrievalDate, sheet.SheetDate].includes(EffectiveStart) ? row : { ...row, EffectiveStart },
    ),
  }));

const offThePage = (sheet, row) => row.RowType !== 'fallback' && row.RetrievalDate < sheet.SheetDate;

export function releaseDiff(before, after) {
  const wasOnThePage = new Set(
    before.flatMap((sheet) => sheet.rows.filter((row) => !offThePage(sheet, row)).map(({ SkuPriceId }) => SkuPriceId)),
  );
  const leftThePage = after.flatMap((sheet) =>
    sheet.rows
      .filter((row) => offThePage(sheet, row) && wasOnThePage.has(row.SkuPriceId))
      .map((row) => ({ provider: sheet.Provider, row })),
  );
  return { ...diffSheets(comparable(before), comparable(after)), leftThePage };
}

// One row per line, so a release diff reads as one line per changed price.
export function renderSheet({ rows, ...header }) {
  const head = JSON.stringify(header, null, 2).replace(/\n}$/, ',\n');
  const body = rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n');
  return `${head}  "rows": [\n${body}\n  ]\n}\n`;
}
