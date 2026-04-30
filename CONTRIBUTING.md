# Contributing to dario

PRs welcome. The codebase is ~12,650 lines across 27 TypeScript files and stays dependency-free at runtime.

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
| `src/proxy.ts` | HTTP proxy server, request dispatch, rate governor, billing tag, multi-account pool routing, OpenAI-compat backend routing, SSE streaming forwarder |
| `src/cc-template.ts` | CC request template engine, forward tool mapping (`translateArgs`), reverse tool mapping (`translateBack`), `reverseMapResponse` for non-streaming responses, `createStreamingReverseMapper` for SSE streaming tool_use blocks, framework/orchestration scrubbing |
| `src/cc-template-data.json` | CC request template data (25 tools, 25KB system prompt) |
| `src/cc-oauth-detect.ts` | Auto-detect OAuth config from the installed Claude Code binary (v3.4.3+), anchored on `BASE_API_URL:"https://api.anthropic.com"` |
| `src/oauth.ts` | Single-account token storage, refresh, credential detection, macOS keychain fallback (v3.7.0+) |
| `src/accounts.ts` | Multi-account credential storage for pool mode (v3.5.0+) |
| `src/pool.ts` | Account pool, headroom-aware selection, failover-target selection, request queueing (v3.5.0+) |
| `src/analytics.ts` | Rolling request history, per-account / per-model stats, burn-rate, exhaustion predictions (v3.5.0+) |
| `src/openai-backend.ts` | OpenAI-compat backend credential storage and request forwarder (v3.6.0+) |
| `src/cli.ts` | CLI entry point, command routing (`login`, `proxy`, `accounts`, `backend`, `status`, `refresh`, `logout`), Bun auto-relaunch |
| `src/index.ts` | Library exports |
| `test/issue-29-tool-translation.mjs` | In-process regression test for the tool-use reverse translation layer (28 assertions, no OAuth or live proxy required) |
| `test/compat.mjs` | Live-proxy end-to-end compat suite (tool use, streaming, OpenAI compat). Requires a running `dario proxy` and authenticated Claude credentials. |
| `test/e2e.mjs` | Live-proxy end-to-end smoke suite |
| `test/stealth-test.mjs` | Live-proxy stealth suite (billing classification, thinking stripping, field scrubbing) |
| `test/oauth-detector.mjs` | End-to-end test for the OAuth detector against a real CC binary |

## Before submitting

1. `npm run build` — must compile clean.
2. `npm test` — in-process regression test for the tool-use reverse translation layer (no OAuth or upstream calls required; runs anywhere).
3. `npm audit --production --audit-level=high` — no high-severity vulnerabilities.
4. For changes that touch `proxy.ts`, `cc-template.ts`, or streaming behavior: test manually against a live proxy with `dario proxy --verbose` and then run `node test/compat.mjs` (requires valid credentials). The live suites aren't wired into `npm test` because they require credentials and consume real subscription usage.
5. No new runtime dependencies — dario's zero-runtime-deps posture is load-bearing for its audit story.
6. Keep it simple — this project's value is that it's small enough to audit.

## Security issues

Do **not** open a public issue. Email **security@askalf.org** instead. See [SECURITY.md](SECURITY.md).

## Review policy

Every PR goes through at least one review round. The bar for merge is:

- **Functional.** Tests pass locally and on CI (the full `npm test` suite, not just the change's new tests).
- **Necessary.** The change solves a stated problem (linked issue, user report, or review-feedback entry). "While I was in there" changes get split into a separate PR.
- **Non-breaking by default.** Any change that removes or alters a `@stable` API per [STABILITY.md](STABILITY.md) requires a deprecation cycle — no breaking changes slip through on patch or minor releases.
- **Test coverage for behavior changes.** New flags, new code paths, new exit conditions all get at least one assertion in `test/`. Pure refactors are exempt.
- **Zero new runtime deps.** This is non-negotiable — dario's audit story depends on it. Dev-only deps (TypeScript, tsx, `@types/node`) are fine.

PRs that don't meet the bar get comments explaining why, not a silent block. If the bar seems arbitrary in a specific case, argue it in the PR — every bar item has been negotiated before.

## Release cadence

For the actual release mechanics (how auto-release works, the pre-merge checklist, and the **post-publish bin-shim smoke** added after dario#143), see [RELEASING.md](RELEASING.md).

See [STABILITY.md](STABILITY.md) for the full policy. Summary:

- **Patch** (`3.30.x`) — bug fixes, review-feedback, drift patches. Often multiple per day during active cycles.
- **Minor** (`3.31.0`) — new flags, new exports, new endpoints. Ships when accumulated new surface justifies it.
- **Major** (`4.0.0`) — removes `@deprecated` APIs, changes `@stable` behavior. Every major carries `docs/migrate-vX.md`.

New features default to `@experimental` for at least one minor before being promoted to `@stable`. The promotion is a CHANGELOG entry, not a code change — the JSDoc tag moves and the `CHANGELOG.md` notes the graduation.

## Semver commitments

- `@stable` API: **never breaks** without a major bump + a minor-long deprecation cycle
- `@experimental` API: **can change in any minor**, but breaks are called out in CHANGELOG
- `@deprecated` API: **removed at the next major**, stays working with a one-shot warning until then
- Internal (unmarked) APIs: **free to change without notice** — don't depend on them

If your PR touches something at the `@stable` boundary in a way that requires a shape change, flag it in the PR title: `[STABILITY]` and propose whether it's a deprecation cycle or a new-minor addition that leaves the old surface intact.
