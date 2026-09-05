## What does this PR do?

## How to test

## Checklist
- [ ] `npm run build` passes
- [ ] `npm test` passes (offline regression test, no credentials required)
- [ ] Touches `src/`? Then a bullet under `## [Unreleased]` in `CHANGELOG.md` is in this PR (CI enforces it; `no-changelog` label for pure refactors)
- [ ] For changes that touch `proxy.ts`, `cc-template.ts`, or streaming behavior: tested with `dario proxy --verbose` + `node test/compat.mjs` (requires credentials)
- [ ] No new runtime dependencies added
- [ ] No tokens/secrets in code or logs
