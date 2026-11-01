# Contributing

## Developer Certificate of Origin

Every commit carries a sign-off. There is no contributor licence agreement.

Sign off with `git commit -s`. The trailer states that you agree to the [Developer Certificate of Origin 1.1](https://developercertificate.org/):

```text
Signed-off-by: Your Name <you@example.com>
```

CI rejects a pull request with an unsigned commit. Contributions are licensed under Apache-2.0, the licence of this repository.

## Changing the repository

1. Run `npm ci`.
2. Make the change.
3. Run the repository's checks, `node scripts/validate.mjs` and `npm test`. Both must exit 0.
4. Read [STYLE.md](STYLE.md). It is the bar for every public line.
5. Open a pull request with three sections: changed, deliberately unchanged, verified.

Commit messages use the imperative mood and say what changed and why.
