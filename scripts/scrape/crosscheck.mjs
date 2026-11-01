import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCrosscheck } from './lib/crosscheck.mjs';
import { buildSheets, CATALOG_VERSION, loadPages, loadSources, ROOT, TESTDATA } from './lib/sheets.mjs';

const sources = loadSources();
const snapshot = (id) =>
  JSON.parse(readFileSync(join(TESTDATA, sources.find((source) => source.id === id).file), 'utf8'));
const { sheets } = buildSheets(loadPages());
const { markdown, lite, router, resold } = buildCrosscheck({
  sheets,
  litellm: snapshot('litellm-map'),
  openrouter: snapshot('openrouter-listing'),
  sources,
  version: CATALOG_VERSION,
});
writeFileSync(join(ROOT, 'reports', `${CATALOG_VERSION}-crosscheck.md`), markdown);
console.log(`LiteLLM disagreements: ${lite.disagreements.length}`);
console.log(`OpenRouter disagreements: ${router.disagreements.length}`);
console.log(`Reseller disagreements: ${resold.rows.length}`);
