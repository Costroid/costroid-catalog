import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffSheets, renderDiff } from './lib/diff.mjs';
import { buildSheets, CATALOG_VERSION, loadPages, renderSheet, ROOT, sheetFileName } from './lib/sheets.mjs';

function readSheets(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')));
}

function renderOmissions(omissions) {
  const lines = [
    `# Catalog ${CATALOG_VERSION}: what the sheets leave out`,
    '',
    'A price that is not on a provider page gets no row. Each entry says why it is absent.',
    '',
    '| Sheet | Item | Reason |',
    '| ----- | ---- | ------ |',
    ...omissions.map(({ provider, item, reason }) => `| ${provider} | ${item} | ${reason} |`),
    '',
  ];
  return lines.join('\n');
}

const previousAt = process.argv.indexOf('--previous');
const previous = previousAt > 0 ? process.argv[previousAt + 1] : null;
const check = process.argv.includes('--check');
const directory = join(ROOT, 'sheets', CATALOG_VERSION);
const { sheets, omissions } = buildSheets(loadPages());

if (check) {
  const stale = sheets.filter((sheet) => {
    const path = join(directory, sheetFileName(sheet));
    return !existsSync(path) || readFileSync(path, 'utf8') !== renderSheet(sheet);
  });
  for (const sheet of stale) console.error(`stale: ${sheetFileName(sheet)}`);
  process.exit(stale.length === 0 ? 0 : 1);
}

mkdirSync(directory, { recursive: true });
for (const sheet of sheets) {
  writeFileSync(join(directory, sheetFileName(sheet)), renderSheet(sheet));
  console.log(`${sheetFileName(sheet)}: ${sheet.rows.length} rows`);
}
const before = previous ? readSheets(join(ROOT, 'sheets', previous)) : [];
writeFileSync(
  join(ROOT, 'reports', `${CATALOG_VERSION}-diff.md`),
  renderDiff(diffSheets(before, sheets), { version: CATALOG_VERSION, previous }),
);
writeFileSync(join(ROOT, 'reports', `${CATALOG_VERSION}-omissions.md`), renderOmissions(omissions));
