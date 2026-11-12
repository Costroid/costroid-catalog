import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { fallbackProblems, overlapProblems } from '../validate.mjs';
import { buildCrosscheck } from './lib/crosscheck.mjs';
import { compareDecimals, maxDecimal, perTokenToPerMillion } from './lib/decimal.mjs';
import { diffSheets, renderDiff } from './lib/diff.mjs';
import { moneyOf, parseTables, stripMarkup } from './lib/markdown.mjs';
import { makeRowFactory } from './lib/rows.mjs';
import {
  buildEachSheet,
  buildSheets,
  CATALOG_VERSION,
  compareVersions,
  loadPages,
  loadSources,
  pricesEndingUnfollowed,
  readRelease,
  releaseBefore,
  releases,
  releaseDiff,
  renderSheet,
  ROOT,
  sheetFileName,
  TESTDATA,
} from './lib/sheets.mjs';
import * as anthropicParser from './parsers/anthropic.mjs';
import * as copilotParser from './parsers/copilot.mjs';
import * as cursorParser from './parsers/cursor.mjs';
import * as googleParser from './parsers/google.mjs';
import * as openaiParser from './parsers/openai.mjs';
import { PAGES } from './sources.mjs';

// Provider pages are third-party text, so they are not published. A checkout without the pages the
// newest release cites runs the tests on hand-written pages and the committed sheets, and skips the rest by name.
const saved = ({ file, sha256 }) =>
  existsSync(join(TESTDATA, file)) &&
  createHash('sha256')
    .update(readFileSync(join(TESTDATA, file)))
    .digest('hex') === sha256;
const pagesSaved = loadSources().every(saved);
const needsPages = {
  skip: pagesSaved ? false : `the pages ${CATALOG_VERSION} cites are not saved here: provider pages are not published`,
};
const pages = pagesSaved ? loadPages() : {};
const { sheets } = pagesSaved ? buildSheets(pages) : { sheets: [] };
const sheet = (provider) => sheets.find(({ Provider }) => Provider === provider);
const PREVIOUS = releaseBefore(CATALOG_VERSION);
// Release 0.1.0 predates the rule that the fallback is the highest price of its class. A published release never changes.
const FIRST_RULED_RELEASE = '0.2.0';
const BUILD = join(ROOT, 'scripts', 'scrape', 'build.mjs');

function priceOf(provider, modelId, tokenClass, scope = {}) {
  const matches = sheet(provider).rows.filter(
    (row) =>
      row.RowType === 'unit_price' &&
      row.ModelId === modelId &&
      row.TokenClass === tokenClass &&
      Object.entries({ ServiceTier: 'standard', ...scope }).every(([field, value]) => row[field] === value),
  );
  assert.equal(matches.length, 1, `${provider} ${modelId} ${tokenClass}: expected one row, found ${matches.length}`);
  return matches[0];
}

const price = (...args) => priceOf(...args).ListUnitPrice;

function rowById(id) {
  return sheets.flatMap(({ rows }) => rows).find((row) => row.SkuPriceId === id);
}

// A hand-written page needs no saved provider text, so the parser tests below never skip.
const SHEET_DATE = '2026-11-07';
const handWritten = (text) => ({
  url: 'https://example.com/pricing.md',
  retrievedAt: `${SHEET_DATE}T12:00:00Z`,
  sha256: '0'.repeat(64),
  text,
});
const factoryFor = ({ sheet, serviceProviderName }) =>
  makeRowFactory({ provider: sheet, serviceProviderName, sheetDate: SHEET_DATE });

function openaiPage({
  solPromotion = 'until November 30, 2026',
  fedramp = 'FedRAMP endpoints are also charged a 10% uplift.',
  specialized = [],
  beforeTools = [],
  webSearch = [
    '| Web search | Web search (incl. images) | $10.00 / 1k calls + Search content tokens billed at model rates. |',
    '| Web search | Web search preview (other models) | $25.00 / 1k calls + Search content tokens are free. |',
  ],
} = {}) {
  return [
    'Flagship models',
    '',
    'Standard',
    '',
    '### Standard pricing data',
    '',
    `| Model | ${['input', 'output', 'cached input', '30m write', '12h write'].flatMap((column) => [`Short context ${column}`, `Long context ${column}`]).join(' | ')} |`,
    `|${' --- |'.repeat(11)}`,
    '| gpt-5.6-sol | $4.00 | $8.00 | $20.00 | $30.00 | $0.40 | $0.80 | - | - | - | - |',
    '| gpt-6-astra | $10.00 | $20.00 | $50.00 | $75.00 | $1.00 | $2.00 | $12.50 | $25.00 | $25.00 | $50.00 |',
    '',
    'Short context: ≤272K input tokens. Long context: >272K input tokens.',
    '',
    `GPT-5.6 Sol’s promotional pricing is available ${solPromotion}.`,
    '',
    'Specialized models',
    '',
    'Standard',
    '',
    '### Grouped Pricing Table data',
    '',
    '| Category | Model | Input | Output | Cached input | 30m write | 12h write |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...specialized,
    '| <a id="legal-model-configurations"></a>Legal | gpt-6-astra-law | $10.00 | $50.00 | $1.00 | - | - |',
    '| Embedding | text-embedding-3-small | $0.02 | - | - | - | - |',
    '| Moderation | omni-moderation-latest | Free | - | - | - | - |',
    '',
    'GPT-6 Astra for Law promotional pricing is available at least through December 31, 2026.',
    '',
    ...beforeTools,
    'Tools',
    '',
    '### Grouped Pricing Table data',
    '',
    '| Tool | Details | Pricing |',
    '| --- | --- | --- |',
    ...webSearch,
    '| File search | Tool call | $2.50 / 1k calls |',
    '',
    'Regional processing (data residency) endpoints are charged a 10% uplift for models released on or after March 5, 2026, that are eligible for data residency.',
    '',
    fedramp,
    '',
  ].join('\n');
}

const parseOpenai = (text) =>
  openaiParser.parse(
    {
      'openai-pricing': handWritten(text),
      'openai-reasoning': handWritten('Reasoning tokens are billed as [output tokens](/docs/pricing).'),
    },
    factoryFor(openaiParser.META),
  ).rows;

const handRow = (rows, id) => rows.find(({ SkuPriceId }) => SkuPriceId === id);

const tab = (title, input, output) => [
  `  {% tab title="${title}" %}`,
  '  {% table %}',
  '  * Feature',
  '  * Free Tier',
  '  * Paid Tier, per 1M tokens in USD{% sup %}*{% /sup %}',
  '',
  '  ---',
  '',
  '  * Input price',
  '  * Not available',
  ...input,
  '',
  '  ---',
  '',
  '  * Output price (including thinking tokens)',
  '  * Not available',
  ...output,
  '  {% /table %}',
  '  {% /tab %}',
  '',
];

const parseGoogle = (text) =>
  googleParser.parse({ 'google-pricing': handWritten(text) }, factoryFor(googleParser.META)).rows;

const ANTHROPIC_CACHE_HITS = [
  '| Claude Fable 5.2 and Claude Mythos 5.2 | 0.025x | $0.20 USD |',
  '| Claude Opus 5.5 | 0.05x | $0.20 USD |',
  '| Claude Sonnet 5.5 | 0.05x | $0.10 USD |',
];

// cacheHits: null leaves out the per-model cache hit table, as the page printed before it had one.
function anthropicPage({ cacheHits = ANTHROPIC_CACHE_HITS } = {}) {
  const limited = ' ([limited availability](https://example.com/access))';
  return [
    '| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |',
    '| :-- | :-- | :-- | :-- | :-- | :-- |',
    '| Claude Fable 5.2 | $8 / MTok | $10 / MTok | $16 / MTok | $0.20 / MTok<sup>1</sup> | $40 / MTok |',
    `| Claude Mythos 5.2${limited} | $8 / MTok | $10 / MTok | $16 / MTok | $0.20 / MTok<sup>1</sup> | $40 / MTok |`,
    '| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |',
    '| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |',
    '| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |',
    '',
    '### Prompt caching',
    '',
    '| Cache operation | Multiplier | Duration |',
    '| --- | --- | --- |',
    '| 5-minute cache write | 1.25x base input price | 5 minutes |',
    '| 1-hour cache write | 2x base input price | 1 hour |',
    '| Cache read (hit) | 0.1x base input price on most models | Same as the write |',
    '',
    ...(cacheHits === null
      ? []
      : [
          '| Model | Cache hit multiplier | Cache hit price per million tokens |',
          '| --- | --- | --- |',
          ...cacheHits,
          '| All other models | 0.1x | See [Model pricing](https://example.com/pricing) |',
          '',
        ]),
    'For Claude 4.6 and later models, specifying US-only inference through the `inference_geo` parameter incurs a 1.1x multiplier on all token pricing categories.',
    '',
    '### Fast mode pricing',
    '',
    '| Model | Input | Output |',
    '| --- | --- | --- |',
    '| Claude Fable 5.2 | $16 USD / MTok | $80 USD / MTok |',
    '| Claude Mythos 5.2 | $16 USD / MTok | $80 USD / MTok |',
    '| Claude Opus 5.5 | $8 USD / MTok | $40 USD / MTok |',
    '',
    '### Batch processing',
    '',
    'The Batch API allows asynchronous processing with a 50 percent discount on both input and output tokens.',
    '',
    '| Model | Batch input | Batch output |',
    '| :-- | :-- | :-- |',
    '| Claude Fable 5.2 | $4 / MTok | $20 / MTok |',
    `| Claude Mythos 5.2${limited} | $4 / MTok | $20 / MTok |`,
    '| Claude Sonnet 5.5 | $1 / MTok | $5 / MTok |',
    '',
    '| Model | Tool use system prompt tokens: auto, none | Tool use system prompt tokens: any, tool |',
    '| :-- | :-- | :-- |',
    '| Claude Opus 5.5 | 286 tokens | |',
    '| Claude Sonnet 5.5 | 286 tokens | |',
    '',
    'Web search is available for **$10 USD per 1,000 searches**.',
    'Additional usage is billed at **$0.05 USD per hour, per container**.',
    '',
    '| Usage | Rate | Billed while |',
    '| --- | --- | --- |',
    '| Session runtime | $0.08 USD per session-hour | running |',
    '',
    'Usage is converted to CCUs at $0.01 USD per CCU.',
    '',
  ].join('\n');
}

const ANTHROPIC_STATUS = [
  '| API model name | Current state |',
  '| --- | --- |',
  '| claude-fable-5-2 | Active |',
  '| claude-mythos-5-2 | Active |',
  '| claude-opus-5-5 | Active |',
  '| claude-sonnet-5-5 | Active |',
  '| claude-haiku-4-5-20251001 | Active |',
  '',
].join('\n');

const parseAnthropic = (text, previous) =>
  anthropicParser.parse(
    {
      'anthropic-pricing': handWritten(text),
      'anthropic-model-status': handWritten(ANTHROPIC_STATUS),
      'anthropic-thinking': handWritten(
        'With thinking on, the tokens Claude spends reasoning are billed as output tokens.',
      ),
    },
    factoryFor(anthropicParser.META),
    previous,
  ).rows;

function copilotPage() {
  return [
    '## Pricing tables',
    '',
    '### Google',
    '',
    '| Model | Release status | Category | Tier | Threshold (input tokens) | Input | Cached input | Output |',
    '| --- | --- | --- | --- | --- | --: | --: | --: |',
    '| Gemini 4 Argon[^gemini-4-argon-promo] | GA | Powerful | Default | Not applicable | $2.00 | $0.10 | $10.00 |',
    '| Gemini 4 Carbon[^gemini-4-carbon-promo] | GA | Powerful | Default | Not applicable | $2.00 | $0.10 | $10.00 |',
    '',
    '1 AI credit = $0.01 USD',
    '',
    '[^gemini-4-argon-promo]: Gemini 4 Argon has a promotional price until December 1, 2026.',
    '',
    '[^gemini-4-carbon-promo]: Gemini 4 Carbon has a promotional price until December 1, 2026. Starting December 1, 2026, pricing is $4.00 per 1M input tokens, $0.20 per 1M cached input tokens, and $20.00 per 1M output tokens.',
    '',
  ].join('\n');
}

const parseCopilot = (text) =>
  copilotParser.parse(
    {
      'github-copilot-pricing': handWritten(text),
      'github-copilot-legacy-multipliers': handWritten(
        '| Model | Multiplier |\n| --- | --- |\n| Gemini 4 Argon | 1 |\n',
      ),
      'github-copilot-legacy-requests': handWritten('Purchase additional premium requests at $0.04/request.'),
    },
    factoryFor(copilotParser.META),
  ).rows;

const ROUTE_TO_FLASH = [
  '  Gemini 2.5 Pro (`gemini-2.5-pro`) is',
  '  [deprecated](/docs/deprecations#gemini-2.5-pro-models) and is no longer',
  '  available to select in Google AI Studio. Effective December 1, 2026, all API',
  '  requests to `gemini-2.5-pro` will automatically route to',
  '  [Gemini 3.8 Flash (`gemini-3.8-flash`)](/docs/models/gemini-3.8-flash) and be',
  '  billed at [Gemini 3.8 Flash rates](/docs/pricing#gemini-3.8-flash).',
];

function reroutePage(callout = ROUTE_TO_FLASH) {
  return [
    '# Gemini Developer API pricing',
    '',
    '## Gemini 3.8 Flash  {% id="gemini-3.8-flash" %}',
    '',
    '*[`gemini-3.8-flash`](/docs/models/gemini-3.8-flash)*',
    '',
    '{% tabs %}',
    ...tab(
      'Standard',
      ['  * $0.75 through December 31, 2026.', '  $1.50 starting January 1, 2027.'],
      ['  * $3.75 through December 31, 2026.', '  $7.50 starting January 1, 2027.'],
    ),
    ...tab('Contributor', ['  * $0.375'], ['  * $1.875']),
    '{% /tabs %}',
    '',
    '## Gemini 2.5 Pro  {% id="gemini-2.5-pro" %}',
    '',
    '*[`gemini-2.5-pro`](/docs/models/gemini-2.5-pro)*',
    '',
    '{% callout type="caution" %}',
    ...callout,
    '',
    '{% /callout %}',
    '',
    '{% tabs %}',
    ...tab(
      'Standard',
      ['  * $1.25, prompts <= 200k tokens', '  $2.50, prompts > 200k tokens'],
      ['  * $10.00, prompts <= 200k tokens', '  $15.00, prompts > 200k'],
    ),
    '{% /tabs %}',
    '',
  ].join('\n');
}

// The rate a sheet answers for one request: the single row whose tier, context range and dates hold.
function rateOn(sheetRows, { model, tier = 'standard', tokenClass, date, inputTokens = 1000 }) {
  const holding = sheetRows.filter(
    (row) =>
      row.RowType === 'unit_price' &&
      row.PricingUnit === '1000000 Tokens' &&
      row.ModelId === model &&
      row.ServiceTier === tier &&
      row.TokenClass === tokenClass &&
      (row.ContextTierMinInputTokens ?? 0) < inputTokens &&
      inputTokens <= (row.ContextTierMaxInputTokens ?? Infinity) &&
      row.EffectiveStart <= date &&
      (row.EffectiveEnd === null || date < row.EffectiveEnd),
  );
  assert.equal(
    holding.length,
    1,
    `${model} ${tier} ${tokenClass} ${date}: ${holding.map(({ SkuPriceId }) => SkuPriceId)}`,
  );
  return holding[0];
}

describe('parsers on hand-written pages', () => {
  test('throws on an unknown heading before a priced table', () => {
    const renamed = openaiPage({
      beforeTools: [
        'Fine-tuning pricing',
        '',
        'Standard',
        '',
        '| Model | Input | Output | Cached input |',
        '| --- | --- | --- | --- |',
        '| gpt-4.1-2025-04-14 | $3.00 | $12.00 | $0.75 |',
        '',
      ],
    });
    assert.throws(() => parseOpenai(renamed), /unknown heading "Fine-tuning pricing" above the table/);
    const marked = openaiPage({
      beforeTools: [
        '### Long context pricing data',
        '',
        '| Model | Input | Output | Cached input |',
        '| --- | --- | --- | --- |',
        '| gpt-6-astra | $20.00 | $75.00 | $2.00 |',
        '',
      ],
    });
    assert.throws(() => parseOpenai(marked), /unknown heading "Long context pricing data"/);
    assert.equal(handRow(parseOpenai(openaiPage()), 'openai:gpt-4.1-2025-04-14:global:standard:all:output'), undefined);
  });

  test('reads a promotion end into EffectiveEnd', () => {
    const rows = parseOpenai(openaiPage());
    const sol = handRow(rows, 'openai:gpt-5.6-sol:global:standard:to-272000:input_uncached');
    assert.equal(sol.EffectiveEnd, '2026-12-01');
    assert.equal(sol.Note, 'Promotional price, available until November 30, 2026.');
    assert.equal(handRow(rows, 'openai:gpt-5.6-sol:global:standard:over-272000:output').EffectiveEnd, '2026-12-01');
    const law = handRow(rows, 'openai:gpt-6-astra-law:global:standard:all:cache_read');
    assert.equal(law.EffectiveEnd, '2027-01-01');
    assert.equal(law.Note, 'Promotional price, available at least through December 31, 2026.');
    assert.equal(handRow(rows, 'openai:gpt-6-astra:global:standard:to-272000:input_uncached').EffectiveEnd, null);
    const older = parseOpenai(openaiPage({ solPromotion: 'at least through November 21, 2026' }));
    assert.equal(handRow(older, 'openai:gpt-5.6-sol:global:standard:to-272000:output').EffectiveEnd, '2026-11-22');
    assert.throws(() => parseOpenai(openaiPage({ solPromotion: 'for now' })), /GPT-5\.6 Sol’s promotion not found/);
  });

  test('reads both FedRAMP wordings', () => {
    const dated = parseOpenai(
      openaiPage({ fedramp: 'Starting Nov 1, 2026, FedRAMP endpoints are also charged a 10% uplift.' }),
    );
    const fedramp = handRow(dated, 'openai:multiplier:fedramp');
    assert.equal(fedramp.EffectiveStart, '2026-11-01');
    assert.equal(fedramp.Multiplier, '1.1');
    assert.equal(fedramp.RegionId, 'fedramp');
    const undated = handRow(parseOpenai(openaiPage()), 'openai:multiplier:fedramp');
    assert.equal(undated.EffectiveStart, SHEET_DATE);
    assert.equal(undated.Multiplier, '1.1');
    assert.throws(
      () => parseOpenai(openaiPage({ fedramp: 'FedRAMP endpoints are charged list prices.' })),
      /FedRAMP uplift not found/,
    );
  });

  test('reads a model from the Markdoc page', () => {
    const page = [
      '# Gemini Developer API pricing',
      '',
      '## Gemini 9 Pro  {% id="gemini-9-pro" %}',
      '',
      '{% two-column-layout %}',
      '  {% left-column class="center-vertically" %}',
      '  *[`gemini-9-pro`](/docs/models/gemini-9-pro) and',
      '    [`gemini-9-pro-customtools`](/docs/models/gemini-9-pro#customtools)*',
      '  {% /left-column %}',
      '{% /two-column-layout %}',
      '',
      '{% tabs %}',
      ...tab(
        'Standard',
        ['  * $2.00, prompts <= 200k tokens    ', '  $4.00, prompts > 200k tokens'],
        ['  * $12.00 through November 30, 2026.   ', '  $18.00 starting December 1, 2026.'],
      ),
      ...tab('Batch', ['  * $1.00'], ['  * $6.00']),
      '{% /tabs %}',
      '',
      '## Gemini 2.5 Pro  {% id="gemini-2.5-pro" %}',
      '',
      '*[`gemini-2.5-pro`](/docs/models/gemini-2.5-pro)*',
      '',
      '{% callout type="caution" %}',
      '  Gemini 2.5 Pro (`gemini-2.5-pro`) is',
      '  [deprecated](/docs/deprecations#gemini-2.5-pro-models).',
      '{% /callout %}',
      '',
      '{% tabs %}',
      ...tab('Standard', ['  * $1.25'], ['  * $10.00']),
      '{% /tabs %}',
      '',
    ].join('\n');
    const rows = parseGoogle(page);
    const long = handRow(rows, 'google:gemini-9-pro-customtools:global:standard:over-200000:input_uncached');
    assert.equal(long.ListUnitPrice, '4.00');
    assert.equal(long.ModelName, 'Gemini 9 Pro');
    assert.equal(long.ModelStatus, 'unstated');
    assert.equal(handRow(rows, 'google:gemini-9-pro:global:standard:all:output').EffectiveEnd, '2026-12-01');
    assert.equal(
      handRow(rows, 'google:gemini-9-pro:global:standard:all:output:from-2026-12-01').ListUnitPrice,
      '18.00',
    );
    assert.equal(handRow(rows, 'google:gemini-9-pro:global:batch:all:output').ListUnitPrice, '6.00');
    assert.equal(handRow(rows, 'google:gemini-2.5-pro:global:standard:all:input_uncached').ModelStatus, 'deprecated');
    assert.deepEqual(handRow(rows, 'google:reasoning:thinking-tokens').AppliesToModels, [
      'gemini-9-pro',
      'gemini-9-pro-customtools',
      'gemini-2.5-pro',
    ]);
  });

  test("a rerouted Gemini model bills at its successor's rate from the reroute date", () => {
    const rows = parseGoogle(reroutePage());
    const ask = (model, date, inputTokens) => rateOn(rows, { model, tokenClass: 'output', date, inputTokens });
    assert.equal(ask('gemini-2.5-pro', '2026-11-30', 1000).ListUnitPrice, '10.00');
    assert.equal(ask('gemini-2.5-pro', '2026-11-30', 300000).ListUnitPrice, '15.00');
    for (const date of ['2026-12-01', '2026-12-31', '2027-01-01', '2028-01-01']) {
      for (const inputTokens of [1000, 300000]) {
        assert.equal(
          ask('gemini-2.5-pro', date, inputTokens).ListUnitPrice,
          ask('gemini-3.8-flash', date).ListUnitPrice,
        );
      }
    }
    const routed = handRow(rows, 'google:gemini-2.5-pro:global:standard:all:output:from-2026-12-01');
    assert.equal(routed.ListUnitPrice, '3.75');
    assert.equal(routed.EffectiveEnd, '2027-01-01');
    assert.equal(routed.ModelName, 'Gemini 2.5 Pro');
    assert.equal(routed.ModelStatus, 'deprecated');
    assert.equal(routed.SourceUrl, 'https://example.com/pricing.md');
    assert.equal(
      routed.Note,
      'Effective December 1, 2026, all API requests to gemini-2.5-pro will automatically route to Gemini 3.8 Flash (gemini-3.8-flash) and be billed at Gemini 3.8 Flash rates.',
    );
    assert.equal(
      handRow(rows, 'google:gemini-2.5-pro:global:standard:all:output:from-2027-01-01').ListUnitPrice,
      '7.50',
    );
    assert.equal(
      handRow(rows, 'google:gemini-2.5-pro:global:contributor:all:output:from-2026-12-01').ListUnitPrice,
      '1.875',
    );
    assert.equal(handRow(rows, 'google:gemini-2.5-pro:global:standard:to-200000:output').EffectiveEnd, '2026-12-01');
    assert.equal(handRow(rows, 'google:gemini-2.5-pro:global:standard:over-200000:output').Note, routed.Note);

    const google = readRelease('0.3.0').find(({ Provider }) => Provider === 'google');
    const published = (request) => rateOn(google.rows, request).ListUnitPrice;
    for (const [model, successor] of [
      ['gemini-2.5-pro', 'gemini-3.8-flash'],
      ['gemini-2.5-flash', 'gemini-3.5-flash-lite'],
    ]) {
      for (const tier of ['standard', 'batch', 'flex', 'priority', 'contributor']) {
        for (const tokenClass of ['input_uncached', 'output', 'cache_read']) {
          for (const date of ['2026-12-01', '2026-12-31', '2027-01-01', '2028-01-01']) {
            const request = { tier, tokenClass, date };
            assert.equal(published({ ...request, model }), published({ ...request, model: successor }));
          }
        }
      }
    }
    assert.equal(published({ model: 'gemini-2.5-pro', tokenClass: 'output', date: '2026-11-30' }), '10.00');
    assert.equal(published({ model: 'gemini-2.5-pro', tokenClass: 'output', date: '2026-12-01' }), '3.75');
    assert.equal(
      published({ model: 'gemini-2.5-pro', tokenClass: 'output', date: '2026-12-01', inputTokens: 300000 }),
      '3.75',
    );
    assert.equal(published({ model: 'gemini-2.5-pro', tokenClass: 'output', date: '2027-01-01' }), '7.50');
    assert.equal(
      published({ model: 'gemini-2.5-flash', tier: 'batch', tokenClass: 'cache_read', date: '2026-11-30' }),
      '0.03',
    );
    assert.equal(
      published({ model: 'gemini-2.5-flash', tier: 'batch', tokenClass: 'cache_read', date: '2026-12-01' }),
      '0.015',
    );
  });

  test('a reroute the parser cannot read stops the build', () => {
    const reworded = ROUTE_TO_FLASH.map((line) => line.replace('will automatically route to', 'will route to'));
    assert.throws(() => parseGoogle(reroutePage(reworded)), /unread reroute under Gemini 2\.5 Pro/);
    const billedElsewhere = ROUTE_TO_FLASH.map((line) => line.replace('pricing#gemini-3.8-flash', 'pricing#gemini-9'));
    assert.throws(() => parseGoogle(reroutePage(billedElsewhere)), /routes to gemini-3\.8-flash but bills at gemini-9/);
    const nowhere = ROUTE_TO_FLASH.map((line) => line.replaceAll('gemini-3.8-flash', 'gemini-9-flash'));
    assert.throws(() => parseGoogle(reroutePage(nowhere)), /routes to gemini-9-flash, which has no price/);
  });

  const cursorPage = [
    '| Model | Provider | Input | Cache write | Cache read | Output | US data residency | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| [Grok 4.7](https://x.ai) | Cursor | $2 | - | $0.5 | $6 | Yes | Long context (>256k input tokens) is billed at 2x standard rates, up to 500k |',
    '| [Grok 4.7 500k](https://x.ai) | Cursor | $4 | - | $1 | $12 | Yes | Long context (>256k input tokens) is billed at 2x standard rates, up to 500k |',
    '| [Composer Mini](https://cursor.com) | Cursor | $0.05 | - | $0.005 | $0.2 | No | |',
    '',
    'Third-party models:',
    '',
    '| Model | Provider | Input | Cache write | Cache read | Output | US data residency | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| [Claude Haiku 5.5](https://anthropic.com) | Anthropic | $0.1 | $0.125 | $0.01 | $0.5 | Yes | |',
    '| [GPT-5.4 Nano](https://openai.com) | OpenAI | $0.2 | - | $0.02 | $1.25 | No | |',
    '| [GPT-5.4 Nano (Fast)](https://openai.com) | OpenAI | $0.4 | - | $0.12 | $2.5 | No | |',
    '| [Claude Opus 5.5](https://anthropic.com) | Anthropic | $5 | $6.25 | $0.5 | $25 | Yes | |',
    '',
    'Opting in to regional data residency incurs a 10% uplift on Model pricing for eligible Models.',
    '',
    "Max Mode is billed at the model's API rate plus 20%.",
    '',
    'Eligible third-party model requests include a Cursor Token Rate of $0.25 per million tokens.',
    '',
    'The Cursor Token Rate also does not apply to third-party models whose cache-read price is strictly below $0.10 per million tokens across every pricing tier. This exemption also applies when you use your own API key.',
    '',
  ].join('\n');
  const parseCursor = (text) =>
    cursorParser.parse({ 'cursor-pricing': handWritten(text) }, factoryFor(cursorParser.META)).rows;

  test('reads the Cursor Token Rate exemption rule', () => {
    const rate = handRow(parseCursor(cursorPage), 'cursor:additive:cursor-token-rate');
    assert.deepEqual(rate.ExcludedModels, ['claude-haiku-5.5']);
    assert.match(rate.Condition, /below USD 0\.10 per 1M tokens on every row/);
    const listed = cursorPage.replace(/The Cursor Token Rate also does not apply[^\n]*/, 'These models are excluded:');
    assert.throws(() => parseCursor(listed), /Cursor Token Rate exemption not found/);
  });

  test('prices a plain row up to where its long context starts', () => {
    const rows = parseCursor(cursorPage);
    assert.equal(handRow(rows, 'cursor:grok-4.7:global:standard:to-256000:input_uncached').ListUnitPrice, '2');
    assert.equal(
      handRow(rows, 'cursor:grok-4.7:global:standard:over-256000-to-500000:input_uncached').ListUnitPrice,
      '4',
    );
    assert.equal(handRow(rows, 'cursor:grok-4.7:global:standard:all:input_uncached'), undefined);
    assert.equal(handRow(rows, 'cursor:composer-mini:global:standard:all:input_uncached').ListUnitPrice, '0.05');
  });
  const datedCursorPage = cursorPage.replace(
    '| [Claude Opus 5.5]',
    [
      '| [Gemini 4 Carbon](https://google.com) | Google | $2 | - | $0.1 | $10 | No | Introductory pricing through November 30, 2026. From December 1, 2026: $4 input, $0.20 cache read, $20 output per 1M tokens |',
      '| [GPT-5.6 Sol](https://openai.com) | OpenAI | $4 | $5 | $0.4 | $20 | Yes | Reasoning model; Promotional pricing through November 21, 2026 |',
      '| [Claude Opus 5.5]',
    ].join('\n'),
  );

  test('reads the Specialized models table by its Category column', () => {
    const specialized = [
      '| <a id="cyber-models"></a>Cyber — Trusted Access: [Daybreak](https://example.com/) | gpt-6-cyber (short context) | $20.00 | $100.00 | $2.00 | $25.00 | $50.00 |',
      '| Cyber — Trusted Access: [Daybreak](https://example.com/) | gpt-6-cyber (long context) | $40.00 | $150.00 | $4.00 | - | - |',
      '| Codex | gpt-5.3-codex | $1.75 | $14.00 | $0.175 | - | - |',
    ];
    const rows = parseOpenai(openaiPage({ specialized }));
    const short = handRow(rows, 'openai:gpt-6-cyber:global:standard:to-272000:input_uncached');
    assert.equal(short.ListUnitPrice, '20.00');
    assert.equal(short.ModelStatus, 'limited');
    assert.equal(handRow(rows, 'openai:gpt-6-cyber:global:standard:over-272000:output').ListUnitPrice, '150.00');
    assert.equal(handRow(rows, 'openai:gpt-6-cyber:global:standard:to-272000:cache_write_12h').ListUnitPrice, '50.00');
    assert.equal(handRow(rows, 'openai:gpt-6-cyber:global:standard:over-272000:cache_write_30m'), undefined);
    assert.equal(handRow(rows, 'openai:gpt-5.3-codex:global:standard:all:cache_read').ModelStatus, 'unstated');
    assert.equal(handRow(rows, 'openai:gpt-6-astra-law:global:standard:all:output').ListUnitPrice, '50.00');
    assert.ok(!rows.some(({ ModelId }) => ['text-embedding-3-small', 'omni-moderation-latest'].includes(ModelId)));
    const unknown = ['| Agents | gpt-agent | $1.00 | $2.00 | - | - | - |'];
    assert.throws(() => parseOpenai(openaiPage({ specialized: unknown })), /unknown category "Agents"/);
    const range = ['| Codex | gpt-5.3-codex (medium context) | $1.75 | $14.00 | - | - | - |'];
    assert.throws(
      () => parseOpenai(openaiPage({ specialized: range })),
      /model gpt-5\.3-codex \(medium context\) not found/,
    );
  });

  test('reads the Images, GPT-Live and Realtime & Audio sections without pricing their tables', () => {
    const section = (heading, row) => [
      heading,
      '',
      '### Grouped Pricing Table data',
      '',
      row,
      '| --- | --- |',
      '| gpt-x | $1.00 |',
      '',
    ];
    const beforeTools = [
      ...section('Images', '| Model | Input |'),
      ...section('GPT-Live', '| Model | Price per minute |'),
      ...section('Realtime & Audio', '| Model | Input |'),
    ];
    const rows = parseOpenai(openaiPage({ beforeTools }));
    assert.ok(!rows.some(({ ModelId }) => ModelId === 'gpt-x'));
    const renamed = beforeTools.map((line) => (line === 'GPT-Live' ? 'GPT-Live sessions' : line));
    assert.throws(() => parseOpenai(openaiPage({ beforeTools: renamed })), /unknown heading "GPT-Live sessions"/);
  });

  test('reads the renamed web search tool rows', () => {
    const rows = parseOpenai(openaiPage());
    assert.equal(handRow(rows, 'openai:fee:web-search').ListUnitPrice, '10.00');
    assert.equal(handRow(rows, 'openai:fee:web-search-preview-non-reasoning').ListUnitPrice, '25.00');
    const older = [
      '| Web search | Web search (all models) | $10.00 / 1k calls + Search content tokens billed at model rates. |',
      '| Web search | Web search preview (non-reasoning models) | $25.00 / 1k calls + Search content tokens are free. |',
    ];
    assert.throws(() => parseOpenai(openaiPage({ webSearch: older })), /Web search \(incl\. images\) not found/);
  });

  test('reads the cache hit multipliers from the per-model table', () => {
    const rows = parseAnthropic(anthropicPage());
    const fable = handRow(rows, 'anthropic:multiplier:prompt-cache-read-claude-fable-5-2');
    assert.equal(fable.Multiplier, '0.025');
    assert.deepEqual(fable.AppliesToModels, ['claude-fable-5-2', 'claude-mythos-5-2']);
    assert.deepEqual(handRow(rows, 'anthropic:multiplier:prompt-cache-read-claude-opus-5-5').AppliesToModels, [
      'claude-opus-5-5',
    ]);
    assert.equal(handRow(rows, 'anthropic:multiplier:prompt-cache-read-claude-sonnet-5-5').Multiplier, '0.05');
    assert.equal(handRow(rows, 'anthropic:multiplier:prompt-cache-read').Multiplier, '0.1');
    const listed = parseAnthropic(
      anthropicPage({
        cacheHits: ['| Claude Opus 5.5, Claude Sonnet 5.5, and Claude Fable 5.2 | 0.05x | $0.20 USD |'],
      }),
    );
    assert.deepEqual(handRow(listed, 'anthropic:multiplier:prompt-cache-read-claude-opus-5-5').AppliesToModels, [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-fable-5-2',
    ]);
    const others = anthropicPage().replace('| All other models | 0.1x |', '| All other models | 0.2x |');
    assert.throws(() => parseAnthropic(others), /gives other models 0\.2x, the cache read row 0\.1x/);
    const cellOnly = anthropicPage({ cacheHits: null });
    assert.throws(() => parseAnthropic(cellOnly), /no table with column "Cache hit multiplier"/);
  });

  test('a model whose own cache hit multiplier left the page stops the build', () => {
    const factory = factoryFor(anthropicParser.META);
    const previous = {
      CatalogVersion: '0.3.0',
      rows: [
        factory.multiplier(handWritten(''), {
          key: 'prompt-cache-read-claude-sonnet-5-5',
          ModifierKind: 'prompt_cache',
          Multiplier: '0.05',
          AppliesToModels: ['claude-sonnet-5-5'],
          AppliesToTokenClasses: ['cache_read'],
        }),
      ],
    };
    const withoutSonnet = ['| Claude Fable 5.2 and Claude Mythos 5.2 | 0.025x | $0.20 USD |'];
    assert.throws(
      () => parseAnthropic(anthropicPage({ cacheHits: withoutSonnet }), previous),
      /claude-sonnet-5-5 had its own cache read multiplier in 0\.3\.0 and the page names none/,
    );
    assert.ok(parseAnthropic(anthropicPage(), previous).length > 0);
    const gone = anthropicPage({ cacheHits: withoutSonnet }).replace(/^\| Claude Sonnet 5\.5 .*\n/gm, '');
    assert.equal(
      handRow(parseAnthropic(gone, previous), 'anthropic:multiplier:prompt-cache-read-claude-sonnet-5-5'),
      undefined,
    );
  });

  test('a model of limited availability is limited on its fast mode rows too', () => {
    const rows = parseAnthropic(anthropicPage());
    assert.equal(handRow(rows, 'anthropic:claude-mythos-5-2:global:fast:all:output').ModelStatus, 'limited');
    assert.equal(handRow(rows, 'anthropic:claude-mythos-5-2:global:standard:all:output').ModelStatus, 'limited');
    assert.equal(handRow(rows, 'anthropic:claude-fable-5-2:global:fast:all:output').ModelStatus, 'active');
  });

  test('reads the first sentence of a footnote that continues after its date', () => {
    const rows = parseCopilot(copilotPage());
    const promotion = handRow(rows, 'github-copilot:gemini-4-carbon:global:standard:all:output');
    assert.equal(promotion.ListUnitPrice, '10.00');
    assert.equal(promotion.EffectiveEnd, '2026-12-01');
    assert.equal(promotion.Note, 'Promotional price. The page states the price that follows it.');
    const next = handRow(rows, 'github-copilot:gemini-4-carbon:global:standard:all:output:from-2026-12-01');
    assert.equal(next.ListUnitPrice, '20.00');
    assert.equal(next.EffectiveStart, '2026-12-01');
    assert.equal(next.EffectiveEnd, null);
    assert.equal(
      handRow(rows, 'github-copilot:gemini-4-carbon:global:standard:all:cache_read:from-2026-12-01').ListUnitPrice,
      '0.20',
    );
    const argon = handRow(rows, 'github-copilot:gemini-4-argon:global:standard:all:input_uncached');
    assert.equal(argon.EffectiveEnd, '2026-12-01');
    assert.equal(argon.Note, 'Promotional price. The page states no price after it ends.');
    assert.equal(
      handRow(rows, 'github-copilot:gemini-4-argon:global:standard:all:input_uncached:from-2026-12-01'),
      undefined,
    );
    const reworded = copilotPage().replace('Starting December 1, 2026, pricing is', 'Later, pricing rises to');
    assert.throws(() => parseCopilot(reworded), /unread sentence after the date in footnote gemini-4-carbon-promo/);
    const gap = copilotPage().replace('Starting December 1, 2026', 'Starting December 2, 2026');
    assert.throws(() => parseCopilot(gap), /ends its promotion on 2026-12-01 and states a price from 2026-12-02/);
  });

  test('reads a dated price and the price after it from a Cursor note', () => {
    const rows = parseCursor(datedCursorPage);
    const sol = handRow(rows, 'cursor:gpt-5.6-sol:global:standard:all:output');
    assert.equal(sol.EffectiveEnd, '2026-11-22');
    assert.equal(sol.Note, 'Promotional price. The page states no price after it ends.');
    assert.equal(handRow(rows, 'cursor:gemini-4-carbon:global:standard:all:input_uncached').EffectiveEnd, '2026-12-01');
    assert.equal(
      handRow(rows, 'cursor:gemini-4-carbon:global:standard:all:input_uncached:from-2026-12-01').ListUnitPrice,
      '4',
    );
    assert.equal(
      handRow(rows, 'cursor:gemini-4-carbon:global:standard:all:cache_read:from-2026-12-01').ListUnitPrice,
      '0.20',
    );
    assert.equal(
      handRow(rows, 'cursor:gemini-4-carbon:global:standard:all:output:from-2026-12-01').ListUnitPrice,
      '20',
    );
    assert.equal(handRow(rows, 'cursor:claude-opus-5.5:global:standard:all:output').EffectiveEnd, null);
    const reworded = datedCursorPage.replace(
      'Promotional pricing through November 21, 2026',
      'Promotional pricing ends November 21, 2026',
    );
    assert.throws(() => parseCursor(reworded), /unread date in the note/);
  });

  test('a price that ends with no later price is named with the day the fallback takes over', () => {
    const openai = { Provider: 'openai', rows: parseOpenai(openaiPage()) };
    const copilot = { Provider: 'github-copilot', rows: parseCopilot(copilotPage()) };
    assert.deepEqual(pricesEndingUnfollowed([openai, copilot]), [
      { provider: 'openai', model: 'gpt-5.6-sol', from: '2026-12-01' },
      { provider: 'openai', model: 'gpt-6-astra-law', from: '2027-01-01' },
      { provider: 'github-copilot', model: 'gemini-4-argon', from: '2026-12-01' },
    ]);
    const google = { Provider: 'google', rows: parseGoogle(reroutePage()) };
    assert.deepEqual(pricesEndingUnfollowed([google]), []);
  });

  test('a page no parser reads leaves the other sheets to build', () => {
    const pages = {
      'openai-pricing': handWritten(openaiPage()),
      'openai-reasoning': handWritten('Reasoning tokens are billed as [output tokens](/docs/pricing).'),
      'cursor-pricing': handWritten(cursorPage),
    };
    const { sheets: built, failures } = buildEachSheet(pages, { previous: [], sheetDate: SHEET_DATE });
    assert.deepEqual(
      built.map(({ Provider }) => Provider),
      ['openai', 'cursor'],
    );
    assert.deepEqual(
      failures.map(({ provider }) => provider),
      ['anthropic', 'google', 'github-copilot'],
    );
    assert.ok(failures.every(({ message }) => message.length > 0));
    assert.throws(() => buildSheets(pages, { previous: [], sheetDate: SHEET_DATE }));
  });
});

describe('the price rules of a release', () => {
  const newest = readRelease(CATALOG_VERSION);
  const tokenRows = (sheet) =>
    sheet.rows.filter((row) => row.RowType === 'unit_price' && row.PricingUnit === '1000000 Tokens');

  // Computed from the rows each time, so a new model, tier or context range can never leave it behind.
  function fallbackShortfalls(sheet) {
    const fallbacks = sheet.rows.filter(({ RowType }) => RowType === 'fallback');
    const classes = new Set(tokenRows(sheet).map(({ TokenClass }) => TokenClass));
    const missing = [...classes]
      .filter((tokenClass) => !fallbacks.some(({ TokenClass }) => TokenClass === tokenClass))
      .map((tokenClass) => `no fallback for ${tokenClass}`);
    const wrong = fallbacks.flatMap(({ SkuPriceId, TokenClass, ListUnitPrice }) => {
      const prices = tokenRows(sheet).filter((row) => row.TokenClass === TokenClass);
      const highest = maxDecimal(prices.map((row) => row.ListUnitPrice));
      return compareDecimals(ListUnitPrice, highest) === 0
        ? []
        : [`${SkuPriceId} is ${ListUnitPrice}, the highest ${TokenClass} price is ${highest}`];
    });
    return [...missing, ...wrong];
  }
  const raised = (provider, change) => {
    const copy = structuredClone(newest.find(({ Provider }) => Provider === provider));
    change(copy.rows);
    return copy;
  };

  test('the fallback bounds every unit price of its sheet', () => {
    for (const candidate of [...newest, ...sheets]) {
      assert.deepEqual(fallbackProblems(candidate), [], `${candidate.CatalogVersion} ${candidate.Provider}`);
    }
    const lifted = raised('openai', (rows) => {
      const row = rows.find(({ SkuPriceId }) => SkuPriceId === 'openai:gpt-6-cyber:global:standard:to-272000:output');
      row.ListUnitPrice = '600.01';
    });
    assert.deepEqual(fallbackProblems(lifted), [
      'openai:gpt-6-cyber:global:standard:to-272000:output: 600.01 is above the output fallback 600.00',
    ]);
    const first = readRelease('0.1.0').find(({ Provider }) => Provider === 'openai');
    assert.ok(
      fallbackProblems(first).includes(
        'openai:gpt-5.5-pro:global:standard:over-272000:output: 270.00 is above the output fallback 180.00',
      ),
    );
  });

  test('every fallback equals the highest unit price of its token class in its sheet', () => {
    const ruled = releases().filter((release) => compareVersions(release, FIRST_RULED_RELEASE) >= 0);
    const candidates = [...ruled.flatMap(readRelease), ...sheets];
    assert.ok(candidates.length >= ruled.length * 5);
    for (const candidate of candidates) {
      assert.deepEqual(fallbackShortfalls(candidate), [], `${candidate.CatalogVersion} ${candidate.Provider}`);
    }
    const first = readRelease('0.1.0').find(({ Provider }) => Provider === 'openai');
    assert.ok(
      fallbackShortfalls(first).includes('openai:fallback:output is 180.00, the highest output price is 600.00'),
    );
  });

  test('no two unit_price rows overlap', () => {
    for (const candidate of [...newest, ...sheets]) {
      assert.deepEqual(overlapProblems(candidate), [], `${candidate.CatalogVersion} ${candidate.Provider}`);
    }
    const widened = raised('openai', (rows) => {
      const row = rows.find(({ SkuPriceId }) => SkuPriceId === 'openai:gpt-6-astra:global:standard:to-272000:output');
      rows.push({
        ...row,
        SkuPriceId: 'openai:gpt-6-astra:global:standard:to-300000:output',
        ContextTierMaxInputTokens: 300000,
      });
    });
    assert.deepEqual(overlapProblems(widened), [
      'openai:gpt-6-astra:global:standard:to-272000:output overlaps openai:gpt-6-astra:global:standard:to-300000:output',
      'openai:gpt-6-astra:global:standard:over-272000:output overlaps openai:gpt-6-astra:global:standard:to-300000:output',
    ]);
    const redated = raised('google', (rows) => {
      const row = rows.find(({ SkuPriceId }) => SkuPriceId === 'google:gemini-4-argon:global:standard:all:output');
      row.EffectiveEnd = '2026-12-02';
    });
    assert.deepEqual(overlapProblems(redated), [
      'google:gemini-4-argon:global:standard:all:output overlaps google:gemini-4-argon:global:standard:all:output:from-2026-12-01',
    ]);
    const cursor = readRelease('0.1.0').find(({ Provider }) => Provider === 'cursor');
    assert.ok(
      overlapProblems(cursor).includes(
        'cursor:grok-4.7:global:standard:all:input_uncached overlaps cursor:grok-4.7:global:standard:over-256000-to-500000:input_uncached',
      ),
    );
  });
});

describe('the build script', () => {
  const run = (...args) => spawnSync(process.execPath, [BUILD, ...args], { encoding: 'utf8' });
  const snapshot = (version) =>
    readdirSync(join(ROOT, 'sheets', version)).map((name) => readFileSync(join(ROOT, 'sheets', version, name), 'utf8'));

  test('refuses to write an existing release directory', () => {
    const before = snapshot(CATALOG_VERSION);
    const again = run('--version', CATALOG_VERSION);
    assert.equal(again.status, 1);
    assert.match(again.stderr, new RegExp(`sheets/${CATALOG_VERSION} exists\\. A published release never changes\\.`));
    assert.deepEqual(snapshot(CATALOG_VERSION), before);
    const older = run('--version', '0.1.1');
    assert.equal(older.status, 1);
    assert.match(older.stderr, /0\.1\.1 is not newer than the newest release/);
    assert.equal(existsSync(join(ROOT, 'sheets', '0.1.1')), false);
  });

  test('takes the release version from --version', () => {
    const missing = run();
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /not a release version: undefined/);
    assert.equal(run('--version', 'next').status, 2);
  });
});

describe('markdown and decimals', () => {
  test('moneyOf keeps the published digits', () => {
    assert.equal(moneyOf('$12.50 / MTok'), '12.50');
    assert.equal(moneyOf('$0.20 / MTok<sup>2</sup>'), '0.20');
    assert.equal(moneyOf('$2.00'), '2.00');
  });

  test('moneyOf reads a dash as no price and refuses words', () => {
    assert.equal(moneyOf('-'), null);
    assert.throws(() => moneyOf('Free'));
  });

  test('parseTables skips separator and blank rows', () => {
    const [table] = parseTables('| A | B |\n| - | -: |\n|   |    |\n| 1 | 2 |\n');
    assert.deepEqual(table.rows, [{ A: '1', B: '2' }]);
  });

  test('stripMarkup keeps a link text and drops footnote markers', () => {
    assert.equal(stripMarkup('[Grok 4.7](https://x.ai/news/grok-4-7)'), 'Grok 4.7');
    assert.equal(stripMarkup('Gemini 4 Argon[^gemini-4-argon-promo]'), 'Gemini 4 Argon');
  });

  test('decimals compare exactly past the float range', () => {
    assert.equal(compareDecimals('0.30000000000000000001', '0.3'), 1);
    assert.equal(compareDecimals('2.50', '2.5'), 0);
    assert.equal(maxDecimal(['9.5', '12.50', '10']), '12.50');
  });

  test('per-token prices become per-million decimal strings', () => {
    assert.equal(perTokenToPerMillion(4e-6), '4');
    assert.equal(perTokenToPerMillion(3.125e-7), '0.3125');
    assert.equal(perTokenToPerMillion('0.00000125'), '1.25');
    assert.equal(perTokenToPerMillion(0.00015), '150');
  });
});

describe('Anthropic sheet, read against the page by hand', needsPages, () => {
  test('carries the four current models at every published class', () => {
    assert.deepEqual(
      ['input_uncached', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output'].map((tokenClass) =>
        price('anthropic', 'claude-opus-5-5', tokenClass),
      ),
      ['4', '5', '8', '0.20', '20'],
    );
    assert.deepEqual(
      ['input_uncached', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output'].map((tokenClass) =>
        price('anthropic', 'claude-fable-5-1', tokenClass),
      ),
      ['10', '12.50', '20', '0.25', '50'],
    );
    assert.deepEqual(
      ['input_uncached', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output'].map((tokenClass) =>
        price('anthropic', 'claude-sonnet-5-5', tokenClass),
      ),
      ['2', '2.50', '4', '0.10', '10'],
    );
  });

  test('prices Claude Haiku 5.5 by prompt length', () => {
    const short = { ContextTierMaxInputTokens: 100000 };
    const long = { ContextTierMinInputTokens: 100000 };
    assert.equal(price('anthropic', 'claude-haiku-5-5', 'input_uncached', short), '0.10');
    assert.equal(price('anthropic', 'claude-haiku-5-5', 'cache_read', short), '0.01');
    assert.equal(price('anthropic', 'claude-haiku-5-5', 'output', short), '0.50');
    assert.equal(price('anthropic', 'claude-haiku-5-5', 'input_uncached', long), '0.50');
    assert.equal(price('anthropic', 'claude-haiku-5-5', 'cache_write_5m', long), '0.625');
    assert.equal(price('anthropic', 'claude-haiku-5-5', 'output', { ...long, ServiceTier: 'batch' }), '1.25');
  });

  test('carries batch and fast rows only where the page prints them', () => {
    assert.equal(price('anthropic', 'claude-opus-5-5', 'input_uncached', { ServiceTier: 'batch' }), '2');
    assert.equal(price('anthropic', 'claude-opus-5-5', 'output', { ServiceTier: 'fast' }), '40');
    assert.equal(price('anthropic', 'claude-opus-4-8', 'input_uncached', { ServiceTier: 'fast' }), '10');
    const fastModels = new Set(
      sheet('anthropic')
        .rows.filter((row) => row.ServiceTier === 'fast')
        .map((row) => row.ModelId),
    );
    assert.deepEqual([...fastModels].sort(), [
      'claude-fable-5-2',
      'claude-mythos-5-2',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
    ]);
    assert.equal(rowById('anthropic:claude-opus-5-5:global:batch:all:cache_read'), undefined);
  });

  test('takes ids and status from the model status page', () => {
    assert.equal(priceOf('anthropic', 'claude-opus-4-20250514', 'input_uncached').ModelStatus, 'retired');
    assert.equal(priceOf('anthropic', 'claude-sonnet-4-5-20250929', 'output').ModelStatus, 'deprecated');
    assert.equal(priceOf('anthropic', 'claude-mythos-5-1', 'output').ModelStatus, 'limited');
  });

  test('keeps Claude Haiku 3.5, which the page no longer lists, as the previous release read it', () => {
    const kept = priceOf('anthropic', 'claude-3-5-haiku-20241022', 'output');
    assert.equal(kept.ModelName, 'Claude Haiku 3.5');
    assert.equal(kept.ModelStatus, 'retired');
    const before = readRelease(PREVIOUS).flatMap(({ rows }) => rows);
    assert.deepEqual(
      kept,
      before.find(({ SkuPriceId }) => SkuPriceId === kept.SkuPriceId),
    );
    assert.ok(!pages['anthropic-pricing'].text.includes('Claude Haiku 3.5'));
    const { leftThePage } = releaseDiff(readRelease('0.1.0'), sheets);
    assert.ok(leftThePage.some(({ row }) => row.SkuPriceId === kept.SkuPriceId));
    assert.ok(
      leftThePage.some(({ row }) => row.SkuPriceId === 'anthropic:tool-overhead:claude-3-5-haiku-20241022:auto_none'),
    );
  });

  test('carries the residency multiplier for Claude 4.6 and later only', () => {
    const { Multiplier, AppliesToModels } = rowById('anthropic:multiplier:data-residency-us');
    assert.equal(Multiplier, '1.1');
    assert.ok(AppliesToModels.includes('claude-opus-5-5'));
    assert.ok(AppliesToModels.includes('claude-sonnet-4-6'));
    assert.ok(!AppliesToModels.includes('claude-haiku-4-5-20251001'));
    assert.ok(!AppliesToModels.includes('claude-opus-4-5-20251101'));
  });

  test('carries the model-specific cache read multipliers', () => {
    assert.equal(rowById('anthropic:multiplier:prompt-cache-read').Multiplier, '0.1');
    assert.equal(rowById('anthropic:multiplier:prompt-cache-read-claude-fable-5-1').Multiplier, '0.025');
    assert.deepEqual(rowById('anthropic:multiplier:prompt-cache-read-claude-fable-5-2').AppliesToModels, [
      'claude-fable-5-2',
      'claude-mythos-5-2',
    ]);
    assert.deepEqual(rowById('anthropic:multiplier:prompt-cache-read-claude-opus-5-5').AppliesToModels, [
      'claude-opus-5-5',
    ]);
    assert.equal(rowById('anthropic:multiplier:prompt-cache-read-claude-sonnet-5-5').Multiplier, '0.05');
  });

  test('carries Claude Fable 5.2 and Claude Mythos 5.2 at every tier the page prints', () => {
    for (const model of ['claude-fable-5-2', 'claude-mythos-5-2']) {
      assert.deepEqual(
        ['input_uncached', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output'].map((tokenClass) =>
          price('anthropic', model, tokenClass),
        ),
        ['8', '10', '16', '0.20', '40'],
      );
      assert.equal(price('anthropic', model, 'input_uncached', { ServiceTier: 'batch' }), '4');
      assert.equal(price('anthropic', model, 'output', { ServiceTier: 'batch' }), '20');
      assert.equal(price('anthropic', model, 'input_uncached', { ServiceTier: 'fast' }), '16');
      assert.equal(price('anthropic', model, 'output', { ServiceTier: 'fast' }), '80');
    }
    assert.equal(priceOf('anthropic', 'claude-mythos-5-2', 'output', { ServiceTier: 'fast' }).ModelStatus, 'limited');
    assert.equal(rowById('anthropic:fallback:input_uncached').ListUnitPrice, '16');
    assert.equal(rowById('anthropic:fallback:output').ListUnitPrice, '80');
  });

  test('leaves a blank tool overhead cell without a row', () => {
    assert.equal(rowById('anthropic:tool-overhead:claude-opus-5-5:auto_none').OverheadTokens, 286);
    assert.equal(rowById('anthropic:tool-overhead:claude-opus-5-5:any_tool'), undefined);
    assert.equal(rowById('anthropic:tool-overhead:claude-opus-5:any_tool').OverheadTokens, 406);
  });
});

describe('OpenAI sheet, read against the page by hand', needsPages, () => {
  const short = { ContextTierMaxInputTokens: 272000 };
  const long = { ContextTierMinInputTokens: 272000 };

  test('splits short and long context at 272K', () => {
    assert.equal(price('openai', 'gpt-6.1-sol', 'input_uncached', short), '2.00');
    assert.equal(price('openai', 'gpt-6.1-sol', 'cache_read', short), '0.10');
    assert.equal(price('openai', 'gpt-6.1-sol', 'output', long), '15.00');
  });

  test('carries the published 30-minute and 12-hour cache writes', () => {
    assert.equal(price('openai', 'gpt-6-astra', 'cache_write_30m', short), '12.50');
    assert.equal(price('openai', 'gpt-6-astra', 'cache_write_12h', long), '50.00');
  });

  test('carries every tier the page prints', () => {
    assert.equal(price('openai', 'gpt-6-astra', 'input_uncached', { ...short, ServiceTier: 'batch' }), '5.00');
    assert.equal(price('openai', 'gpt-6-astra', 'input_uncached', { ...short, ServiceTier: 'flex' }), '5.00');
    assert.equal(price('openai', 'gpt-6-astra', 'input_uncached', { ...short, ServiceTier: 'fast' }), '20.00');
    assert.equal(price('openai', 'gpt-6-astra', 'input_uncached', { ...short, ServiceTier: 'ultrafast' }), '60.00');
    assert.equal(price('openai', 'gpt-5.3-codex', 'output', { ServiceTier: 'fast' }), '28.00');
  });

  test('carries gpt-6-cyber at both context lengths from the Specialized models table', () => {
    assert.deepEqual(
      ['input_uncached', 'output', 'cache_read', 'cache_write_30m', 'cache_write_12h'].map((tokenClass) =>
        price('openai', 'gpt-6-cyber', tokenClass, short),
      ),
      ['20.00', '100.00', '2.00', '25.00', '50.00'],
    );
    assert.deepEqual(
      ['input_uncached', 'output', 'cache_read'].map((tokenClass) => price('openai', 'gpt-6-cyber', tokenClass, long)),
      ['40.00', '150.00', '4.00'],
    );
    assert.equal(rowById('openai:gpt-6-cyber:global:standard:over-272000:cache_write_30m'), undefined);
    assert.equal(price('openai', 'gpt-5.5-cyber-preview', 'output', short), '75.00');
  });

  test('keeps the page digit where it rounds', () => {
    assert.equal(price('openai', 'gpt-5.4', 'cache_read', { ...short, ServiceTier: 'batch' }), '0.13');
  });

  test('a dash in the page leaves no row', () => {
    assert.equal(rowById('openai:gpt-5.5-pro:global:standard:to-272000:cache_read'), undefined);
    assert.equal(rowById('openai:gpt-5.5-pro:global:batch:over-272000:input_uncached'), undefined);
  });

  test('a model listed in two sections is one row, ending with its promotion', () => {
    const sol = priceOf('openai', 'gpt-5.6-sol', 'input_uncached', short);
    assert.equal(sol.ListUnitPrice, '4.00');
    assert.equal(sol.Note, 'Promotional price, available until November 30, 2026.');
    assert.equal(sol.EffectiveEnd, '2026-12-01');
  });

  test('reads no fine-tuned price as a base price', () => {
    for (const id of ['gpt-4.1-2025-04-14', 'gpt-4o-2024-08-06'])
      assert.ok(!sheet('openai').rows.some((row) => row.ModelId === id), id);
  });

  test('takes no embedding, image or realtime row', () => {
    const models = new Set(sheet('openai').rows.map((row) => row.ModelId));
    for (const id of ['text-embedding-3-small', 'gpt-image-2', 'gpt-realtime-2', 'omni-moderation-latest'])
      assert.ok(!models.has(id), id);
  });
});

describe('Google sheet, read against the page by hand', needsPages, () => {
  test('a cell with two dated steps gives two ranges', () => {
    assert.deepEqual(googleParser.readPriceCell('$2.00 through November 30, 2026. $4.00 starting December 1, 2026.'), [
      { amount: '2.00', storage: false, EffectiveEnd: '2026-12-01' },
      { amount: '4.00', storage: false, EffectiveStart: '2026-12-01' },
    ]);
  });

  test('a cell with prompt tiers and storage gives three prices', () => {
    assert.deepEqual(
      googleParser.readPriceCell(
        '$0.20, prompts <= 200k tokens $0.40, prompts > 200k $4.50 / 1,000,000 tokens per hour (storage price)',
      ),
      [
        { amount: '0.20', storage: false, ContextTierMaxInputTokens: 200000 },
        { amount: '0.40', storage: false, ContextTierMinInputTokens: 200000 },
        { amount: '4.50', storage: true },
      ],
    );
  });

  test('an audio rate beside a text rate is left out', () => {
    assert.deepEqual(
      googleParser.readPriceCell('$0.25 (text / image / video) $0.50 (audio)').map(({ amount }) => amount),
      ['0.25'],
    );
  });

  test('an unread qualifier stops the build', () => {
    assert.throws(() => googleParser.readPriceCell('$1.00 per fortnight'), /unread qualifier/);
  });

  test('carries the scheduled Gemini 4 Argon rise as two rows', () => {
    const now = priceOf('google', 'gemini-4-argon', 'input_uncached', { EffectiveEnd: '2026-12-01' });
    assert.equal(now.ListUnitPrice, '2.00');
    const later = priceOf('google', 'gemini-4-argon', 'input_uncached', { EffectiveStart: '2026-12-01' });
    assert.equal(later.ListUnitPrice, '4.00');
    assert.equal(later.EffectiveEnd, null);
  });

  test('carries Gemini 4 Carbon at both dated prices in every tier', () => {
    const published = {
      standard: [
        ['2.00', '10.00', '0.10'],
        ['4.00', '20.00', '0.20'],
      ],
      batch: [
        ['1.00', '5.00', '0.05'],
        ['2.00', '10.00', '0.10'],
      ],
      flex: [
        ['1.00', '5.00', '0.05'],
        ['2.00', '10.00', '0.10'],
      ],
      priority: [
        ['3.60', '18.00', '0.18'],
        ['7.20', '36.00', '0.36'],
      ],
    };
    for (const [ServiceTier, [now, later]] of Object.entries(published)) {
      const read = (scope) =>
        ['input_uncached', 'output', 'cache_read'].map((tokenClass) =>
          price('google', 'gemini-4-carbon', tokenClass, { ServiceTier, ...scope }),
        );
      assert.deepEqual(read({ EffectiveEnd: '2026-12-01' }), now, ServiceTier);
      assert.deepEqual(read({ EffectiveStart: '2026-12-01', EffectiveEnd: null }), later, ServiceTier);
    }
  });

  test('carries a dual-id model under both ids', () => {
    assert.equal(
      price('google', 'gemini-3.1-pro-preview', 'input_uncached', { ContextTierMaxInputTokens: 200000 }),
      '2.00',
    );
    assert.equal(
      price('google', 'gemini-3.1-pro-preview-customtools', 'output', { ContextTierMinInputTokens: 200000 }),
      '18.00',
    );
  });

  test('prices hourly cache storage in its own unit', () => {
    const row = priceOf('google', 'gemini-3.1-pro-preview', 'cache_storage');
    assert.equal(row.ListUnitPrice, '4.50');
    assert.equal(row.PricingUnit, '1000000 Token-Hours');
  });

  test('takes the page word for its priority tier', () => {
    assert.equal(
      price('google', 'gemini-4-argon', 'input_uncached', { ServiceTier: 'priority', EffectiveEnd: '2026-12-01' }),
      '3.60',
    );
  });

  test('marks a model the page calls deprecated', () => {
    assert.equal(
      priceOf('google', 'gemini-2.5-pro', 'output', { ContextTierMaxInputTokens: 200000 }).ModelStatus,
      'deprecated',
    );
    assert.equal(priceOf('google', 'gemini-4-argon', 'output', { EffectiveEnd: '2026-12-01' }).ModelStatus, 'unstated');
  });
});

describe('Copilot sheet, read against the page by hand', needsPages, () => {
  test('states the AI credit rate', () => {
    assert.equal(rowById('github-copilot:credit:ai-credit').ListUnitPrice, '0.01');
  });

  test('carries thresholds as printed, model by model', () => {
    assert.equal(
      price('github-copilot', 'gpt-5.6-luna', 'input_uncached', { ContextTierMaxInputTokens: 200000 }),
      '0.20',
    );
    assert.equal(price('github-copilot', 'gpt-5.6-sol', 'output', { ContextTierMinInputTokens: 272000 }), '30.00');
  });

  test('a footnoted promotion ends where the footnote says', () => {
    assert.equal(priceOf('github-copilot', 'gemini-3.8-flash', 'input_uncached').EffectiveEnd, '2027-01-01');
    assert.equal(priceOf('github-copilot', 'gemini-4-argon', 'output').EffectiveEnd, '2026-12-01');
  });

  test('carries Gemini 4 Carbon from December 1, 2026 at the price its footnote states', () => {
    const later = { EffectiveStart: '2026-12-01' };
    assert.deepEqual(
      ['input_uncached', 'cache_read', 'output'].map((tokenClass) =>
        price('github-copilot', 'gemini-4-carbon', tokenClass, later),
      ),
      ['4.00', '0.20', '20.00'],
    );
    assert.equal(
      priceOf('github-copilot', 'gemini-4-carbon', 'output', { EffectiveEnd: '2026-12-01' }).ListUnitPrice,
      '10.00',
    );
    assert.equal(rowById('github-copilot:gemini-4-argon:global:standard:all:output:from-2026-12-01'), undefined);
    assert.equal(price('github-copilot', 'claude-fable-5.2', 'output'), '40.00');
  });

  test('reads fast mode out of the model name', () => {
    assert.equal(price('github-copilot', 'claude-opus-4.8', 'input_uncached', { ServiceTier: 'fast' }), '10.00');
    assert.equal(price('github-copilot', 'claude-opus-4.8', 'input_uncached'), '5.00');
  });

  test('carries the legacy request rate and multipliers', () => {
    assert.equal(rowById('github-copilot:fee:premium-request').ListUnitPrice, '0.04');
    assert.equal(rowById('github-copilot:request-multiplier:claude-opus-4.8').Multiplier, '27');
  });
});

describe('Cursor sheet, read against the page by hand', needsPages, () => {
  test('reads a windowed model as a context tier', () => {
    const plain = priceOf('cursor', 'grok-4.7', 'input_uncached', { ContextTierMinInputTokens: null });
    assert.equal(plain.ListUnitPrice, '2');
    assert.equal(plain.ContextTierMaxInputTokens, 256000);
    const windowed = priceOf('cursor', 'grok-4.7', 'input_uncached', { ContextTierMinInputTokens: 256000 });
    assert.equal(windowed.ListUnitPrice, '4');
    assert.equal(windowed.ContextTierMaxInputTokens, 500000);
    assert.equal(price('cursor', 'claude-4-sonnet', 'output', { ContextTierMinInputTokens: 200000 }), '22.5');
  });

  test('reads Fast as a tier in all three spellings', () => {
    assert.equal(price('cursor', 'composer-2.5', 'output', { ServiceTier: 'fast' }), '15');
    assert.equal(price('cursor', 'gpt-5', 'input_uncached', { ServiceTier: 'fast' }), '2.5');
    assert.equal(price('cursor', 'claude-opus-4.7', 'input_uncached', { ServiceTier: 'fast' }), '30');
  });

  test('carries the token rate with the models its rule exempts', () => {
    const row = rowById('cursor:additive:cursor-token-rate');
    assert.equal(row.ListUnitPrice, '0.25');
    assert.ok(row.ExcludedModels.includes('claude-haiku-5.5'));
    assert.ok(row.ExcludedModels.includes('deepseek-v4.1-flash-1017'));
    assert.ok(!row.ExcludedModels.includes('claude-opus-5.5'));
    assert.ok(!row.ExcludedModels.some((id) => id.startsWith('grok') || id.startsWith('composer')));
  });

  test('ends GPT-5.6 Sol after its promotion and prices Gemini 4 Carbon from December 1, 2026', () => {
    assert.equal(priceOf('cursor', 'gpt-5.6-sol', 'output').EffectiveEnd, '2026-11-22');
    assert.equal(rowById('cursor:gpt-5.6-sol:global:standard:all:output:from-2026-11-22'), undefined);
    const later = { EffectiveStart: '2026-12-01' };
    assert.deepEqual(
      ['input_uncached', 'cache_read', 'output'].map((tokenClass) =>
        price('cursor', 'gemini-4-carbon', tokenClass, later),
      ),
      ['4', '0.20', '20'],
    );
    assert.equal(
      priceOf('cursor', 'gemini-4-carbon', 'input_uncached', { EffectiveEnd: '2026-12-01' }).ListUnitPrice,
      '2',
    );
  });

  test('the residency multiplier names only models marked Yes', () => {
    const { AppliesToModels } = rowById('cursor:multiplier:data-residency-us');
    assert.ok(AppliesToModels.includes('claude-opus-5.5'));
    assert.ok(!AppliesToModels.includes('gemini-3.1-pro'));
  });
});

describe('every sheet', needsPages, () => {
  test('the committed sheets are what the saved pages build to', () => {
    for (const built of sheets) {
      const committed = readFileSync(join(ROOT, 'sheets', CATALOG_VERSION, sheetFileName(built)), 'utf8');
      assert.equal(committed, renderSheet(built), sheetFileName(built));
    }
  });

  test('every price appears on the page its row cites', () => {
    const byHash = new Map(Object.values(pages).map((page) => [page.sha256, page.text]));
    const before = new Map(readRelease(PREVIOUS).flatMap(({ rows }) => rows.map((row) => [row.SkuPriceId, row])));
    for (const { rows } of sheets) {
      for (const row of rows.filter(({ RowType }) =>
        ['unit_price', 'fee', 'credit_rate', 'additive_rate'].includes(RowType),
      )) {
        const text = byHash.get(row.SourceSha256);
        if (text === undefined) assert.deepEqual(row, before.get(row.SkuPriceId), `${row.SkuPriceId} is kept as read`);
        else assert.ok(text.includes(`$${row.ListUnitPrice}`), `${row.SkuPriceId} ${row.ListUnitPrice}`);
      }
    }
  });

  test('has a non-zero fallback for input and output', () => {
    for (const { Provider, rows } of sheets) {
      const fallback = rows.filter(({ RowType }) => RowType === 'fallback');
      for (const tokenClass of ['input_uncached', 'output']) {
        const row = fallback.find(({ TokenClass }) => TokenClass === tokenClass);
        assert.ok(row, `${Provider} ${tokenClass}`);
        assert.equal(compareDecimals(row.ListUnitPrice, '0'), 1);
      }
    }
  });

  test('every fallback is the highest price of its class and cites the row that sets it', () => {
    for (const { rows } of sheets) {
      for (const fallback of rows.filter(({ RowType }) => RowType === 'fallback')) {
        const top = rows.find(({ SkuPriceId }) => fallback.FallbackBasis.endsWith(`Set by ${SkuPriceId}.`));
        assert.equal(top.ListUnitPrice, fallback.ListUnitPrice, fallback.SkuPriceId);
        assert.equal(top.SourceSha256, fallback.SourceSha256, fallback.SkuPriceId);
      }
    }
    assert.equal(rowById('anthropic:fallback:output').ListUnitPrice, '80');
    assert.equal(rowById('openai:fallback:output').ListUnitPrice, '600.00');
    assert.equal(rowById('openai:fallback:cache_read').ListUnitPrice, '12.00');
    assert.equal(rowById('google:fallback:input_uncached').ListUnitPrice, '7.20');
  });
});

describe('the scrape job', needsPages, () => {
  const changed = (id, from, to) => ({ ...pages, [id]: { ...pages[id], text: pages[id].text.replace(from, to) } });

  test('a changed page shows in the diff with both figures', () => {
    const moved = changed('anthropic-pricing', /(\| Claude Opus 5\.5 +\| )\$4 \/ MTok/, '$1$5 / MTok');
    const diff = diffSheets(sheets, buildSheets(moved).sheets);
    const row = diff.changed.find(({ id }) => id === 'anthropic:claude-opus-5-5:global:standard:all:input_uncached');
    assert.deepEqual(row.fields, [{ field: 'ListUnitPrice', before: '4', after: '5' }]);
    assert.match(
      renderDiff(diff, { version: '0.2.1', previous: CATALOG_VERSION }),
      /claude-opus-5-5.*ListUnitPrice \| "4" \| "5"/,
    );
  });

  test('a new page row shows as added and a dropped one as removed', () => {
    const moved = changed('openai-pricing', /^\|[^\n]*\| gpt-6-cyber \((?:short|long) context\) \|[^\n]*\n/gm, '');
    const id = 'openai:gpt-6-cyber:global:standard:to-272000:output';
    const { removed } = diffSheets(sheets, buildSheets(moved, { previous: [] }).sheets);
    assert.ok(removed.some(({ row }) => row.SkuPriceId === id));
    const kept = diffSheets(sheets, buildSheets(moved, { previous: sheets }).sheets);
    assert.ok(!kept.removed.some(({ row }) => row.SkuPriceId === id));
  });

  test('a page that lost its table stops the build instead of emptying a sheet', () => {
    assert.throws(() => buildSheets(changed('anthropic-pricing', 'Base input tokens', 'Input')), /no table/);
    assert.throws(
      () => buildSheets(changed('cursor-pricing', /\| US data residency \|/g, '| Residency |')),
      /expected two model tables/,
    );
  });

  test('a renamed OpenAI section stops the build', () => {
    assert.throws(
      () => buildSheets(changed('openai-pricing', '\nFine-tuning\n', '\nFinetuning\n')),
      /unknown heading "Finetuning"/,
    );
  });

  test('no cross-check snapshot reaches a parser', () => {
    assert.deepEqual(Object.keys(pages).sort(), PAGES.map(({ id }) => id).sort());
  });

  // A copy of the saved pages in a temporary directory, as the watch fetches them, with edits of its own.
  function watchCopy() {
    const directory = mkdtempSync(join(tmpdir(), 'catalog-watch-'));
    let sources = loadSources();
    cpSync(join(TESTDATA, 'pages'), join(directory, 'pages'), { recursive: true });
    writeFileSync(join(directory, 'SOURCES.json'), JSON.stringify(sources));
    return {
      edit(id, from, to) {
        const source = sources.find((candidate) => candidate.id === id);
        const path = join(directory, source.file);
        const before = readFileSync(path, 'utf8');
        const text = before.replace(from, to);
        assert.notEqual(text, before, `${id}: ${from} is not on the page`);
        writeFileSync(path, text);
        const sha256 = createHash('sha256').update(text).digest('hex');
        sources = sources.map((candidate) => (candidate === source ? { ...source, sha256 } : candidate));
        writeFileSync(join(directory, 'SOURCES.json'), JSON.stringify(sources));
      },
      watch: () => spawnSync(process.execPath, [BUILD, '--diff', '--pages', directory], { encoding: 'utf8' }),
      remove: () => rmSync(directory, { recursive: true, force: true }),
    };
  }

  test('the watch fails with the row diff when a price moves', () => {
    const copy = watchCopy();
    try {
      const clean = copy.watch();
      assert.equal(clean.status, 0, clean.stderr);
      assert.match(clean.stdout, new RegExp(`build to the rows of ${CATALOG_VERSION.replaceAll('.', '\\.')}`));

      copy.edit(
        'openai-pricing',
        '| gpt-6-cyber (short context) | $20.00 |',
        '| gpt-6-cyber (short context) | $21.00 |',
      );
      const watch = copy.watch();
      assert.equal(watch.status, 1);
      assert.equal(watch.stdout.split('\n')[0], 'prices changed');
      assert.match(
        watch.stdout,
        /`openai:gpt-6-cyber:global:standard:to-272000:input_uncached` \| ListUnitPrice \| "20\.00" \| "21\.00"/,
      );
    } finally {
      copy.remove();
    }
  });

  test('the watch names the parser that cannot read its page and still diffs the others', () => {
    const copy = watchCopy();
    try {
      copy.edit('openai-pricing', '\nTools\n', '\nBuilt-in tools\n');
      const shape = copy.watch();
      assert.equal(shape.status, 1);
      const [first, second] = shape.stdout.split('\n');
      assert.equal(first, 'page shape changed');
      assert.match(second, /^The openai parser cannot read its page: openai: unknown heading "Built-in tools"/);
      assert.match(
        shape.stdout,
        /The sheets that built \(anthropic, google, github-copilot, cursor\) build to the rows of/,
      );
      assert.doesNotMatch(shape.stdout, /`openai:/);

      copy.edit('anthropic-pricing', /(\| Claude Opus 5\.5 +\| )\$4 \/ MTok/, '$1$5 / MTok');
      const both = copy.watch();
      assert.equal(both.status, 1);
      assert.equal(both.stdout.split('\n')[0], 'page shape changed and prices changed');
      assert.match(
        both.stdout,
        /`anthropic:claude-opus-5-5:global:standard:all:input_uncached` \| ListUnitPrice \| "4" \| "5"/,
      );
      assert.doesNotMatch(both.stdout, /`openai:/);
    } finally {
      copy.remove();
    }
  });
});

describe('the cross-check', needsPages, () => {
  const sources = loadSources();
  const snapshot = (id) =>
    JSON.parse(readFileSync(join(TESTDATA, sources.find((source) => source.id === id).file), 'utf8'));
  const run = (candidate) =>
    buildCrosscheck({
      sheets: candidate,
      litellm: snapshot('litellm-map'),
      openrouter: snapshot('openrouter-listing'),
      sources,
      version: CATALOG_VERSION,
    });

  test('a sheet price that moves becomes a finding against both sources', () => {
    const tampered = sheets.map((candidate) => ({
      ...candidate,
      rows: candidate.rows.map((row) =>
        row.SkuPriceId === 'anthropic:claude-opus-5-5:global:standard:all:output'
          ? { ...row, ListUnitPrice: '21' }
          : row,
      ),
    }));
    const { lite, router } = run(tampered);
    assert.deepEqual(lite.disagreements, [
      { id: 'anthropic:claude-opus-5-5:global:standard:all:output', ours: '21', theirs: '20' },
    ]);
    assert.ok(
      router.disagreements.some(
        ({ id, theirs }) => id.endsWith('claude-opus-5-5:global:standard:all:output') && theirs === '20',
      ),
    );
  });

  test('the committed report is what the snapshots produce', () => {
    assert.equal(readFileSync(join(ROOT, 'reports', `${CATALOG_VERSION}-crosscheck.md`), 'utf8'), run(sheets).markdown);
  });

  test('every recorded disagreement has been read', () => {
    const { markdown } = run(sheets);
    assert.ok(!markdown.includes('Unread.'));
  });
});

describe('the schema and validator', () => {
  const schema = JSON.parse(readFileSync(join(ROOT, 'schema', 'v0.1', 'catalog.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const published = readRelease(CATALOG_VERSION).find(({ Provider }) => Provider === 'anthropic');
  const mutate = (change) => {
    const copy = structuredClone(published);
    change(copy);
    return validate(copy);
  };
  const first = (rows, type) => rows.find(({ RowType }) => RowType === type);

  test('accepts a published sheet', () => {
    assert.equal(validate(published), true);
  });

  test('refuses a price written as a number', () => {
    assert.equal(
      mutate(({ rows }) => {
        first(rows, 'unit_price').ListUnitPrice = 4;
      }),
      false,
    );
  });

  test('refuses a zero price', () => {
    assert.equal(
      mutate(({ rows }) => {
        first(rows, 'unit_price').ListUnitPrice = '0.00';
      }),
      false,
    );
  });

  test('refuses a zero fallback', () => {
    assert.equal(
      mutate(({ rows }) => {
        first(rows, 'fallback').ListUnitPrice = '0';
      }),
      false,
    );
  });

  test('refuses a sheet with no fallback', () => {
    assert.equal(
      mutate((copy) => {
        copy.rows = copy.rows.filter(({ RowType }) => RowType !== 'fallback');
      }),
      false,
    );
  });

  test('refuses a row with no page hash', () => {
    assert.equal(
      mutate(({ rows }) => {
        delete first(rows, 'unit_price').SourceSha256;
      }),
      false,
    );
  });

  test('refuses an unknown column', () => {
    assert.equal(
      mutate(({ rows }) => {
        first(rows, 'unit_price').Discount = '0.5';
      }),
      false,
    );
  });

  test('scripts/validate.mjs exits 0 on the committed sheets', () => {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'validate.mjs')], { stdio: 'pipe' });
  });

  test('scripts/validate.mjs exits 1 when a saved page changes under a row', needsPages, () => {
    const copy = mkdtempSync(join(tmpdir(), 'catalog-'));
    try {
      for (const path of ['scripts', 'schema', 'sheets', 'reports', 'node_modules', 'package.json'])
        cpSync(join(ROOT, path), join(copy, path), { recursive: true });
      writeFileSync(join(copy, 'scripts/scrape/testdata/pages/anthropic-pricing.md'), 'x', { flag: 'a' });
      const result = spawnSync(process.execPath, [join(copy, 'scripts', 'validate.mjs')], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /anthropic-pricing\.md: saved bytes match no source record/);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
