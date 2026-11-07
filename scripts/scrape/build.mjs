import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderDiff } from './lib/diff.mjs';
import {
  buildSheets,
  CATALOG_VERSION,
  compareVersions,
  loadPages,
  loadSources,
  readRelease,
  readSources,
  releaseBefore,
  releaseDiff,
  renderSheet,
  REPORTS,
  sheetFileName,
  SHEETS,
  sourcesFileName,
  TESTDATA,
  versionParts,
} from './lib/sheets.mjs';

const USAGE = `usage:
  build.mjs --version <x.y.z> [--pages <dir>]   write a new release from the saved pages
  build.mjs --check --version <x.y.z>           rebuild a release from the pages it cites; exit 1 if a sheet differs
  build.mjs --diff [--pages <dir>]              compare the saved pages with the newest release; exit 1 on any row change

<dir> holds SOURCES.json and the files it names, as npm run fetch writes them. It defaults to scripts/scrape/testdata.`;

function renderOmissions(version, omissions) {
  return [
    `# Catalog ${version}: what the sheets leave out`,
    '',
    'A price that is not on a provider page gets no row. Each entry says why it is absent.',
    '',
    '| Sheet | Item | Reason |',
    '| ----- | ---- | ------ |',
    ...omissions.map(({ provider, item, reason }) => `| ${provider} | ${item} | ${reason} |`),
    '',
  ].join('\n');
}

function renderLeftThePage(leftThePage, previous) {
  if (leftThePage.length === 0) return '';
  return [
    '',
    '## Left the page, kept in the sheet',
    '',
    `The page no longer lists these models. Their rows stay as ${previous} read them, with that page as their source.`,
    '',
    ...leftThePage.map(({ row }) => `- \`${row.SkuPriceId}\``),
    '',
  ].join('\n');
}

const renderReleaseDiff = (diff, labels) =>
  `${renderDiff(diff, labels)}${labels.previous ? renderLeftThePage(diff.leftThePage, labels.previous) : ''}`;

function writeRelease(version, directory) {
  if (existsSync(join(SHEETS, version)))
    throw new Error(`sheets/${version} exists. A published release never changes.`);
  if (compareVersions(version, CATALOG_VERSION) <= 0)
    throw new Error(`${version} is not newer than the newest release, ${CATALOG_VERSION}`);
  const sources = readSources(directory);
  const previous = readRelease(CATALOG_VERSION);
  const { sheets, omissions } = buildSheets(loadPages(sources, directory), { version, previous });
  mkdirSync(join(SHEETS, version));
  for (const sheet of sheets) {
    writeFileSync(join(SHEETS, version, sheetFileName(sheet)), renderSheet(sheet));
    console.log(`${sheetFileName(sheet)}: ${sheet.rows.length} rows`);
  }
  const labels = { version, previous: CATALOG_VERSION };
  writeFileSync(join(REPORTS, `${version}-diff.md`), renderReleaseDiff(releaseDiff(previous, sheets), labels));
  writeFileSync(join(REPORTS, `${version}-omissions.md`), renderOmissions(version, omissions));
  writeFileSync(join(REPORTS, sourcesFileName(version)), `${JSON.stringify(sources, null, 2)}\n`);
}

function checkRelease(version, directory) {
  if (!existsSync(join(SHEETS, version))) throw new Error(`sheets/${version} does not exist`);
  const before = releaseBefore(version);
  const { sheets } = buildSheets(loadPages(loadSources(version), directory), {
    version,
    previous: before ? readRelease(before) : [],
  });
  const stale = sheets.filter((sheet) => {
    const path = join(SHEETS, version, sheetFileName(sheet));
    return !existsSync(path) || readFileSync(path, 'utf8') !== renderSheet(sheet);
  });
  for (const sheet of stale) console.error(`stale: ${version}/${sheetFileName(sheet)}`);
  return stale.length === 0;
}

function diffNewest(directory) {
  const release = readRelease(CATALOG_VERSION);
  const pages = loadPages(readSources(directory), directory);
  const { sheets } = buildSheets(pages, { version: CATALOG_VERSION, previous: release });
  const diff = releaseDiff(release, sheets);
  const moved = diff.added.length + diff.removed.length + diff.changed.length + diff.leftThePage.length;
  const retrieved = pages['anthropic-pricing'].retrievedAt;
  console.log(renderReleaseDiff(diff, { version: `pages retrieved ${retrieved}`, previous: CATALOG_VERSION }));
  console.log(
    moved === 0
      ? `The pages retrieved ${retrieved} build to the rows of ${CATALOG_VERSION}.`
      : `${moved} rows differ from ${CATALOG_VERSION}. A new release carries them.`,
  );
  return moved === 0;
}

let options;
try {
  ({ values: options } = parseArgs({
    options: {
      version: { type: 'string' },
      pages: { type: 'string', default: TESTDATA },
      check: { type: 'boolean', default: false },
      diff: { type: 'boolean', default: false },
    },
  }));
  if (options.check && options.diff) throw new Error('--check and --diff are separate modes');
  if (!options.diff) versionParts(options.version);
} catch (error) {
  console.error(`${error.message}\n\n${USAGE}`);
  process.exit(2);
}

const directory = resolve(options.pages);
try {
  if (options.diff) process.exit(diffNewest(directory) ? 0 : 1);
  if (options.check) process.exit(checkRelease(options.version, directory) ? 0 : 1);
  writeRelease(options.version, directory);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
