## What does this PR do?

## How to test

## Checklist
- [ ] `npm run build` passes
- [ ] `npm test` passes (offline regression test, no credentials required)
- [ ] Touches `src/`? Then a bullet under `## [Unreleased]` in `CHANGELOG.md` is in this PR (CI enforces it; `no-changelog` label for pure refactors)
- [ ] Contributing from a fork? Leave `package.json`'s version alone and don't add a `## [x.y.z]` heading: merging a bump publishes a release, so a maintainer cuts it after merge (CI enforces it)
- [ ] Links an issue somebody else filed? Then `Addresses #N`, never `Fixes #N` — the reporter closes it, not the merge (CI enforces it; #1244)
- [ ] For changes that touch `proxy.ts`, `cc-template.ts`, or streaming behavior: tested with `dario proxy --verbose` + `node test/compat.mjs` (requires credentials)
- [ ] No new runtime dependencies added
- [ ] No tokens/secrets in code or logs
