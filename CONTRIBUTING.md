# Contributing to dario

PRs welcome. The codebase is ~2,300 lines across 7 files.

## Setup

```bash
git clone https://github.com/askalf/dario
cd dario
npm install
npm run dev   # runs with tsx, no build needed
```

## Structure

| File | Purpose |
|------|---------|
| `src/proxy.ts` | HTTP proxy server, OpenAI compat, CLI backend, rate governor |
| `src/cc-template.ts` | CC template engine + tool mapping |
| `src/cc-template-data.json` | MITM-extracted CC data (25 tools, 25KB system prompt) |
| `src/cc-oauth-detect.ts` | Auto-detect OAuth config from installed CC binary (v3.4+) |
| `src/oauth.ts` | Token storage, refresh, credential detection |
| `src/cli.ts` | CLI entry point + Bun auto-relaunch |
| `src/index.ts` | Library exports |
| `test/oauth-detector.mjs` | E2E test for the OAuth detector against a real CC binary |

## Before submitting

1. `npm run build` — must compile clean
2. `npm audit --production --audit-level=high` — no high-severity vulnerabilities
3. Test manually: `dario proxy --verbose` and make a request
4. No new dependencies unless absolutely necessary
5. Keep it simple — this project's value is that it's small enough to audit

## Security issues

Do **not** open a public issue. Email **security@askalf.org** instead. See [SECURITY.md](SECURITY.md).
