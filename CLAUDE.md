# costroid-catalog

Open, dated price sheets for LLM providers. This repository is public under Apache-2.0.

## Layout

- `schema/v0.1/`: the sheet schema.
- `sheets/<version>/`: one dated file per provider.
- `reports/`: the cross-check, diff and omissions for each release.
- `scripts/scrape/`: the scrape job, one parser per provider, and its tests.
- `scripts/validate.mjs`: checks every sheet against the schema.

## Check

Run `npm ci`, then `node scripts/validate.mjs` and `npm test`. Both must exit 0. Read each exit code directly.

## Rules

- A published release directory is never edited. A change is a new release.
- Prices are decimal strings, never JSON numbers.
- Every price row carries its source URL, retrieval date and page hash.
- A price not on the provider's page is omitted and named in the report. Never fill from memory.
- A disagreement with a cross-check is a finding, never the source of a price.
- No platform code enters this repository.
- Only sheets, schemas, reports and their tooling belong here. Company matters do not.
- `STYLE.md` is the bar for every public line.
- Commits use the imperative mood and carry a `Signed-off-by` trailer on pull requests.
