import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SHEETS, versionParts } from './scrape/lib/sheets.mjs';

const USAGE = `usage:
  manifest.mjs --version <x.y.z> [--out <file>]   write the SHA-256 of every sheet of a release

The manifest has one line per sheet: its SHA-256, two spaces and its file name, sorted by name.
It is the format sha256sum writes, so "sha256sum -c" checks the sheets of a release against it.
Without --out it prints to standard output. --out refuses a file that exists.`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function manifest(directory) {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  if (names.length === 0) throw new Error(`${directory} holds no sheet`);
  return names.map((name) => `${sha256(readFileSync(join(directory, name)))}  ${name}\n`).join('');
}

export function releaseManifest(version) {
  versionParts(version);
  const directory = join(SHEETS, version);
  if (!existsSync(directory)) throw new Error(`no release ${version} under sheets/`);
  return manifest(directory);
}

function main() {
  let options;
  try {
    ({ values: options } = parseArgs({ options: { version: { type: 'string' }, out: { type: 'string' } } }));
    versionParts(options.version);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  try {
    const text = releaseManifest(options.version);
    if (options.out) writeFileSync(options.out, text, { flag: 'wx' });
    else process.stdout.write(text);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
