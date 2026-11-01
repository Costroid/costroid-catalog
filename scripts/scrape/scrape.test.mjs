import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildCrosscheck } from './lib/crosscheck.mjs';
import { compareDecimals, maxDecimal, perTokenToPerMillion } from './lib/decimal.mjs';
import { diffSheets, renderDiff } from './lib/diff.mjs';
import { moneyOf, parseTables, stripMarkup } from './lib/markdown.mjs';
import {
  buildSheets,
  CATALOG_VERSION,
  loadPages,
  loadSources,
  renderSheet,
  ROOT,
  sheetFileName,
  TESTDATA,
} from './lib/sheets.mjs';
import { readPriceCell } from './parsers/google.mjs';
import { PAGES } from './sources.mjs';

const pages = loadPages();
const { sheets } = buildSheets(pages);
const sheet = (provider) => sheets.find(({ Provider }) => Provider === provider);

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

describe('Anthropic sheet, read against the page by hand', () => {
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
    assert.deepEqual([...fastModels].sort(), ['claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5']);
    assert.equal(rowById('anthropic:claude-opus-5-5:global:batch:all:cache_read'), undefined);
  });

  test('takes ids and status from the model status page', () => {
    assert.equal(priceOf('anthropic', 'claude-opus-4-20250514', 'input_uncached').ModelStatus, 'retired');
    assert.equal(priceOf('anthropic', 'claude-3-5-haiku-20241022', 'output').ModelName, 'Claude Haiku 3.5');
    assert.equal(priceOf('anthropic', 'claude-sonnet-4-5-20250929', 'output').ModelStatus, 'deprecated');
    assert.equal(priceOf('anthropic', 'claude-mythos-5-1', 'output').ModelStatus, 'limited');
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
    assert.deepEqual(rowById('anthropic:multiplier:prompt-cache-read-claude-opus-5-5').AppliesToModels, [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ]);
  });

  test('leaves a blank tool overhead cell without a row', () => {
    assert.equal(rowById('anthropic:tool-overhead:claude-opus-5-5:auto_none').OverheadTokens, 286);
    assert.equal(rowById('anthropic:tool-overhead:claude-opus-5-5:any_tool'), undefined);
    assert.equal(rowById('anthropic:tool-overhead:claude-opus-5:any_tool').OverheadTokens, 406);
  });
});

describe('OpenAI sheet, read against the page by hand', () => {
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

  test('keeps the page digit where it rounds', () => {
    assert.equal(price('openai', 'gpt-5.4', 'cache_read', { ...short, ServiceTier: 'batch' }), '0.13');
  });

  test('a dash in the page leaves no row', () => {
    assert.equal(rowById('openai:gpt-5.5-pro:global:standard:to-272000:cache_read'), undefined);
    assert.equal(rowById('openai:gpt-5.5-pro:global:batch:over-272000:input_uncached'), undefined);
  });

  test('a model listed in two sections is one row', () => {
    assert.equal(price('openai', 'gpt-5.6-sol', 'input_uncached', short), '4.00');
    assert.match(priceOf('openai', 'gpt-5.6-sol', 'input_uncached', short).Note, /November 21, 2026/);
  });

  test('takes no embedding, image or realtime row', () => {
    const models = new Set(sheet('openai').rows.map((row) => row.ModelId));
    for (const id of ['text-embedding-3-small', 'gpt-image-2', 'gpt-realtime-2', 'omni-moderation-latest'])
      assert.ok(!models.has(id), id);
  });
});

describe('Google sheet, read against the page by hand', () => {
  test('a cell with two dated steps gives two ranges', () => {
    assert.deepEqual(readPriceCell('$2.00 through November 30, 2026. $4.00 starting December 1, 2026.'), [
      { amount: '2.00', storage: false, EffectiveEnd: '2026-12-01' },
      { amount: '4.00', storage: false, EffectiveStart: '2026-12-01' },
    ]);
  });

  test('a cell with prompt tiers and storage gives three prices', () => {
    assert.deepEqual(
      readPriceCell(
        '$0.20, prompts \\<= 200k tokens $0.40, prompts \\> 200k $4.50 / 1,000,000 tokens per hour (storage price)',
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
      readPriceCell('$0.25 (text / image / video) $0.50 (audio)').map(({ amount }) => amount),
      ['0.25'],
    );
  });

  test('an unread qualifier stops the build', () => {
    assert.throws(() => readPriceCell('$1.00 per fortnight'), /unread qualifier/);
  });

  test('carries the scheduled Gemini 4 Argon rise as two rows', () => {
    const now = priceOf('google', 'gemini-4-argon', 'input_uncached', { EffectiveEnd: '2026-12-01' });
    assert.equal(now.ListUnitPrice, '2.00');
    const later = priceOf('google', 'gemini-4-argon', 'input_uncached', { EffectiveStart: '2026-12-01' });
    assert.equal(later.ListUnitPrice, '4.00');
    assert.equal(later.EffectiveEnd, null);
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
});

describe('Copilot sheet, read against the page by hand', () => {
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

  test('reads fast mode out of the model name', () => {
    assert.equal(price('github-copilot', 'claude-opus-4.8', 'input_uncached', { ServiceTier: 'fast' }), '10.00');
    assert.equal(price('github-copilot', 'claude-opus-4.8', 'input_uncached'), '5.00');
  });

  test('carries the legacy request rate and multipliers', () => {
    assert.equal(rowById('github-copilot:fee:premium-request').ListUnitPrice, '0.04');
    assert.equal(rowById('github-copilot:request-multiplier:claude-opus-4.8').Multiplier, '27');
  });
});

describe('Cursor sheet, read against the page by hand', () => {
  test('reads a windowed model as a context tier', () => {
    assert.equal(price('cursor', 'grok-4.7', 'input_uncached', { ContextTierMinInputTokens: null }), '2');
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

  test('carries the token rate with its exclusions', () => {
    const row = rowById('cursor:additive:cursor-token-rate');
    assert.equal(row.ListUnitPrice, '0.25');
    assert.ok(row.ExcludedModels.includes('claude-haiku-5.5'));
  });

  test('the residency multiplier names only models marked Yes', () => {
    const { AppliesToModels } = rowById('cursor:multiplier:data-residency-us');
    assert.ok(AppliesToModels.includes('claude-opus-5.5'));
    assert.ok(!AppliesToModels.includes('gemini-3.1-pro'));
  });
});

describe('every sheet', () => {
  test('the committed sheets are what the saved pages build to', () => {
    for (const built of sheets) {
      const committed = readFileSync(join(ROOT, 'sheets', CATALOG_VERSION, sheetFileName(built)), 'utf8');
      assert.equal(committed, renderSheet(built), sheetFileName(built));
    }
  });

  test('every price appears on the page its row cites', () => {
    const byHash = new Map(Object.values(pages).map((page) => [page.sha256, page.text]));
    for (const { rows } of sheets) {
      for (const row of rows.filter(({ RowType }) =>
        ['unit_price', 'fee', 'credit_rate', 'additive_rate'].includes(RowType),
      )) {
        assert.ok(
          byHash.get(row.SourceSha256).includes(`$${row.ListUnitPrice}`),
          `${row.SkuPriceId} ${row.ListUnitPrice}`,
        );
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

  test('every fallback equals the highest price in its stated scope', () => {
    assert.equal(rowById('anthropic:fallback:input_uncached').ListUnitPrice, '10');
    assert.equal(rowById('anthropic:fallback:output').ListUnitPrice, '50');
    assert.equal(rowById('openai:fallback:output').ListUnitPrice, '180.00');
    assert.equal(rowById('google:fallback:input_uncached').ListUnitPrice, '4.00');
  });
});

describe('the scrape job', () => {
  const changed = (id, from, to) => ({ ...pages, [id]: { ...pages[id], text: pages[id].text.replace(from, to) } });

  test('a changed page shows in the diff with both figures', () => {
    const moved = changed('anthropic-pricing', /(\| Claude Opus 5\.5 +\| )\$4 \/ MTok/, '$1$5 / MTok');
    const diff = diffSheets(sheets, buildSheets(moved).sheets);
    const row = diff.changed.find(({ id }) => id === 'anthropic:claude-opus-5-5:global:standard:all:input_uncached');
    assert.deepEqual(row.fields, [{ field: 'ListUnitPrice', before: '4', after: '5' }]);
    assert.match(
      renderDiff(diff, { version: '0.1.1', previous: '0.1.0' }),
      /claude-opus-5-5.*ListUnitPrice \| "4" \| "5"/,
    );
  });

  test('a new page row shows as added and a dropped one as removed', () => {
    const moved = changed('openai-pricing', /\| gpt-3\.5-turbo-0125 \| \$0\.50 \| \$1\.50 \| - \|\n/, '');
    const { removed } = diffSheets(sheets, buildSheets(moved).sheets);
    assert.ok(removed.some(({ row }) => row.SkuPriceId === 'openai:gpt-3.5-turbo-0125:global:standard:all:output'));
  });

  test('a page that lost its table stops the build instead of emptying a sheet', () => {
    assert.throws(() => buildSheets(changed('anthropic-pricing', 'Base input tokens', 'Input')), /no table/);
    assert.throws(
      () => buildSheets(changed('cursor-pricing', /\| US data residency \|/g, '| Residency |')),
      /expected two model tables/,
    );
  });

  test('no cross-check snapshot reaches a parser', () => {
    assert.deepEqual(Object.keys(pages).sort(), PAGES.map(({ id }) => id).sort());
  });
});

describe('the cross-check', () => {
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
  const mutate = (change) => {
    const copy = structuredClone(sheet('anthropic'));
    change(copy);
    return validate(copy);
  };
  const first = (rows, type) => rows.find(({ RowType }) => RowType === type);

  test('accepts a built sheet', () => {
    assert.equal(validate(sheet('anthropic')), true);
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

  test('scripts/validate.mjs exits 1 when a saved page changes under a row', () => {
    const script = `
      import { cpSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      const copy = mkdtempSync(join(tmpdir(), 'catalog-'));
      for (const path of ['scripts', 'schema', 'sheets', 'node_modules', 'package.json']) cpSync(join(${JSON.stringify(ROOT)}, path), join(copy, path), { recursive: true });
      appendFileSync(join(copy, 'scripts/scrape/testdata/pages/anthropic-pricing.md'), 'x');
      process.stdout.write(copy);
    `;
    const copy = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const result = spawnSync(process.execPath, [join(copy, 'scripts', 'validate.mjs')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
  });
});
