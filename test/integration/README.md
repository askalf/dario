# Live integration tests

Not part of `npm test` (they need real network access and a real
deployed lock service) — `test/all.test.mjs`'s discovery only scans the
top-level `test/` directory, so this folder is invisible to it by design,
same as `e2e.mjs`/`compat.mjs` having their own entry points.

## `dual-instance-race.mjs` — the dario#993 fix, proven live

Two genuinely separate `node` processes, each with its own isolated
`~/.dario` (via a per-process `HOME`/`USERPROFILE`), racing to refresh
the SAME account's OAuth token at the same instant. Real network calls
to the real deployed `dario-refresh-lock` Cloudflare Worker; a local mock
(`mock-anthropic-oauth.mjs`) stands in for Anthropic's token endpoint
ONLY — hammering the real one with production credentials for
adversarial testing risks actually burning the operator's live refresh
token, everything else here is real, not simulated. The mock enforces
the one behavior this whole fix depends on: a refresh_token is
single-use, reusing an already-consumed one 400s exactly like the real
API.

```
# prove the fix does something — run the race WITHOUT it first:
npm run test:refresh-lock-race -- --no-lock
# expect: one worker gets a real invalid_grant rejection (the #993 bug)

# then the real test:
DARIO_REFRESH_LOCK_URL=https://dario-refresh-lock.<subdomain>.workers.dev \
DARIO_REFRESH_LOCK_TOKEN=<the shared secret> \
npm run test:refresh-lock-race
# expect: both workers succeed, exactly ONE real refresh reaches "Anthropic"
```

**Verified 2026-08-18:** 1/1 control run (`--no-lock`) reproduced the bug
cleanly. 6/6 runs against the real deployed Worker held — both workers
succeeded, exactly one real refresh each time, zero rejections. Each run
uses a fresh random alias specifically so the DO's own credential cache
(intentional, 5-minute TTL) can't mask a fresh race as a cache hit on a
rerun.
