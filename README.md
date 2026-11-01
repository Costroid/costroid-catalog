# Costroid catalog

Open, dated price sheets for LLM providers. [Costroid](https://github.com/Costroid/costroid), the cost check for pull requests, prices token counts against a pinned version of these sheets.

| Path                | What it holds                                                            |
| ------------------- | ------------------------------------------------------------------------ |
| `schema/v0.1/`      | The sheet schema, with columns named after FOCUS pricing columns         |
| `sheets/<version>/` | One dated file per provider. Every price row carries its source          |
| `reports/`          | The cross-check, the diff and the omissions for each release             |
| `scripts/scrape/`   | The job that rebuilds a sheet from a saved provider page, with its tests |

## Why it exists

A cost figure is only as good as its price. Each price here names the page it came from, the date it was read and a hash of that page, so any figure can be traced to its source.

## Install

```sh
git clone https://github.com/Costroid/costroid-catalog
cd costroid-catalog
npm ci
```

Node.js 22 or later.

## First command

```sh
node scripts/validate.mjs
```

It checks every sheet against the schema and prints one line per sheet with its row count.

## Versions

A release is a directory under `sheets/`. A published release never changes in place. A customer pins a version.

## Licence

Apache-2.0. Costroid does not relicense this repository. Contributions are under the [Developer Certificate of Origin](CONTRIBUTING.md).
