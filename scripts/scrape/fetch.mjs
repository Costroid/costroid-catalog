import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CROSSCHECKS, PAGES } from './sources.mjs';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), 'testdata');
const USER_AGENT = 'costroid-catalog-scrape/0.1';
const MAX_REDIRECTS = 10;

// ai.google.dev answers its first visit with a redirect loop that only ends once its cookies return.
async function fetchFollowingCookies(url) {
  const cookies = new Map();
  let target = url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const response = await fetch(target, {
      redirect: 'manual',
      headers: {
        'user-agent': USER_AGENT,
        cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      },
    });
    for (const line of response.headers.getSetCookie()) {
      const [name, ...value] = line.split(';')[0].split('=');
      cookies.set(name, value.join('='));
    }
    if (response.status < 300 || response.status >= 400) {
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    }
    target = new URL(response.headers.get('location'), target).href;
  }
  throw new Error(`${url} redirected more than ${MAX_REDIRECTS} times`);
}

async function save(page, retrievedAt) {
  const bytes = await fetchFollowingCookies(page.url);
  const path = join(TESTDATA, page.file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return {
    id: page.id,
    url: page.url,
    file: page.file,
    retrievedAt,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

const retrievedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const sources = [];
for (const page of [...PAGES, ...CROSSCHECKS]) {
  const entry = await save(page, retrievedAt);
  sources.push(entry);
  console.log(`${entry.id}: ${entry.bytes} bytes, sha256 ${entry.sha256}`);
}
await writeFile(join(TESTDATA, 'SOURCES.json'), `${JSON.stringify(sources, null, 2)}\n`);
