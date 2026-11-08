import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { manifest, releaseManifest } from './manifest.mjs';
import { SHEETS } from './scrape/lib/sheets.mjs';

const SCRIPT = join(import.meta.dirname, 'manifest.mjs');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function withDirectory(files, run) {
  const directory = mkdtempSync(join(tmpdir(), 'manifest-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('names every sheet with its SHA-256 in sha256sum format, sorted by file name', () => {
  withDirectory(
    { 'openai-2026-11-07.json': '{"b":1}\n', 'anthropic-2026-11-07.json': '{"a":1}\n', 'notes.md': 'x' },
    (dir) =>
      assert.equal(
        manifest(dir),
        `${sha256('{"a":1}\n')}  anthropic-2026-11-07.json\n${sha256('{"b":1}\n')}  openai-2026-11-07.json\n`,
      ),
  );
});

test('a changed byte in a sheet changes the digest the manifest names', () => {
  const before = withDirectory({ 'google-2026-11-07.json': '{"ListUnitPrice":"2.00"}' }, manifest);
  const after = withDirectory({ 'google-2026-11-07.json': '{"ListUnitPrice":"2.01"}' }, manifest);
  assert.notEqual(before, after);
});

test('the manifest of every published release names each of its sheets by its digest', () => {
  for (const version of readdirSync(SHEETS)) {
    const lines = releaseManifest(version).trimEnd().split('\n');
    const names = readdirSync(join(SHEETS, version)).filter((name) => name.endsWith('.json'));
    assert.equal(lines.length, names.length, version);
    for (const line of lines) {
      const [, digest, name] = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
      assert.equal(digest, sha256(readFileSync(join(SHEETS, version, name))), `${version}/${name}`);
    }
  }
});

test('refuses a version that is not x.y.z, a release that does not exist and a directory with no sheet', () => {
  assert.throws(() => releaseManifest('../schema'), /not a release version/);
  assert.throws(() => releaseManifest('9.9.9'), /no release 9\.9\.9/);
  withDirectory({ 'README.md': 'x' }, (dir) => assert.throws(() => manifest(dir), /holds no sheet/));
  const run = spawnSync(process.execPath, [SCRIPT, '--version', 'v0.2.0'], { encoding: 'utf8' });
  assert.equal(run.status, 2, run.stderr);
});

test('refuses to overwrite an existing --out file', () => {
  withDirectory({ SHA256SUMS: 'kept\n' }, (dir) => {
    const out = join(dir, 'SHA256SUMS');
    const run = spawnSync(process.execPath, [SCRIPT, '--version', '0.2.0', '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(readFileSync(out, 'utf8'), 'kept\n');
  });
});

test('writes the manifest of a release to --out', () => {
  withDirectory({}, (dir) => {
    const out = join(dir, 'SHA256SUMS');
    const run = spawnSync(process.execPath, [SCRIPT, '--version', '0.2.0', '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(out, 'utf8'), releaseManifest('0.2.0'));
  });
});

test('the release workflow runs on a tag push alone and pins every action by commit', () => {
  const workflow = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const triggers = /^on:\n((?: {2}.*\n|\n)*)/m.exec(workflow)[1];
  assert.match(triggers, /^ {2}push:\n {4}tags:\n {6}- 'v\*'\n/);
  assert.equal(triggers.trim().split('\n').length, 3, triggers);
  assert.doesNotMatch(workflow, /pull_request|workflow_run|issue_comment/);
  const actions = [...workflow.matchAll(/uses: (\S+)(.*)$/gm)];
  assert.ok(actions.length > 0);
  for (const [line, action, comment] of actions) {
    assert.match(action, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, line);
    assert.match(comment, /^ # v\d+\.\d+\.\d+$/, line);
  }
});
