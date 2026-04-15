# Changelog

All notable changes to this project will be documented in this file.

## [3.9.4] - 2026-04-14

Fixes a verbose-log flood reported by [@boeingchoco](https://github.com/boeingchoco) in [#36](https://github.com/askalf/dario/issues/36): on accounts without the context-1m beta entitlement, dario was re-sending `context-1m-2025-08-07` with every request, eating a 400/429 + retry round-trip per POST for the whole session.

### Fixed

- **Cache context-1m rejection per account** (`src/proxy.ts`). The first time an account returns a `long context`-shaped 400/429, dario records that on the session's `context1mUnavailable` set (keyed by pool alias, or `__default__` in single-account mode) and skips `context-1m-2025-08-07` from the outgoing `anthropic-beta` header on every subsequent request for that account. Pool failover does not share the flag across accounts — each account proves its own context-1m eligibility on its first request. The verbose log for the rejection now only prints the first time (with `(cached for session)` appended) so long sessions don't spam one rejection line per request.

  Impact: a subscriber on a plan without the long-context add-on was paying ~2× the latency and ~2× the upstream request count for every message. After v3.9.4 they pay it exactly once per account per process lifetime.

### Known limitations (reported in #36, not yet fixed)

- **Hybrid tool mode reverse mapping under OpenClaw still has rough edges.** @boeingchoco's report showed `Bash` returning "Unknown action", `Glob` getting misrouted to an internal `memory_get`, and `Read` being called with a directory path. These look like reverse-mapping (tool-name or tool-shape) mismatches between CC's tool set and OpenClaw's schema, but we need OpenClaw's full tool definition JSON to reproduce. Left #36 open pending that schema.
- **`overage: ?` in verbose logs** is the same response-header-missing symptom as the first-request retry path — expected to mostly resolve itself with the rejection cache above, since subsequent requests go through the normal response-header code path and carry the expected `anthropic-ratelimit-unified-overage-utilization` header.

### Credit

[@boeingchoco](https://github.com/boeingchoco) — third time this user has surfaced a high-value bug (#23, #29, #33 were prior). The full verbose log dump with requests #0 through #24 showed the retry-every-request loop immediately — would have taken much longer to reproduce synthetically.

## [3.9.3] - 2026-04-14

Fixes [#35](https://github.com/askalf/dario/issues/35) reported by [@tetsuco](https://github.com/tetsuco) — `scrubFrameworkIdentifiers` was corrupting filesystem paths that contained a framework name. `/Users/foo/.openclaw/workspace/` was being rewritten to `/Users/foo/./workspace/` because the `\b` word boundary in the identifier regexes fired between `.` and `o`, so the scrub treated the path segment as prose.

### Fixed

- **`scrubFrameworkIdentifiers` now skips matches embedded in path or URL contexts** (`src/cc-template.ts`). The replacement callback inspects the character immediately before and after each match and preserves the identifier when it's adjacent to `.`, `/`, `\`, `-`, or `_` — strong signals that the token is part of a filesystem path, URL, or slug rather than prose. Standalone prose identifiers ("powered by openclaw", "running openclaw with aider") still scrub as before.

  Affected users: anyone running `--hybrid-tools` (or any CC-template path) with a client whose workspace, config, cache, or log directory contains a framework name — OpenClaw's `~/.openclaw/workspace/` is the reproducer, but `/tmp/aider-cache`, `~/.cursor/settings.json`, and similar paths were all at risk of silent corruption on the upstream request.

### Added

- **`test/scrub-paths.mjs`** — 11 assertions covering the path-preservation fix: unix hidden dirs, Windows paths, tilde-expanded paths, URL hosts, aider/cursor path segments, plus prose-scrubbing baselines and mixed path/prose cases. Wired into `npm test`.

### Not changed

- **The FRAMEWORK_PATTERNS list itself** — same identifiers, same order, same `\b` boundaries. Only the replacement strategy changed.
- **System prompt scrubbing semantics** — `CC_SYSTEM_PROMPT` merge, billing header, tool request fingerprint: all unchanged.

### Credit

[@tetsuco](https://github.com/tetsuco) — precise reproducer with the before/after path, OS, node, and dario version. Took under five minutes from issue read to root cause. Thanks for the clean report.

## [3.9.2] - 2026-04-14

Docs-only: tighten three `dario help` flag entries for consistency.

### Changed

- **`src/cli.ts` help text** — `--preserve-tools`, `--hybrid-tools`, and `--host=ADDRESS` rewritten to matching two-line entries. Removes shell-meaningless `#33` reference and "CC fingerprint" jargon from `--hybrid-tools`; expands `--preserve-tools` into a sibling shape so the subscription-routing trade-off is visible in the legend; trims the `--host` block from 5 lines to 2, deferring the `DARIO_API_KEY` LAN-binding warning to README where it's already documented in full.

No behavior change. No code paths touched outside the `help()` string.

## [3.9.1] - 2026-04-14

Windows keychain credential detection. Finishes the Windows arm of the v3.7.0 keychain work ([#30](https://github.com/askalf/dario/pull/30) by [@iNicholasBE](https://github.com/iNicholasBE)) that was explicitly stubbed out. Tracked as item 3 of the v3.8.0+ roadmap.

### Added

- **Windows Credential Manager support in `loadKeychainCredentials`** (`src/oauth.ts`). Modern Claude Code on Windows (via Node keytar) stores OAuth tokens as Generic credentials in Credential Manager with target prefix `Claude Code-credentials`. Dario's `loadCredentials()` now enumerates matching entries on Windows via PowerShell + Win32 `CredEnumerateW`, decodes the UTF-16LE credential blob, and returns the first entry that parses as a valid `{claudeAiOauth: {accessToken, refreshToken}}` shape. Runs under `-NoProfile -NonInteractive -ExecutionPolicy Bypass` with a 5s timeout and `windowsHide: true` so no console flashes.

  Same pattern as the macOS and Linux paths that shipped in v3.7.0: silent fall-through on any failure, so the existing file-based checks (`~/.dario/credentials.json`, `~/.claude/.credentials.json`) still run as the next fallback. Pre-v3.9.1 Windows users were hitting those file fallbacks exclusively — no regression risk for anyone whose CC on Windows writes to disk rather than to the credential manager.

- **Windows keychain branch in `loadCredentials()` probe order.** Unchanged: keychain → dario file → CC file → OAuth flow. The Windows keychain path slots into the existing keychain branch; the surrounding order is untouched.

### Not changed

- **macOS and Linux keychain paths** — identical to v3.7.0/v3.8.x behavior. No edits to the `security find-generic-password` or `secret-tool lookup` branches.
- **File-based credential loading** — `~/.dario/credentials.json` and `~/.claude/.credentials.json` probes run in the same order, with the same semantics.
- **OAuth refresh flow, cache TTL, refresh cooldown, mutex** — all unchanged.
- **All tests pass unchanged**: `test/issue-29-tool-translation.mjs` 28/28 ✅, `test/hybrid-tools.mjs` 24/24 ✅, `test/analytics-recording.mjs` 38/38 ✅, `test/failover-429.mjs` 19/19 ✅.

### Testing notes

Verified locally on Windows 11 Pro:

1. **Build clean** — TypeScript compiles without errors.
2. **PowerShell script standalone** — running the embedded Win32 `CredEnumerate` script against `Claude Code-credentials*` filter on a machine without a CC keychain entry returns `ERROR_NOT_FOUND` (1168), which the PS script swallows and exits with no stdout — exactly the "fall through" behavior the JS caller expects.
3. **`loadCredentials()` smoke test** — on a machine where CC was previously installed but has now been uninstalled, the Windows keychain probe returns `null` and the file-based fallback finds `~/.claude/.credentials.json` as expected.

**Not yet verified against a live CC-keychain-backed Windows install.** If you run CC on Windows and your OAuth tokens are stored in Credential Manager (not in a file), please upgrade to v3.9.1 and report whether `dario login`'s keychain probe picks up your existing session. File an issue if it doesn't — the enumeration filter or UTF-16 decode may need tweaking for edge cases we haven't seen.

### Credit

[@iNicholasBE](https://github.com/iNicholasBE) — the v3.7.0 macOS + Linux keychain work established the code path and the fall-through semantics; v3.9.1 just fills in the Windows slot against the same contract. Thanks also to the broader CC ecosystem for documenting the keytar → Credential Manager storage convention that made this implementation straightforward.

## [3.9.0] - 2026-04-14

**Hybrid tool mode** — resolves [#33](https://github.com/askalf/dario/issues/33), the roadmap item promised to [@boeingchoco](https://github.com/boeingchoco) in the v3.8.1 thread. Keep the CC request fingerprint AND let custom-schema clients see their declared non-CC fields on tool_use responses.

### Background

After the reverse-direction tool parameter translation fix in v3.7.0/v3.7.1, [@boeingchoco](https://github.com/boeingchoco) was still seeing `sessionId is required for this action.` from OpenClaw's validator on the Claude backend. v3.8.1 surfaced `--preserve-tools` as the escape hatch but made the trade-off explicit: the flag preserves the client's schema at the cost of the CC request fingerprint, which is what routes Max/Pro subscription billing. Users with custom-schema workloads who also wanted subscription pricing had no path. Hybrid mode fills it.

The key observation: the "missing" fields are usually **request context** — `sessionId`, `requestId`, `channelId`, `userId`, `timestamp` — values dario already has from the incoming request, not values that need the model's reasoning. So dario can keep the forward path untouched (CC fingerprint preserved, Bash/Read/Grep/Glob/WebSearch/WebFetch sent upstream) and inject context values on the reverse path after `translateBack`. Both constraints satisfied.

### Added

- **`--hybrid-tools` flag** (alias `--context-inject`) in `src/cli.ts`. Mutually exclusive with `--preserve-tools` — the CLI rejects both with a clear error. Threaded through `ProxyOptions.hybridTools` to `startProxy`.

- **`RequestContext` type** in `src/cc-template.ts`. Fields: `sessionId`, `requestId`, `channelId`, `userId`, `timestamp` (ISO 8601). Built once per request in `src/proxy.ts` from `x-session-id` / `x-request-id` / `x-channel-id` / `x-user-id` headers, with fallbacks to the proxy's internal `SESSION_ID` and a generated `randomUUID()`.

- **`CONTEXT_FIELD_SOURCES` map** — a case-insensitive lookup from client-declared field name to `RequestContext` key. Initial set covers snake_case and camelCase variants of `sessionId`, `requestId`, `channelId`, `userId`, `timestamp`, `created_at`, `createdAt`.

- **`injectContextFields(input, clientFields, ctx)`** — the hybrid-mode injection function. Walks each client-declared field, skips any already populated by `translateBack`, looks up the field in `CONTEXT_FIELD_SOURCES`, and fills from `ctx` when matched. No-op when `clientFields` is unset (default mode) or `ctx` is undefined.

- **`ToolMapping.clientFields`** — optional array of top-level field names the client's tool schema declared. Populated in `buildCCRequest` only when `opts.hybridTools` is true; each matched mapping gets a shallow clone so the shared `TOOL_MAP` entries aren't mutated across requests.

- **`test/hybrid-tools.mjs`** — 24 assertions across 6 test cases: default-mode (no injection baseline), hybrid-mode basic injection, snake_case variant, no-ctx no-op, translateBack fields not clobbered, streaming + hybrid end-to-end. All green.

### Changed

- **`reverseMapResponse(body, toolMap, ctx?)`** — now takes an optional `RequestContext`. Passes it into `rewriteToolUseBlock` so hybrid-mode injection runs after `translateBack`. Backward compatible: pre-3.9.0 call sites that didn't pass `ctx` still work as pure reverse-translation.

- **`createStreamingReverseMapper(toolMap, ctx?)`** — same signature extension. The injection point is after the `content_block_stop` path parses the buffered `partial_json` and applies `translateBack`. The `anyNeedsTranslation` fast-path check now also considers `clientFields` so hybrid-mode mappings always take the buffering path (required — injection has to run at end-of-block, not per-chunk).

- **`src/proxy.ts`** — extracts `reqCtx: RequestContext | undefined` once per request (only when `opts.hybridTools` is set). Threads through to both `reverseMapResponse` and `createStreamingReverseMapper`. `buildCCRequest` call updated to pass `hybridTools: opts.hybridTools ?? false`.

- **`src/cc-template.ts` — `buildCCRequest` two-pass tool map construction**. First pass now conditionally clones the shared `TOOL_MAP` entry and attaches `clientFields` from the client's `input_schema.properties` when hybrid mode is active. Zero allocation in default mode.

- **README.md** — new `### Hybrid tool mode` subsection with when-to-use table, how-it-works explanation, and limitations spelled out. The `### Custom tool schemas` subsection links forward to it as the recommended compromise for users who want subscription billing on custom-schema workloads.

- **`npm test`** — adds `test/hybrid-tools.mjs` to the default test runner. Full suite now at 109 assertions across four files (issue-29: 28, hybrid-tools: 24, analytics-recording: 38, failover-429: 19).

### Not changed

- **Default mode behavior is unchanged.** Clients that don't pass `--hybrid-tools` get the exact same forward/reverse path they did on v3.8.1. Zero risk of regression for existing setups.
- **`--preserve-tools` is unchanged.** Still the right answer for clients whose custom fields need the model's reasoning (not just request context).
- **Tool `TOOL_MAP` entries are unchanged.** Same forward/back translations as v3.7.1.
- **Streaming tool_use semantics for non-hybrid clients are unchanged.** The buffering path is the same; only mappings with `clientFields` set take the new injection branch.

### Scope limitations (tracked in #33 for follow-up)

- **Top-level fields only.** Nested object injection (`meta: {sessionId: ...}`) is not supported in v1.
- **Fixed field list.** Arbitrary custom field names (e.g. internal `tenant_id`) are not auto-mapped. File an issue if you need the `CONTEXT_FIELD_SOURCES` map extended.
- **No type coercion.** Injected values are always strings (from headers or ISO timestamps). Clients requiring typed values should use `--preserve-tools`.

### Credit

[@boeingchoco](https://github.com/boeingchoco) — fourth consecutive release with contribution credit. The original #29 report, the v3.7.1 SSE regression catch, the v3.8.1 provider-comparison diagnostic, and now the motivating case for this entire hybrid-mode design. Contributors table in the README updated to reflect the scope of contribution across all four releases.

```bash
npm install -g @askalf/dario@3.9.0
```

## [3.8.1] - 2026-04-14

Documentation release. No code change. Surfaces [`--preserve-tools`](README.md#custom-tool-schemas) as the first-class answer for clients whose tool schemas carry fields CC's schema doesn't — credit to [@boeingchoco](https://github.com/boeingchoco) for the diagnostic work on [#29](https://github.com/askalf/dario/issues/29) that surfaced the discoverability gap.

### Background

[#29](https://github.com/askalf/dario/issues/29) originally surfaced as a reverse-direction tool parameter translation bug, fixed in v3.7.0 and v3.7.1. After upgrading to v3.7.1, [@boeingchoco](https://github.com/boeingchoco) reported that OpenClaw still failed with `sessionId is required for this action.` on the Claude backend — but the same OpenClaw install worked fine against `openai-codex/gpt5.4` and `github-copilot/claude-sonnet-4.6` through dario's OpenAI-compat backend. Same channel, same tools, same validator.

That provider-comparison evidence was the whole key: the `sessionId` failure isn't a tool-translation bug, it's the fundamental design of the CC-template path. `buildCCRequest` substitutes the client's tool schema with CC's `Bash/Read/Grep/Glob/WebSearch/WebFetch` definitions so the outgoing request looks like a real CC call on the wire (the fingerprint that lets subscription billing match the request to a Max/Pro plan). The side effect: fields the client's schema declares but CC's doesn't — `sessionId`, channel-bound context tokens, custom request ids — never reach the model, because the model never sees them in the schema it's asked to populate. The reverse mapper rebuilds the tool call without those fields, and a strict client validator rejects.

`--preserve-tools` has existed since v3.6.0 as the escape hatch: skip the CC tool remap entirely, pass the client's schema through to the model unchanged, accept that the CC fingerprint is gone and the request may bill as API usage rather than subscription usage. The flag was documented as one line in the proxy-flag table — not nearly enough to be findable by someone hitting exactly the problem it solves.

### Changed

- **README.md — `--preserve-tools` flag entry rewritten** with the required-for-custom-schemas hint and a link to the new subsection below. A user who hits `sessionId is required` now has a discoverable path from the proxy-flag table directly to the explanation.

- **README.md — new "Custom tool schemas" subsection** (between "Streaming, tool use, OpenAI-SSE" and "Library mode") explaining:
  - What the default CC tool substitution does and why it exists (the subscription fingerprint)
  - What fails when your client's tools have fields CC's schema doesn't
  - The symptom — tool calls stripped down, validator rejects, *only* on dario's Claude backend
  - The fix — `dario proxy --preserve-tools`
  - The trade-off — loss of the CC fingerprint, subscription billing may fall back to API pricing on that endpoint
  - The openai-compat backend is unaffected (it forwards tool schemas byte-for-byte)
  - The hybrid mode that keeps the fingerprint *and* passes unmapped client fields is on the roadmap

### Not changed

- `src/cc-template.ts`, `src/proxy.ts`, `src/openai-backend.ts` — no behavior change anywhere in the request path. This release is README-only.
- `--preserve-tools` itself — same flag, same semantics, same code path since v3.6.0. Only its documentation changed.
- All test suites pass unchanged. `test/issue-29-tool-translation.mjs` — 28/28 ✅.

### Credit

[@boeingchoco](https://github.com/boeingchoco) now cited in three consecutive releases: the original [#29](https://github.com/askalf/dario/issues/29) report (v3.7.0), the v3.7.1 regression catch, and the provider-comparison diagnostic that drove this docs release. The kind of depth-of-reporting any project maintainer would be lucky to see once.

## [3.8.0] - 2026-04-14

Two features that have been in the backlog since v3.5.0: real analytics data in pool mode, and inside-request 429 failover.

### Added

- **Analytics recording wired into all response paths** (`src/proxy.ts`). The `Analytics` class and `/analytics` endpoint shipped in v3.5.0 but `analytics.record()` was never called — the endpoint returned structural placeholders with zero data. v3.8.0 wires `record()` into every response path:
  - **Non-streaming**: parses usage from the buffered response body using `Analytics.parseUsage()` (already existed) and records after `res.end()`.
  - **Streaming**: accumulates `input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` from the `message_start` SSE event and `output_tokens` from `message_delta` in a parallel analytics decode loop (separate `TextDecoder`; does not touch the bytes written to the client). Records after `res.end()`.
  - **429 / error paths**: records with zero token counts so failure rates are visible in `/analytics`.
  - **OpenAI-compat path**: records with `isOpenAI: true` using the token counts extracted from the Anthropic response (the compat backend translates back to Anthropic format before returning).
  - Analytics are still only active in pool mode (`accountsList.length >= 2`) to match the existing guard — single-account mode still returns the `{mode: "single-account"}` placeholder.

- **Inside-request 429 failover for pool mode** (`src/proxy.ts`, `src/pool.ts`). Pool mode previously only failed over *between* requests: if account A 429'd, the *next* request routed to account B, but the *current* request returned a 429 to the client. v3.8.0 adds a `dispatchLoop: while (true)` around the upstream fetch. On a 429, the loop checks `pool.selectExcluding(triedAliases)` before surfacing the error. If another account is available, it swaps the `Authorization` and `x-claude-code-session-id` headers and retries with the buffered request body (already held in memory since v3.5.0). The loop is bounded to `pool.size` iterations to guarantee termination. `pool.selectExcluding` extended from `(alias: string)` to `(excluded: Set<string>)` to support multi-account exclusion cleanly.

### Changed

- **`AccountPool.selectExcluding(excluded: Set<string>)`** (`src/pool.ts`). Signature changed from single-alias string to a Set of aliases. The method is internal (only called from `proxy.ts`). Existing callers (only the failover loop) updated accordingly.

### Test results

- `test/issue-29-tool-translation.mjs` — 28/28 ✅ (unchanged)
- `test/analytics-recording.mjs` — 38/38 ✅ (new: unit tests for `Analytics.parseUsage()`, `record()`, `summary()`, error rates, per-account/per-model breakdown, streaming 429 records)
- `test/failover-429.mjs` — 19/19 ✅ (new: unit tests for `selectExcluding(Set)`, multi-alias exclusion, rejected-account skipping, full failover simulation)

Live e2e tests (`npm run e2e`, `npm run compat`) deferred until pool-mode account is available for testing.

## [3.7.2] - 2026-04-14

Security hardening release. Two CodeQL alerts filed against v3.7.1 — one `js/clear-text-logging` error and one `js/stack-trace-exposure` warning — both fixed with minimal-surface patches. No behavior change for any working path.

### Fixed

- **`js/clear-text-logging` (src/cli.ts:293).** `dario backend list` displayed API keys as `${first_3}...${last_4}` as a human-readable identifier. CodeQL's taint tracker (correctly, by policy) treats partial disclosure as disclosure — and it's right: a 7-character window from a 48-character key is more than enough to narrow a brute-force attempt against a known prefix family, and there's no defensible reason to show any substring of an API key in the first place. Fix: the list command now always prints `***` for the redacted column. Backend name and baseUrl are more than enough to tell backends apart.

- **`js/stack-trace-exposure` (src/openai-backend.ts:179).** The OpenAI-compat backend's upstream-error path constructed a 502 response body that included `err instanceof Error ? err.message : String(err)`. `Error.message` can leak internal paths, module names, and stack fragments (DNS errors in particular include the upstream hostname and the resolver's internal state). Fix: the error detail now logs to `console.error` server-side only (gated on `verbose`), and the 502 response body returns a generic `{error, backend}` payload to the client. Operators running `dario proxy --verbose` still see the underlying cause in their logs; clients never do.

### Not changed

- No behavior change for the CLI `dario backend add` flow. API keys are still stored at `~/.dario/backends/<name>.json` with `0600` permissions — that path is unchanged.
- No behavior change for successful upstream responses on the OpenAI-compat backend. The response body, headers, and streaming semantics are unchanged.
- No behavior change for the Claude-subscription backend. Tool-use parameter translation, pool mode, template replay — all unchanged.

### Test results

- `test/issue-29-tool-translation.mjs` — 28/28 ✅ (unchanged, tests the Claude backend path which this release doesn't touch)

## [3.7.1] - 2026-04-14

Regression fix for the v3.7.0 streaming reverse mapper. Reopens and then closes [#29](https://github.com/askalf/dario/issues/29) (reported by [@boeingchoco](https://github.com/boeingchoco)).

### Fixed

- **Streaming reverse mapper emitted malformed SSE event groups.** v3.7.0's `createStreamingReverseMapper` handled the synthetic-delta-plus-stop emission for buffered tool_use blocks as two `data:` lines joined by a single `\n` with no blank-line separator. SSE parsers concatenate consecutive `data:` lines within one event into that event's data, so downstream clients (including the Anthropic SDK's streaming parser in `@anthropic-ai/sdk/src/core/streaming.ts`) saw one event whose data was two JSON objects joined by a newline. `JSON.parse(...)` threw `Could not parse message into JSON`, which is exactly the error [@boeingchoco](https://github.com/boeingchoco) hit after upgrading to v3.7.0 and running the same OpenClaw workload that originally surfaced #29. The v3.7.0 unit test had a false-positive validation: it split the mapper's output on `\n` and filtered for `data: ` lines, which inadvertently treated the malformed multi-line data event as two separate events (since each line on its own was valid JSON). Real SSE parsers don't do that, and the Anthropic SDK parser in particular throws the moment it hits the concatenated-JSON payload.
- **Orphan `event:` header lines** from swallowed tool_use delta events. v3.7.0 processed SSE one line at a time, so when a `content_block_delta` was buffered for end-of-block translation, only the `data:` line was swallowed — the preceding `event: content_block_delta` header line passed through to the client as an empty event with no payload. Harmless for Anthropic SDK (which skips events without data) but wrong and confusing under stricter SSE parsers.

### Changed

- **`createStreamingReverseMapper` rewritten to process SSE event groups, not individual lines.** The mapper now splits its accumulated buffer on blank lines (`\n\n` — the SSE event-group separator) and processes each complete event as a unit. When a buffered `content_block_delta` is swallowed, its entire event group (header line + data line) is dropped together — no more orphan headers. When the `content_block_stop` emission needs to produce a synthetic delta followed by the stop event, it returns two complete event groups joined by `\n\n`, and the outer buffer writer appends one more `\n\n` after the final event. Every emitted event is framed correctly per SSE spec and parses cleanly in the Anthropic SDK's streaming parser.
- **`test/issue-29-tool-translation.mjs` gained a real SSE parser** (`parseSseEvents`) that splits on blank lines and validates each event group the way a real client parser would — including concatenating multi-line `data:` within an event, which is what the v3.7.0 bug exploited. The test now asserts that every emitted event group parses as valid JSON (regression guard for this exact class of bug), that each logical event carries its own `event:` header, and that passthrough events (`message_start`, `message_stop`) still flow through unchanged. 28 assertions total, all green.

### Test results

- `test/issue-29-tool-translation.mjs` — 28/28 ✅ (up from 21 in v3.7.0; 7 new assertions specifically guard the SSE event-group framing)
- `test/compat.mjs` — 10/10 ✅ (including streaming tests against a live proxy running the v3.7.1 code)
- `test/e2e.mjs` — 12/12 ✅
- Stealth suite — same pre-existing `five_hour` vs `seven_day` and effort-ratio failures we've documented in the [#32 discussion](https://github.com/askalf/dario/discussions/32); unrelated to this release.

### Compatibility

No public API changes. No behavior change for clients that were working on v3.7.0 (they were primarily non-streaming tool-use clients, which use `reverseMapResponse` rather than the streaming mapper). The streaming tool-use path is the one that was broken, and it's the one this release fixes.

## [3.7.0] - 2026-04-14

Two community-driven fixes. macOS keychain credential detection (PR #30 by [@iNicholasBE](https://github.com/iNicholasBE)) and reverse-direction tool parameter translation (#29, contributed by [@boeingchoco](https://github.com/boeingchoco)).

### Fixed

- **macOS keychain credential detection** ([#30](https://github.com/askalf/dario/pull/30) by [@iNicholasBE](https://github.com/iNicholasBE)). Modern Claude Code versions (since ~1.0.17) store OAuth tokens in the OS credential store instead of `~/.claude/.credentials.json`. Dario's `loadCredentials()` only checked file paths, so on macOS it never found existing CC credentials and always fell through to its own OAuth flow even when CC was installed and logged in. Adds `loadKeychainCredentials()` as a fallback after the file-based checks. macOS path uses `security find-generic-password -s "Claude Code-credentials" -w`. Linux path uses `secret-tool lookup service "Claude Code-credentials"` for systems with libsecret. Windows is explicitly stubbed for a follow-up. Calls use `execFile` (not shell) with a 5s timeout, validate the parsed payload has `claudeAiOauth.accessToken` shape, and fall through silently on any failure so the existing OAuth flow still runs as the final fallback.

- **Reverse-direction tool parameter translation** ([#29](https://github.com/askalf/dario/issues/29), reported by [@boeingchoco](https://github.com/boeingchoco)). The forward-direction tool mapping (client tool name → CC tool name + parameter shape) had `translateArgs` callbacks per mapping that rewrote client args into CC's parameter shape before the upstream request. The reverse direction (CC tool_use response → client tool name + parameter shape) only rewrote the **name**, not the **parameter shape**, which left the client receiving tool calls in CC's parameter format against its own validator's schema. For OpenClaw and similar agent frameworks that map their native tools (`process`, `read`, `memory_get` with parameters `action`/`path`/`path`) onto CC's tools (Bash, Read, Glob with parameters `command`/`file_path`/`pattern`), the resulting mismatch caused hard validation errors that prevented any tool execution. Fixed by:

  - Adding `translateBack` callbacks to every non-trivial entry in `TOOL_MAP`, each producing the *primary* client field name from the forward function's `||` chain. For example, the `process` mapping forward function `(a) => ({ command: a.action || a.cmd || '' })` gets a reverse `(a) => ({ action: a.command ?? '' })`.
  - Rewriting `reverseMapResponse` to be JSON-aware: it now parses the upstream body, walks the `content` array, and applies each mapping's `translateBack` to every `tool_use.input` block. Unparseable bodies (errors, partial chunks) pass through unchanged.
  - Adding `createStreamingReverseMapper` for SSE responses. Tool_use input arrives as `input_json_delta` partial_json fragments that don't form valid JSON until `content_block_stop`. The streaming mapper buffers fragments per content block, parses the assembled input on stop, applies `translateBack`, and emits a single synthetic delta with the translated input followed by the original stop event. Trade-off: clients that consume tool_use input as it streams will see it arrive at end-of-block instead of character-by-character. For tool input (typically <1KB) that's acceptable; the alternative is the validation-error class this fix exists to eliminate. Clients that need streaming tool input fidelity can use `--preserve-tools` to skip the entire forward/reverse mapping layer.

### Added

- **`test/issue-29-tool-translation.mjs`** — self-contained regression test for the #29 fix. Builds a tool map from a fabricated OpenClaw-style client request, simulates upstream Anthropic responses (both non-streaming and streaming, including a byte-by-byte split-mid-line stress case), and asserts the translated output contains the client's parameter shape rather than CC's. Runs in-process without OAuth or a live proxy, so it executes on a fresh checkout. 21/21 assertions green at v3.7.0.
- **`npm test`** wired to run the regression test by default. The pre-existing `npm run e2e` and `npm run compat` continue to require a live proxy and OAuth credentials.
- **`ToolMapping` interface exported** from `cc-template.ts` for type narrowing in `proxy.ts` and for downstream consumers that want to inspect the active tool map.

### Test results

- `test/issue-29-tool-translation.mjs` — 21/21 ✅ (new)
- `test/compat.mjs` — 10/10 ✅ (covers tool use, streaming, OpenAI compat — the surface this release touches)
- `test/e2e.mjs` — 12/12 ✅
- `test/stealth-test.mjs` — 6/11 — the 5 failures are pre-existing test infrastructure issues unrelated to this release (subscription-window state in the test account has rolled from `five_hour` to `seven_day` after sustained development traffic, and the high-vs-medium effort ratio test is a known noisy heuristic). Same pattern as v3.4.5 and v3.5.0 release tests; not a regression.

### Compatibility

No public API removed. `ToolMapping` is now exported but was previously the same shape internally. Single-account dario users see no behavior change. Pool-mode users see no behavior change. OpenClaw / Hermes / Aider / any client that was hitting the parameter mismatch should see immediate fix on upgrade with no config changes required.

## [3.6.1] - 2026-04-13

Docs-only release to ship the full positioning rewrite that should have landed with v3.6.0. No code changes; functionally identical to v3.6.0.

### Changed

- **Full README rewrite around the multi-provider story.** Dario's identity is no longer "Claude subscription proxy" — it is "a local LLM router, one endpoint on your machine, every provider behind it." The Claude subscription path is now framed as one of several backends (and the most thoroughly developed one), not as dario's primary purpose. The OpenAI-compat backend shipped in v3.6.0 is now above the fold, not tucked into a section near the end. The "Who this is for" block, first use case, "Why switch" self-qualifier, and quickstart all lead with the multi-provider reality instead of the Claude-only legacy framing.
- **`package.json` description** updated from "Use your Claude subscription as an API. No API key needed. Local proxy for Claude Max/Pro subscriptions." to "A local LLM router. One endpoint, every provider — Claude subscriptions, OpenAI, OpenRouter, Groq, local LiteLLM, any OpenAI-compat endpoint — your tools don't need to change." This change is visible on the npm package page.
- **`package.json` keywords** reordered and expanded: `llm`, `llm-router`, `multi-provider`, `openai-compat`, `openrouter`, `groq`, `litellm`, `ollama` added alongside the existing Claude-centric keywords. Search discoverability was previously anchored on Claude-only terms.
- **README contributor row, FAQ entries, trust table, and all internal links preserved.** The structural spine (Nathan-widjaja's promise → who → first use → why switch → proof) from #21 is kept intact; content inside each section was rewritten around the new backends-first framing.

### Why ship this as a separate release

The v3.6.0 code shipped multi-provider routing but the README still positioned dario as a Claude proxy with multi-provider as a feature. That mismatch meant anyone landing on npm or GitHub would read the wrong story about what dario is, even though the binary they'd install was correct. A docs-only release is the right tool for fixing that — the running bits are unchanged, npm's package page updates, and anyone installing v3.6.1 gets the same runtime as v3.6.0 with the right narrative.

No behavior change, no migration required, nothing deprecated.

## [3.6.0] - 2026-04-13

Multi-provider routing. Dario stops being Claude-only.

### Added
- **Secondary OpenAI-compat backend.** `dario backend add openai --key=sk-...` configures an OpenAI-compat endpoint that dario routes GPT-family model requests to. Works with any OpenAI-compatible provider — OpenAI, OpenRouter, Groq, a local LiteLLM, Ollama's OpenAI-compat mode — via `--base-url=https://your-provider/v1`. Credentials stored at `~/.dario/backends/<name>.json` with mode 0600. Multiple backends can be listed and removed independently.
- **`dario backend` CLI.** `dario backend list`, `dario backend add <name> --key=<api-key> [--base-url=<url>]`, `dario backend remove <name>`.
- **Routing branch in the proxy.** When an OpenAI-compat backend is configured and a request arrives at `/v1/chat/completions` with a GPT-family model name (`gpt-*`, `o1-*`, `o3-*`, `o4-*`, `chatgpt-*`, `text-davinci-*`, `text-embedding-*`), dario forwards the request as-is to the backend's `baseUrl`, swaps the Authorization header to the configured API key, and streams the response back. No template replay, no identity injection, no Claude-side processing — the client is already speaking OpenAI format, the backend is OpenAI-compat, dario is just the local router.
- **Programmatic API:** `listBackends`, `saveBackend`, `removeBackend`, `getOpenAIBackend`, `isOpenAIModel`, and `BackendCredentials` exported from `@askalf/dario` for library users.

### Why
Per-request template replay, framework scrubbing, and multi-account pool routing all reduce dario's exposure to Anthropic's classifier, but they keep dario in a 1:1 game with one vendor — every move Anthropic makes requires a counter-move in dario. Adding a second provider changes the game board: when dario speaks to Claude *and* OpenAI (and any OpenAI-compat endpoint — OpenRouter, Groq, self-hosted LiteLLM, local Ollama), the value proposition stops being "beat the Claude classifier" and starts being "the local router between any LLM and any tool on your machine." If Anthropic tightens a knob, traffic for affected workloads shifts to another backend. If they ship their own subscription-via-API, the Claude backend simplifies and keeps working. Dario wins either way.

This release is the smallest clean slice of that architecture: one secondary backend, one routing branch, zero change to the existing Claude path.

### Not in this release
- **Cross-format translation.** Requests at `/v1/messages` (Anthropic format) with GPT-family model names fall through to the existing Claude-side handling (where they map to Claude equivalents). Anthropic→OpenAI request translation, including tool_use format conversion, lands in a follow-up.
- **Multiple simultaneous openai-compat backends.** Only the first configured backend is active for routing. Per-model backend selection (`gpt-*` → OpenAI, `llama-*` → Groq, `mixtral-*` → OpenRouter) is a follow-up release.
- **Fallback rules.** "If Claude 429s, use Gemini" is a v3.7.0+ goal. v3.6.0 ships the routing plumbing; fallback logic ships on top of it.

No behavior change for Claude-only users. Pool mode and everything else from v3.5.0 keeps working unchanged. Secondary backends are additive.

## [3.5.0] - 2026-04-13

Multi-account pool mode — the first new user-visible capability since template replay.

### Added
- **Multi-account pool mode.** Dario can now manage multiple OAuth accounts and route requests by per-account headroom. Pool mode activates automatically when `~/.dario/accounts/` contains 2+ entries. Single-account dario (the default) is unchanged and keeps using `~/.dario/credentials.json`.
- **`dario accounts` CLI.** New subcommand group: `dario accounts list`, `dario accounts add <alias>`, `dario accounts remove <alias>`. Each account runs its own PKCE OAuth flow — using the same auto-detected CC OAuth config the single-account path uses, not a hardcoded client_id — and lives in `~/.dario/accounts/<alias>.json`. Accounts refresh on independent 15-minute background ticks.
- **`GET /accounts` endpoint.** Read-only JSON snapshot of the pool: per-account utilization (5h and 7d), billing claim, status, request count, token TTL. Returns `{mode: "single-account", accounts: 0}` when pool mode is not active.
- **`GET /analytics` endpoint (pool mode).** Per-account and per-model stats, utilization trends in 5-minute buckets, burn-rate estimates, window-exhaustion predictions. Infrastructure scaffolded in this release; request-recording hook lands in v3.5.1 along with the full failover work.
- **Programmatic pool API.** `AccountPool`, `parseRateLimits`, `loadAllAccounts`, `addAccountViaOAuth`, `refreshAccountToken`, `Analytics`, and related types exported from `@askalf/dario` for library users.

### Changed
- **Pool-mode request dispatch.** When pool mode is active, every incoming request picks the account with the highest headroom (`1 - max(util5h, util7d)`) and uses that account's access token and device identity for the upstream call. After the response returns, the account's rate-limit snapshot is updated from the response headers so the next selection reflects fresh utilization. A 429 from the upstream marks the account `rejected` and routes subsequent requests elsewhere until reset.
- **Session ID handling.** Pool mode uses a per-account stable session ID (one per account per proxy lifetime). Single-account mode continues to rotate the session ID per request exactly as before. No behavior change for single-account users.

### Ported from mux
Three modules from `askalf/mux` lifted into dario with minimal adaptation:

- `src/pool.ts` — headroom-aware account selection, failover target selection (`selectExcluding`), request queueing when all accounts are exhausted, drain-on-headroom loop. ~270 lines.
- `src/accounts.ts` — per-account credential storage, independent OAuth refresh lifecycle, PKCE flow using dario's auto-detected CC OAuth config (not the hardcoded dev client_id mux was shipping). ~270 lines.
- `src/analytics.ts` — rolling request history, per-account and per-model stats, burn-rate prediction, exhaustion estimates. ~320 lines.

### Known scope for v3.5.1 (not in this release)
- **Request-path 429 failover.** v3.5.0 wires pool mode for headroom-aware selection *across* requests and marks accounts rejected when they 429, so the *next* request routes to a different account. It does not yet retry a single in-flight request against the next account when that request 429s — if an account 429s mid-request, that request returns the enriched 429 to the client, and subsequent requests go to a different account. Full inside-request failover ships in v3.5.1.
- **Analytics recording.** The `/analytics` endpoint is live and the `Analytics` class is in place; hooking `analytics.record()` into the proxy response path ships alongside the failover work in v3.5.1.

No behavior change for single-account dario. Pool mode is opt-in by adding a second account.

## [3.4.6] - 2026-04-13

### Changed
- **Full README rewrite** — Positioning pass using [@nathan-widjaja](https://github.com/nathan-widjaja)'s structure from #21 as the baseline. Top-of-page now leads with a one-line promise, a who-this-is-for block, a first use case, and a self-qualifier "Why switch" section before any mechanics. Dario is explicitly framed as "the local bridge for your Claude subscription — standalone today, also the local edge of [askalf](https://askalf.org) when your workload outgrows a single subscription." Standalone mode remains the first-class default; askalf linkage is the progression rather than the requirement.
- **Removed** the AI-reviews social-proof block and the vs-competitors collapsible table. Both were scrolling past the first-screen buyer question rather than helping it land.
- **Condensed** the per-tool usage sections (Hermes/OpenClaw/Cursor/Continue/Aider) into a single OpenAI-compatible block with a note that anything accepting an OpenAI base URL works. The Python, TypeScript, curl, and streaming examples stay.
- **Surfaced** the #23 session-level-classifier FAQ entry (added in v3.4.5) alongside the existing rate-limit entry so anyone hitting the same wall finds the answer without scrolling past the full mechanics section.
- **Added** a "From standalone to askalf" section that explicitly names the capabilities linkage would add (multi-account pooling, session shaping, browser/desktop control, scheduling, persistent memory) and reserves `dario link` as the command that will pair a local instance with an askalf account once the bridge endpoint is live.

No behavior or code changes — this release exists to update the npm-published README to match the repo. Functionally identical to 3.4.5.

## [3.4.5] - 2026-04-13

### Fixed
- **Framework identifiers are now scrubbed from message content, not just the system prompt** (follow-up to #23) — `FRAMEWORK_PATTERNS` was previously only applied to `systemText` in `buildCCRequest`, so a framework name like `OpenClaw` or an OC-specific tool-prefix like `sessions_get` inside a user message or `tool_result` block passed through to upstream unchanged. The scrub now covers string message content, `text` blocks, and `tool_result` content in both string and array forms. Logic factored into an exported `scrubFrameworkIdentifiers()` helper.
- **Broadened fingerprint pattern list** — Added `roo-cline`, `big-agi`, `librechat`, `typingmind`, `claude-bridge`, and the `sessions_*` tool-name prefix (flagged as an OC fingerprint during the #23 diagnostic work). Compound patterns run before single-word ones so compound matches can't be partially eaten by the more general rules.
- **Additional orchestration tag names** in the proxy-level sanitizer: `agent_persona`, `agent_context`, `tool_context`, `persona`, `tool_call`. These are inline tags some agent frameworks inject into message content that would otherwise survive to upstream.

### Changed
- **README positioning pass** — Dario is now framed as the *per-request layer* throughout, with session- and account-level concerns routed explicitly to askalf. The "Detection resistance" row is scoped to the per-request level. The askalf section was rewritten from defensive ceiling language to active scope definition — dario and askalf solve different layers, and solving session-level concerns at the per-request layer is a category error. New FAQ entry directly answers "my multi-agent workload got reclassified to overage, why?" by naming the classifier mechanism, crediting the #23 diagnostic work, and routing session-layer shaping to askalf.

## [3.4.4] - 2026-04-13

### Fixed
- **OAuth scope list was incomplete — `dario login` could fail on authorize with the v3.4.3 scanner.** The v3.4.3 OAuth scanner returned 4 scopes (`user:profile user:inference user:sessions:claude_code user:mcp_servers`) because its scope-detection regex anchored on the string `"user:profile "` and happened to match an error-message string literal inside the CC binary (used by `claude setup-token` help output) rather than the real scope array. Real CC's normal `claude login` flow uses the `n36` scope union, which is 6 scopes including `org:create_api_key` and `user:file_upload`. The prod `client_id` enforces the correct scope set, so the short list from v3.4.3 was rejected by the authorize endpoint for any user who upgraded and tried to log in fresh. Removed scope auto-detection from the scanner entirely (the real scope array is stored as a constant-reference array in minified JS, where the first two elements are variable references rather than literal strings, so no regex can reliably extract it). Scope list is now hardcoded to the full 6-element `n36` union in the scanner's fallback. Scopes rarely change across CC releases; hardcoding is more reliable than scanning.
- **Cache file renamed to `~/.dario/cc-oauth-cache-v3.json`** — invalidates v3.4.3 caches that were populated with the wrong 4-scope list. On first run after upgrade, dario re-scans and writes the correct value. No manual cleanup required.

### Added
- **Client-disconnect abort on upstream fetches** — When a client disconnects mid-response (browser tab closed, OpenAI-compat tool killed, network blip), dario now aborts the upstream fetch to Anthropic so quota isn't wasted on responses nobody will read. Previously dario would keep streaming from Anthropic until the 5-minute upstream timeout fired. Single `AbortController` per request covers both the timeout and the client-disconnect abort. Catch block differentiates timeout/client-close/other so each gets the right response (504 / silent / 502). Pattern ported from openclaw-claude-bridge's subprocess lifecycle handling, adapted for dario's HTTP-proxy shape.

### Changed
- **README and OAuth E2E test updated to match the v3.4.3 scanner semantics** — earlier versions of this test still asserted against the deprecated cache path and inverted the client_id assertions. All 15 checks now pass against a real CC 2.1.104 binary.
- **CI actions bumped** — `actions/checkout@v4` → `@v5` and `actions/setup-node@v4` → `@v5` across `ci.yml`, `publish.yml`, `codeql.yml`. Clears a Node 20 deprecation warning we saw during the v3.4.3 publish run. Previously on v4 which still ran on Node 20.
- **3.4.1 CHANGELOG entry tightened** — the `--cli` removal description was over-explained in a prior docs commit; now reads as a tight summary of why our specific implementation was removed.

## [3.4.3] - 2026-04-13

### Added
- **`--host` flag / `DARIO_HOST` env var** — Override the bind address. Default stays `127.0.0.1` so the out-of-the-box behavior is unchanged. Set to `0.0.0.0` to accept LAN connections, or to a specific IP (e.g. a Tailscale interface) to bind selectively. When binding to anything non-loopback, dario prints a warning at startup reminding you to set `DARIO_API_KEY` — otherwise any host that can reach the port can proxy requests through your OAuth subscription. (#20)
- **`DARIO_CORS_ORIGIN` env var** — Override the browser-CORS `Access-Control-Allow-Origin` value. Defaults to `http://localhost:${port}` so existing setups behave the same. Useful for browser-based clients (open-webui, librechat, etc.) connecting to dario over a Tailscale mesh, which need the CORS origin to match the host they're actually hitting.

### Fixed
- **Critical: OAuth login failures on v3.3.0-v3.4.2** — `dario login` and `dario refresh` have been failing with `Invalid client id provided` / `Client with id [uuid] not found` for a growing number of users over the last 24-48 hours. Root cause: the `cc-oauth-detect.ts` scanner introduced in v3.4.0 anchored on `OAUTH_FILE_SUFFIX:"-local-oauth"` to find the OAuth config inside the installed CC binary, and extracted `CLIENT_ID: 22422756-60c9-4084-8eb7-27705fd5cf9a`. That block turns out to be **dead code** in shipped CC builds — it's the config CC uses when targeting Anthropic's internal localhost dev stack (`http://localhost:8000`/`4000`/`3000` as API hosts), selected only when an internal environment switch returns `"local"`. Shipped CC binaries hardcode that switch to `"prod"` and use the `nh$` config instead, which carries `CLIENT_ID: 9d1c250a-e61b-44d9-88ed-5944d1962f5e`. The scanner was extracting a client_id that CC itself never uses at runtime. Anthropic's authorize endpoint had previously been lenient enough to accept the dev client_id in addition to the prod one; recent tightening on their side started rejecting it, which is why this surfaced as a cliff failure. Credit to @belangertrading who identified the correct client_id in #12 — the earlier rebuttal was mistaken on both directions (switching to `9d1c250a-` does *not* cause `invalid_redirect_uri`; the prod client is registered with `http://localhost:${port}/callback` exactly as dario sends).
- **Scanner re-anchored on `BASE_API_URL:"https://api.anthropic.com"`** — This literal only appears inside the prod config block, so the scanner now reliably lands inside the right object regardless of how the minifier reorders fields across CC releases. Defensive check rejects a scan result if it matches the known-dead dev UUID.
- **Cache file renamed to `~/.dario/cc-oauth-cache-v2.json`** — Invalidates v3.4.0-v3.4.2 caches that pinned the wrong client_id. On first run after upgrade, dario re-scans the installed CC binary and writes the correct value. No manual cache clearing required.
- **Fallback values updated to CC 2.1.104 prod config** — Clients running dario without CC installed locally now fall back to the same values real CC uses, not the dead-code dev values.

### Related
- Likely also resolves #18 (Wysie), #22 (trinhnvgem, iNicholasBE) — same symptom, same root cause.
- Partially resolves #26 — the `credentials.json` missing-`clientId` regression becomes a non-issue once the refresh path reads the correct client_id from the detector rather than expecting it in `credentials.json`.

## [3.4.2] - 2026-04-13

### Added
- **`NotebookRead` tool definition** — Pairs with the existing `NotebookEdit` in the CC template. Added to both `tools` and `tool_names`.
- **Additional client tool aliases** in `TOOL_MAP` — `browser`, `message`, `todo_read`, `notebook_read`, `enter_plan_mode`/`exit_plan_mode`, `enter_worktree`/`exit_worktree`. Each alias routes to a real CC tool that already exists in the template, so third-party agents with non-standard tool names get a clean mapping instead of falling through to the unmapped-tool distributor.

### Fixed
- **`package.json` JSON corruption** — A version-bump helper wrote the file's string representation back out with escaped `\n` instead of real newlines, breaking `npm ci` across the Node 18/20/22 CI matrix. Restored proper formatting.
- **Template tool-list drift from the community tool-mapping PR** — The merged PR added tool definitions for names that aren't part of the real Claude Code tool surface (`Browser`, `TodoRead`, `MCPListTools`, `MCPCallTool`, `TaskCreate`, `TaskUpdate`), and only updated the `tools` array without touching the parallel `tool_names` list, leaving the template internally inconsistent. Removed the non-CC entries so every tool dario advertises to the API matches a real CC tool, and re-synced `tool_names`. Client aliases that previously pointed at the removed names now redirect to the closest real tool (`browser` → `WebFetch`, `todo_read` → `TodoWrite`, etc.).
- **Stray framework reference in `cc-template.ts`** — Replaced the mapping-section header comment with a neutral label.

## [3.4.1] - 2026-04-12

### Removed
- `--cli` / CLI backend mode — Removed. Our implementation proved unreliable in practice: no tool use support, streaming conversion artifacts, and context handling that diverged from real API behavior in multi-turn conversations. The features we added to work around those limitations turned into bug sources faster than they closed the gap. Removed in favor of direct API mode with template replay, which is dario's single supported path going forward.
- **Dead helper functions** — `jsonToSse`, `jsonToOpenaiSse`, `sendCliResponse`, `handleViaCli`, and the CLI auto-fallback branch in the 429 handler. All only reachable through the removed `--cli` mode. ~300 lines of unreachable code.
- **Unused imports** — `spawn`, `writeFileSync`, `unlinkSync`, `tmpdir` (all were CLI-only).
- **Obsolete orchestration tag names** — Removed `tool_exec`, `tool_output`, `skill_content`, `skill_files`, `available_skills` from the tag stripper. These never appeared in real client requests and were carryover from an earlier draft of the sanitization pass.
- **Internal code references in comments** — Stripped references to Claude Code's minified internal function/constant names. Those were useful as working notes during the reverse-engineering pass; nothing to do with what dario does at runtime.

### Changed
- **`proxy.ts` shrank from 1,102 → 837 lines** (~24% smaller) after dead code removal.
- **`detectCli()` → `detectCliVersion()`** — Function now only exists to grab the installed CC version for the per-request build-tag computation. The old name implied a broader "detect CLI availability" role that no longer exists.
- **Rate governor comment** — Rewritten to describe *what* the limit does, not *why* a specific subprocess invocation pattern motivated it.
- **Mode line on proxy startup** — Simplified to 2 states (passthrough vs. OAuth) instead of 3.

## [3.4.0] - 2026-04-12

### Added
- **Auto-detect OAuth config from CC binary** — Dario now scans the installed Claude Code binary at startup and extracts `client_id`, `authorize URL`, `token URL`, and `scopes` directly from the local-oauth config block. Eliminates the "Anthropic rotated the client_id again" class of bugs permanently — dario now stays in sync with whatever CC version the user has installed, forever. See [`src/cc-oauth-detect.ts`](src/cc-oauth-detect.ts).
- **Detector cache** — Scanner results are cached at `~/.dario/cc-oauth-cache.json` keyed by a binary fingerprint (first 64KB sha256 + size + mtime). Cold scan ~500ms, cache hit ~5ms, re-scans only on CC upgrade.
- **Fallback config** — If no CC binary is found or scanning fails, dario falls back to known-good v2.1.104 values so it still works on machines without CC installed.
- **E2E test** (`test/oauth-detector.mjs`) — 12-check validation of the scanner against a real CC binary, including binary-block proof that the detected `client_id` comes from the `OAUTH_FILE_SUFFIX:"-local-oauth"` config block and not the platform-hosted block.

### Fixed
- **Long-context retry now handles HTTP 400** in addition to 429. Anthropic returns the long-context-beta error as 400 for some endpoints (`"long context beta is not yet available for this subscription"`), which was not triggering the existing retry path in v3.3.0. The retry now catches both status codes before auto-retrying without `context-1m-2025-08-07`.

### Technical context
- CC ships **two OAuth client configurations** in one binary: a `-local-oauth` flow (used by clients that run their own localhost callback, like dario) and a platform-hosted flow (used when the callback is on `platform.claude.com`). The two blocks have different `CLIENT_ID` values. Dario must use the `-local-oauth` flow; the scanner anchors on that specific config key to avoid picking up the wrong block.
- Detection is proven against CC v2.1.104. The scanner uses stable string anchors (`OAUTH_FILE_SUFFIX:"-local-oauth"`, `CLAUDE_AI_AUTHORIZE_URL`, `TOKEN_URL`, `"user:profile "`) that are unlikely to change between CC minor versions.

## [3.3.0] - 2026-04-12

### Added
- **`--preserve-tools` mode** — Opt-out of CC tool schema replacement for agent frameworks that rely on their own custom tool definitions. When set, dario keeps the client's exact tool schemas instead of mapping them onto CC's. Use this for agents with bespoke tool parameters that don't fit CC's tool shapes (e.g. deployment tools with `service`/`version` instead of `command`/`description`).
- Corresponding CLI flag and programmatic option (`preserveTools: true`).

### Context
- Default mode (template replay) still remaps client tools to CC's canonical set for maximum detection resistance. `--preserve-tools` is for the subset of agent stacks whose tool semantics get mangled by the remap.

## [3.2.7] - 2026-04-12

### Fixed
- **OAuth login for Max plan accounts (#18)** — Updated OAuth `client_id`, `authorize URL`, and `scopes` to match Claude Code v2.1.104 binary RE:
  - `client_id`: `9d1c250a-…` → `22422756-60c9-4084-8eb7-27705fd5cf9a` (the local-oauth client — see v3.4.0 for why)
  - `authorize URL`: `platform.claude.com/oauth/authorize` → `claude.com/cai/oauth/authorize`
  - `scopes`: removed `org:create_api_key` (Console plan only)
- New users trying to log in with Max plan accounts were getting OAuth errors because the URL/client/scope combination was inconsistent with what CC v2.1.104 actually uses. Existing users with valid tokens are unaffected — only the login flow was broken.

## [3.2.6] - 2026-04-12

### Changed
- **Provenance-attested release** — CI pipeline hardening. No code changes.

## [3.2.5] - 2026-04-12

### Fixed
- **Auto-retry without context-1m on long-context billing error** — When Anthropic returns a 429 with `"Extra usage is required for long context requests"`, dario now automatically retries without the `context-1m-2025-08-07` beta flag. Prevents silent failures on subscriptions without Extra Usage enabled. (v3.4.0 extends this retry to also handle 400 responses.)

## [3.2.4] - 2026-04-12

### Changed
- **1M context is now opt-in via `DARIO_EXTENDED_CONTEXT=1`** — The `context-1m-2025-08-07` beta flag is no longer sent by default because it requires Extra Usage on the Anthropic account. Users who have enabled Extra Usage can turn it back on with the environment variable.

## [3.2.3] - 2026-04-12

### Changed
- **Removed `context-1m-2025-08-07` beta from the default beta set** — It requires Extra Usage to be enabled on the Anthropic account and was causing 400 errors for Max plan users without Extra Usage turned on.

## [3.2.2] - 2026-04-12

### Changed
- **Provenance-attested release** — CI pipeline hardening. No code changes.

## [3.2.1] - 2026-04-12

### Fixed
- **CLI fallback masking 429 errors** — When the API returned 429 and the CLI fallback also failed (e.g. on ARM64 where `claude --print` may not work), dario returned a cryptic 502 instead of the actual rate limit details. Now returns the original 429 with enriched utilization and reset time.

## [3.2.0] - 2026-04-12

### Added
- **Bun auto-relaunch** — If Bun is installed, dario automatically relaunches under Bun runtime. Bun's TLS fingerprint (BoringSSL, cipher suites, extensions) matches Claude Code's runtime exactly. Node.js had a different TLS fingerprint visible at the network level. Set `DARIO_NO_BUN=1` to disable.
- **Session ID rotation** — Each request gets a fresh session ID, matching CC `--print` behavior where each invocation creates a new session. A persistent session ID across many rapid requests was a behavioral signal.
- **Rate governor** — 500ms minimum interval between requests prevents inhuman request cadence. Configurable via `DARIO_MIN_INTERVAL_MS`. CC `--print` takes ~2-3s per invocation — rapid-fire requests don't match any legitimate usage pattern.

## [3.1.1] - 2026-04-12

### Fixed
- **Unicode encoding in template data** — System prompt and tool descriptions had corrupted em-dashes from Windows encoding. Regenerated from MITM capture with correct UTF-8. Byte-exact match confirmed.
- **Haiku 400 error** — `context-1m-2025-08-07` beta was sent unconditionally but is only valid for Sonnet 4.6. Now model-conditional.

## [3.1.0] - 2026-04-12

### Changed
- **Full CC fidelity** — Complete overhaul of template replay. All data now auto-extracted from MITM capture of CC v2.1.104 rather than manually reconstructed.
- **25 tool definitions** from MITM capture (was 11 hardcoded). Includes CronCreate, CronDelete, CronList, EnterPlanMode, ExitPlanMode, EnterWorktree, ExitWorktree, Monitor, RemoteTrigger, ScheduleWakeup, Skill, TaskOutput, TaskStop, TodoWrite.
- **CC's 25KB system prompt** injected as base, client prompt appended (was using client prompt only).
- **Template data** stored as JSON file (`cc-template-data.json`), loaded at runtime for easy updates when CC changes.
- **User-Agent** removed `workload/cron` (CC doesn't send it for standard requests).
- **Billing header** removed `cc_workload` (CC only adds it for actual cron jobs).

## [3.0.4] - 2026-04-12

### Fixed
- **Token refresh spam** — When refresh failed, every subsequent request retried immediately, flooding the console. Added 60s cooldown between retry cycles. Falls back to current token during cooldown.
- **Silent refresh failures** — Now logs HTTP status and response body on refresh failure.

## [3.0.3] - 2026-04-12

### Changed
- **MITM-verified beta set** — Reduced from 14 to exact 8 betas CC actually sends at runtime (was sending 6 extras that CC only adds conditionally). Exact order from MITM capture.
- **Body key order** — Matched to MITM capture: `model, messages, system, tools, metadata, max_tokens, thinking, context_management, output_config, stream`.
- **Removed `temperature: 1`** — CC doesn't send it for Agent SDK requests.

## [3.0.2] - 2026-04-12

### Changed
- **Binary RE of CC v2.1.104** — Reverse-engineered latest binary (built 2026-04-12). Found `cc_workload` field, workload tracking in User-Agent, 7 new beta registrations (2 gated/unreleased).
- **Tool arg translation** — Unmapped tools get arguments translated to match CC tool schemas.
- **Tool distribution** — Unmapped tools spread across Bash/Read/Grep/Glob/WebSearch/WebFetch instead of all becoming Bash.
- **tool_result sanitization** — Strips non-standard fields, truncates >30K content.
- **Framework scrubbing** — Strips framework identifiers from system prompts.
- **anthropic-version header** — Hardcoded to `2023-06-01` in non-passthrough mode.

## [3.0.1] - 2026-04-12

### Fixed
- **ESM require crash** — `require('node:child_process')` in `oauth.ts` replaced with `await import()`. Fixes #15.
- **403 error message** — Now lists supported paths (`POST /v1/messages`, `POST /v1/chat/completions`, `GET /v1/models`). Fixes #16.

## [3.0.0] - 2026-04-11

### Changed
- **Template replay architecture** -- Complete rewrite of the stealth layer. Instead of transforming client requests signal-by-signal (tool names, field order, effort, max_tokens), dario now replaces the entire request with a CC template. Only conversation content is preserved from the client request. The upstream sees Claude Code's exact tool definitions, exact field structure, exact everything. Tested with 40 third-party tools -- all route to five_hour. Previous approach failed at 40 tools, 20+ tool names, and various field mismatches.
- **CC tool definitions** -- Real Claude Code tool schemas (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, NotebookEdit, Agent, AskUserQuestion) are sent upstream regardless of what the client sends. Client tool calls are mapped to CC equivalents and reverse-mapped in responses.

## [2.11.0] - 2026-04-11

### Added
- **Tool count cap** -- Tools capped at 22 (CC range). Excess consolidated into dispatch wrapper.
- **Cache control stripping** -- Client cache_control removed from messages.

## [2.10.0] - 2026-04-11

### Added
- **Tool name rewriting** -- Anthropic fingerprints on tool names. Non-CC names (exec, wiki_apply, honcho_context, etc.) trigger overage classification. Dario now rewrites tool names to CC equivalents (exec to Bash, read to Read, web_search to WebSearch) and prefixes unknown tools with mcp_ (matching real CC MCP naming). Reverse-mapped in responses so clients see original names. (#12)

### Changed
- **output_config.effort forced to medium** -- Previously only set when missing, now overrides client value. CC always sends medium; high is a fingerprint.

## [2.9.5] - 2026-04-11

### Fixed
- **`max_tokens` capped at 64000** — Claude Code always sends `max_tokens: 64000`. Clients sending `128000` (e.g. OpenClaw) were triggering overage classification because the value doesn't match the real CC fingerprint. Now hard-capped regardless of client value. (#12)

## [2.9.3] - 2026-04-11

### Changed
- **Removed `@anthropic-ai/sdk` dependency** — was listed as production dep but never imported. dario now has zero runtime dependencies.
- **README updated** — added OpenClaw config example, technical deep dive links (Discussions #1, #8, #9), corrected line counts and dep info.

## [2.9.2] - 2026-04-11

### Fixed
- **CLI mode: array-format system prompts** — `claude --print` only accepts string system prompts. When clients (e.g. OpenClaw) send `system` as an array of content blocks (valid per Anthropic API spec), CLI mode now flattens the blocks to a joined string before passing to the binary. Previously returned `400 Invalid request body`.

## [2.9.1] - 2026-04-11

### Changed
- Updated README with v2.9.0 stealth layer documentation
- Corrected effort default from `high` to `medium` in feature list
- Removed `service_tier: auto` reference (now scrubbed)
- Updated passthrough mode description (Hermes/OpenClaw work through default mode)

## [2.9.0] - 2026-04-11

### Added
- **Thinking block stripping**: Strips `thinking` type blocks from all assistant messages before forwarding upstream. The API's `context_management: clear_thinking` does NOT reduce input token billing — tokens are counted before server-side edits. Client-side stripping is the only way to prevent stale thinking traces from burning the 5h window. Reduces per-request input tokens by 50-80% on multi-turn conversations with thinking enabled.
- **Non-CC field scrubbing**: Removes `temperature`, `top_p`, `top_k`, `stop_sequences`, and `service_tier` from requests. Real Claude Code never sends these fields — their presence is a detectable fingerprint.
- **JSON field reordering**: Rebuilds the request body with Claude Code's exact field order (`model`, `messages`, `system`, `max_tokens`, `thinking`, `output_config`, `context_management`, `metadata`, `stream`, `tools`). JSON field order is a fingerprint signal.
- **System prompt normalization**: Merges any number of system prompt blocks into exactly 3 (billing tag, agent identity, merged system text). Real Claude Code always sends exactly 3 blocks — sending 4+ is detectable.
- **Beta deduplication**: Client-provided betas are deduplicated against the base set before appending, preventing duplicate beta headers upstream.

### Changed
- **Beta set updated**: Added `fine-grained-tool-streaming-2025-05-14` and `fast-mode-2026-02-01` from Hermes framework analysis

## [2.8.7] - 2026-04-10

### Fixed
- **`cch` now uses `crypto.randomBytes`**: MITM testing proved real Claude Code generates a random 5-hex-char `cch` per request (10 identical requests → 10 unique values). Previous SHA-256 approach was deterministic and detectable.
- **Removed `x-client-request-id` header**: Real Claude Code does not send this header for external OAuth sessions (only for firstParty deployments). Dario was adding it, creating a detectable mismatch.
- **Confirmed build tag algorithm**: Verified `Oz$` via 5 identical captures — build tag is deterministic from `SHA-256(seed + user_chars[4,7,20] + version).slice(0,3)`, confirmed matching real Claude Code output.

## [2.8.6] - 2026-04-10

### Changed
- **System prompt structure parity**: System prompt now sent as 3 separate blocks matching real Claude Code — billing tag (no cache), agent identity (1h cache), system prompt (1h cache) — instead of a single concatenated string
- **Beta header order**: Reordered to match real Claude Code (`claude-code-20250219` first, not `oauth` first)
- **Default effort**: Changed from `high` to `medium` matching Claude Code's default
- **Default max_tokens**: Set to 64000 matching Claude Code's default (was 16000)
- **Runtime version**: Reports `v24.3.0` (Bun's Node compat version) instead of actual Node version
- **Removed `service_tier: auto`**: Real Claude Code does not send this field

## [2.8.5] - 2026-04-10

### Fixed
- **Billing reclassification after sustained use**: Fixed `cch` checksum from stale `98638` — Anthropic validates this server-side and reclassifies requests to overage billing when the checksum is invalid (#7)
- **Per-request billing tag computation**: Build tag and `cch` checksum are now computed dynamically per request using the same SHA-256 algorithm as real Claude Code (extracted via binary RE), instead of static values that could trigger server-side detection
- **Request fingerprint parity**: `x-stainless-timeout` now varies per request matching real Claude Code behavior
- **Stale fallback version**: Default version bumped from `2.1.96` to `2.1.100`

### Credits
- @belangertrading — reported billing reclassification pattern, provided debug data that led to root cause (#7)

## [2.8.3] - 2026-04-10

### Fixed
- **CLI E2BIG on large conversations**: System prompt now written to temp file via `--append-system-prompt-file` instead of passed as command-line argument, removing the OS arg size limit (~2MB) that crashed multi-turn agent conversations (#7)
- **npm provenance**: Re-published via CI for signed provenance attestation

## [2.8.1] - 2026-04-10

### Fixed
- **Haiku 400 on effort parameter**: `output_config.effort` is now skipped for Haiku 4.5, which does not support it

### Changed
- **Code reduction**: 1,618 → 1,505 lines (−7%) — merged duplicate CLI detection, extracted shared CLI response handler, removed dead token anomaly detection and extended context cooldown
- **Cleaner imports**: Removed redundant `chmod` call, replaced `require('fs')` with proper ESM import, explicit `scopes` field instead of object spread

## [2.8.0] - 2026-04-10

### Added
- **`--passthrough` mode**: Thin proxy — OAuth swap only, no billing tag, thinking, service_tier, or device identity injection. For Hermes/OpenClaw/tools that need exact protocol fidelity
- **CLI streaming**: `--cli` mode now returns SSE when client requests `stream: true` (both Anthropic and OpenAI formats)
- **`output_config.effort`**: Passes through client effort level or defaults to `high` for reasoning models
- **Enriched 429 errors**: Rate limit errors now include utilization %, limiting window, and reset time instead of just "Error"
- **E2E test suite**: `npm run e2e` — 12 tests covering all models, streaming, OpenAI compat, tool use, rate limit headers

## [2.7.1] - 2026-04-10

### Fixed
- **Haiku 400 error**: Adaptive thinking and context management are now skipped for Haiku 4.5, which does not support thinking

## [2.7.0] - 2026-04-10

### Changed
- **Adaptive thinking**: Switched from deprecated `thinking: { type: 'enabled', budget_tokens: N }` to `{ type: 'adaptive' }` — model decides when and how much to think, matching Claude Code behavior exactly
- **Priority capacity**: Requests now include `service_tier: 'auto'` to access priority capacity pool when available (50% fallback allocation confirmed via response headers)
- **Effort beta**: Added `effort-2025-11-24` beta flag matching CLI v2.1.100

## [2.6.0] - 2026-04-10

### Fixed
- **Opus/Sonnet 429 at high utilization**: Requests now get priority routing through Anthropic's model-specific rate limits instead of the overall API quota. Previously, Opus/Sonnet would 429 when overall 7d utilization was high, even though model-specific limits had headroom.

### Added
- **Priority routing**: Injects Claude Code billing classification into system prompt, matching native CLI behavior. This activates per-model rate limit evaluation (e.g., `7d_sonnet: 5%` instead of overall `7d: 100%`).
- **Automatic CLI fallback**: If the API returns 429 and Claude Code is installed, transparently retries through `claude --print` with SSE conversion for streaming clients. Works for both Anthropic and OpenAI endpoints.

### Credits
- @belangertrading — reported 429 issue, diagnosed OAuth vs CLI routing difference, built the CLI fallback workaround (#6)

## [2.5.0] - 2026-04-10

### Changed
- **Full Claude Code feature parity**: Request body now matches native Claude Code exactly — `thinking`, `context_management`, full beta set, device identity
- **Billing classification confirmed**: MITM analysis proves billing is determined solely by the OAuth token's subscription type, not by headers, betas, or metadata. All previous billing-related workarounds were unnecessary.
- Restored `context-management-2025-06-27` and `prompt-caching-scope-2026-01-05` beta flags (safe for all subscription types — confirmed via A/B testing against Anthropic API)
- Only `extended-cache-ttl-*` is filtered from client betas (the only prefix that actually requires Extra Usage)

### Added
- **Extended thinking**: Automatically enables `thinking` with budget matching `max_tokens` (matches Claude Code default behavior)
- **Context management**: Injects `context_management` body field for automatic thinking compaction
- **Billing classification logging**: First request and verbose mode log the unified rate limit claim and overage utilization

### Credits
- @belangertrading — reported billing classification issue, tested v2.3.1 through v2.5.0, confirmed fix via response header analysis (#4)

## [2.4.0] - 2026-04-10

### Fixed
- **Max plan billing classification**: Requests now include device identity metadata (`metadata.user_id`) matching native Claude Code — prevents Anthropic from routing usage to Extra Usage instead of Max plan allocation
- Append `?beta=true` to upstream API URL matching native Claude Code behavior
- Beta flags updated to match Claude Code v2.1.98 (adds `advisor-tool-2026-03-01`, restores `context-management` and `prompt-caching-scope`)

### Added
- **Billable beta filtering**: Strips `extended-cache-ttl-*`, `context-management-*`, `prompt-caching-scope-*` from client-provided betas to prevent surprise Extra Usage charges
- **Orchestration tag sanitization**: Strips agent-injected XML tags (`<system-reminder>`, `<env>`, `<task_metadata>`, etc.) from message content before forwarding
- **Token anomaly detection**: Warns on suspicious patterns — context spike (>60% input growth), output explosion (>2x previous turn)
- **1M extended context support**: `opus1m` and `sonnet1m` model aliases with automatic 1-hour cooldown fallback on Extra Usage failure

## [2.3.1] - 2026-04-09

### Fixed
- Remove `context-management-2025-06-27` and `prompt-caching-scope-2026-01-05` from default beta flags — these may require Extra Usage and cause billing errors for Max users with Extra Usage disabled
- Only essential betas are included by default (`oauth`, `interleaved-thinking`, `claude-code`); client-provided betas still pass through

## [2.3.0] - 2026-04-09

### Fixed
- OpenAI streaming now translates tool_use blocks (previously silently dropped — tools via `/v1/chat/completions` in streaming mode now work)
- Verbose logging no longer leaks query parameters (uses path only)
- Background token refresh now handles 'expired' status, not just 'expiring'

### Added
- Concurrency control: max 10 concurrent upstream requests with FIFO queuing (prevents request flooding)

## [2.2.4] - 2026-04-09

### Changed
- Move AI reviews to top of README as 3-column trust table
- Add Trust link to nav bar

## [2.2.3] - 2026-04-09

### Added
- Google Gemini independent code review in README

## [2.2.2] - 2026-04-09

### Added
- GitHub Copilot (Microsoft) independent code review in README

## [2.2.1] - 2026-04-09

### Added
- Grok (xAI) independent code review testimonial in README

## [2.2.0] - 2026-04-09

### Security
- Add 30-second body read timeout to prevent slow-loris attacks
- Cap CLI backend stdout/stderr at 5MB to prevent OOM on runaway output
- Broaden Bearer token redaction regex — tokens with dots/slashes no longer leak
- Add security headers to all responses (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`)

### Fixed
- CLI backend (`--cli`) now works with OpenAI-compatible endpoint (`/v1/chat/completions`)
  - Previously, `--cli` + Cursor/Continue would bypass CLI and hit API directly
  - Now translates OpenAI → Anthropic before CLI, and Anthropic → OpenAI after

### Added
- `dario version` / `dario --version` / `dario -V` command

## [2.1.2] - 2026-04-09

### Changed
- README: lead with Cursor/Continue in tool list for discoverability
- README: add "Also by AskAlf" ecosystem section
- README: fix line count (~1000 → ~1100)

## [2.1.1] - 2026-04-09

### Security
- Validate model names before passing to CLI spawn (alphanumeric, hyphens, dots only)
- Cap SSE stream buffer at 1MB to prevent OOM on malformed responses
- Sanitize CLI stderr output before forwarding to clients

## [2.1.0] - 2026-04-09

### Added
- Optional proxy authentication via `DARIO_API_KEY` env var with timing-safe comparison
- JWT and Bearer token redaction in error sanitization
- `sanitizeError` exported from public API

### Changed
- CORS scoped to actual proxy port instead of all of localhost
- Shared `sanitizeError` across all error paths (eliminated duplication)

### Security
- Credit: @GodsBoy (cherry-picked from PR #2), @belangertrading (billing investigation #4)

## [2.0.0] - 2026-04-08

### Added
- **OpenAI API compatibility** — `POST /v1/chat/completions` endpoint
- Automatic model mapping (gpt-4 → opus, gpt-3.5-turbo → haiku, etc.)
- OpenAI SSE streaming format translation
- OpenAI-compatible `/v1/models` endpoint
- Works with any OpenAI SDK, Cursor, Continue, LiteLLM, and more

## [1.2.1] - 2026-04-08

### Fixed
- `/health` and `/status` endpoints now handle query parameters correctly
- Removed 76 lines of dead code (startOAuthFlow, exchangeCode, unused imports)
- Deduplicated OAuth scope string into constant

### Added
- Trust & Transparency section in README with verification commands
- CHANGELOG.md with full version history
- CODEOWNERS file for code review enforcement
- npm audit in CI pipeline (`--production --audit-level=high`)
- Security badges (npm, CI, CodeQL, license, downloads)
- Branch protection (CI required before merge)
- Response SLA in SECURITY.md (48h ack, 7d fix for critical)

## [1.2.0] - 2026-04-08

### Added
- Auto-detect Claude Code credentials (`~/.claude/.credentials.json`) — no separate OAuth needed
- Automatic OAuth flow with local callback server (same as Claude Code)
- Login auto-starts proxy when credentials are found
- Session presence heartbeat for improved routing
- `anthropic-client-platform` and `context-management` beta headers
- Forward all upstream rate limit headers to clients
- Query parameter handling for `/health` and `/status` endpoints

### Changed
- `dario login` now detects Claude Code credentials first, falls back to auto OAuth
- Updated all documentation for accuracy against actual code behavior
- SSRF docs clarified: hardcoded allowlist approach, not IP-range blocking

### Removed
- Manual URL-paste OAuth flow (replaced by automatic local callback server)
- Unused `ask()` function and `readline` import

## [1.1.3] - 2026-04-08

### Changed
- Updated README with accurate rate limit documentation references
- Corrected claims about rate limit visibility (Claude Code has `/usage` and statusline)

## [1.1.0] - 2026-04-08

### Added
- `--cli` backend mode: route through Claude Code binary to bypass rate limits
- `--model` flag with shortcuts (`opus`, `sonnet`, `haiku`)
- Server error handler for EADDRINUSE
- Rate limit header forwarding from upstream

### Changed
- Default model is passthrough (client decides)
- Updated all examples to use `claude-opus-4-6`

## [1.0.5] - 2026-04-07

### Fixed
- SSRF: replaced URL prefix check with hardcoded path allowlist
- CodeQL alerts: stack trace exposure, SSRF flow

### Added
- npm provenance via GitHub Actions (SLSA attestation)
- CodeQL weekly security scanning
- SECURITY.md with full vulnerability disclosure policy
- CI matrix testing on Node 18, 20, 22

## [1.0.0] - 2026-04-07

### Added
- Initial release
- PKCE OAuth flow for Claude subscriptions
- Local HTTP proxy implementing Anthropic Messages API
- Streaming and non-streaming support
- Token auto-refresh every 15 minutes
- Credential caching with 10s TTL
- Atomic file writes for credential storage
- 127.0.0.1 binding (localhost only)
- CORS support for browser apps
- 10MB body size limit
- Token pattern redaction in all error messages
