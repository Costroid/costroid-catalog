import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRowFactory } from './rows.mjs';
import { PAGES } from '../sources.mjs';
import * as anthropic from '../parsers/anthropic.mjs';
import * as copilot from '../parsers/copilot.mjs';
import * as cursor from '../parsers/cursor.mjs';
import * as google from '../parsers/google.mjs';
import * as openai from '../parsers/openai.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..', '..');
export const TESTDATA = join(HERE, '..', 'testdata');
export const SCHEMA_VERSION = '0.1';
export const CATALOG_VERSION = '0.1.0';

const PARSERS = [anthropic, openai, google, copilot, cursor];

export function loadSources() {
  return JSON.parse(readFileSync(join(TESTDATA, 'SOURCES.json'), 'utf8'));
}

export function loadPages() {
  const pages = {};
  const providerPages = new Set(PAGES.map(({ id }) => id));
  for (const source of loadSources().filter(({ id }) => providerPages.has(id))) {
    const bytes = readFileSync(join(TESTDATA, source.file));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== source.sha256) throw new Error(`${source.file}: hash differs from SOURCES.json`);
    pages[source.id] = { ...source, text: bytes.toString('utf8') };
  }
  return pages;
}

export function sheetFileName({ Provider, SheetDate }) {
  return `${Provider}-${SheetDate}.json`;
}

export function buildSheets(pages) {
  const sheetDate = pages['anthropic-pricing'].retrievedAt.slice(0, 10);
  const sheets = [];
  const omissions = [];
  for (const parser of PARSERS) {
    const { sheet, serviceProviderName } = parser.META;
    const factory = makeRowFactory({ provider: sheet, serviceProviderName, sheetDate });
    const parsed = parser.parse(pages, factory);
    sheets.push({
      $schema: `../../schema/v${SCHEMA_VERSION}/catalog.schema.json`,
      SchemaVersion: SCHEMA_VERSION,
      CatalogVersion: CATALOG_VERSION,
      Provider: sheet,
      ServiceProviderName: serviceProviderName,
      SheetDate: sheetDate,
      rows: parsed.rows,
    });
    omissions.push(...parsed.omissions.map((entry) => ({ provider: sheet, ...entry })));
  }
  return { sheets, omissions };
}

// One row per line, so a release diff reads as one line per changed price.
export function renderSheet({ rows, ...header }) {
  const head = JSON.stringify(header, null, 2).replace(/\n}$/, ',\n');
  const body = rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n');
  return `${head}  "rows": [\n${body}\n  ]\n}\n`;
}
