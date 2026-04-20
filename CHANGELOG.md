# Changelog

All notable changes to this project will be documented in this file.

## [3.30.2] - 2026-04-19

### Added — Claude Agent SDK positioning + metadata-only drift watcher

- **README: Claude Agent SDK audience.** Adds Agent SDK users to the "Who this is for" list and to the Agent compatibility table. One-line config (`baseURL: 'http://localhost:3456'`) turns dario into an OAuth-subscription backend for any `@anthropic-ai/claude-agent-sdk` app — the SDK and CC share the same tool schema as of CC v2.1.114 / Agent SDK 0.2.x, so no translation work is needed on the agent's side.
- **`scripts/check-sdk-drift.mjs` (wired as `npm run drift:sdk`).** Metadata-only drift watcher that compares `@anthropic-ai/claude-code`, `@anthropic-ai/claude-agent-sdk`, and `@anthropic-ai/sdk` (Stainless transport) versions against dario's bundled template. Complements the heavy `check-cc-drift.mjs` (which downloads the 235MB native CC binary and scans it) — this one runs in seconds via `npm view` only, and flags `cc_version` or `x-stainless-package-version` drift as a fast pre-check suitable for high-frequency gating.

## [3.30.1] - 2026-04-19

### Changed — Drift patches for CC v2.1.114 wire shape

MITM capture of an active CC v2.1.114 client showed four fingerprint drift points in the body dario builds for Claude-subscription requests. All four are now aligned with what real CC emits.

- **`cache_control` drops `ttl: '1h'`.** CC v2.1.114 now sends `{"type":"ephemeral"}` bare on `system[1]` and `system[2]` cache markers. Dario's `buildCCRequest` and `src/shim/runtime.cjs` `rewriteBody` updated to match. The `CACHE_1H` local in `proxy.ts` is renamed to `CACHE_EPHEMERAL` and the `buildCCRequest` parameter `cache1h` is renamed to `cacheControl` — both the naming and the type (`{type: 'ephemeral'}`) now reflect that these are no longer 1h-scoped.
- **`max_tokens` lowered from 64000 to 32000.** Matches the value CC v2.1.114 sends for sonnet requests.
- **`output_config.effort` raised from `'medium'` to `'high'`.** Matches CC v2.1.114's non-haiku default.
- **`cc_entrypoint` changed from `cli` to `sdk-cli`.** CC has migrated to the Claude Agent SDK (also visible in the `x-stainless-package-version: 0.81.0` header); the billing tag now reflects that entrypoint.

Test fixtures and a few fixture-adjacent assertions in `test/hybrid-tools.mjs`, `test/client-detection.mjs`, `test/issue-29-tool-translation.mjs`, `test/live-fingerprint.mjs`, `test/proxy-body-order.mjs`, `test/shim-runtime.mjs`, and `test/tool-schema-contract.mjs` updated to the new wire shape. Full `npm test` green.

## [3.30.0] - 2026-04-19

### Removed — Sealed-sender overflow protocol and mux coordination surface

The sealed-sender RSA blind-signature primitive and the mux gateway auth lane are removed from dario. Both were landed to support [mux](https://github.com/askalf/mux) as a peer-to-peer capacity-sharing product; mux is on hold, so the code moves out of dario. Dario returns to its original scope — a focused universal LLM router — with ~1000 lines of crypto + coordination code shed from the audit surface.

- **`src/sealed-pool.ts` deleted** (~553 lines). `GroupAdmin` / `GroupMember` / `GroupLender` classes, RSA-FDH primitives, blind-signature flow, and borrow-envelope codec are gone. The code is preserved in the mux repo where a future mux revival can consume it directly.
- **`POST /v1/pool/borrow` endpoint removed from `src/proxy.ts`.** The endpoint was gated on `~/.dario/group.json` and returned 503 for users without that file, so removal is a breaking change only for runners of a mux lender daemon — a set which is currently empty given mux is on hold.
- **`MUX_COORD_SECRET` / `X-Mux-Coord-Secret` auth lane removed.** `authenticateRequest` signature simplifies to `(headers, apiKeyBuf)`. The CORS `Access-Control-Allow-Headers` list drops `x-mux-coord-secret`. Startup banner no longer mentions mux lender mode. Users who only set `DARIO_API_KEY` see no behavioural change.
- **Tests removed.** `test/sealed-pool.mjs` (375 lines, 85 assertions) and `test/mux-coord-secret.mjs` (109 lines, 16 assertions) deleted and dropped from the `npm test` script. Total test footprint: ~1,185 assertions across 32 files (was ~1,286 across 34).
- **README cleaned.** "Sealed-sender overflow protocol" section, the "share capacity with a trusted group" value paragraph, the `/v1/pool/borrow` endpoint row, and the `src/sealed-pool.ts` file-purpose row all removed. The "v4 is not a version bump" teaser banner is stripped — it pointed at roadmap work that is now on hold. Line/assertion counts updated throughout.

### Why this release

Mux (the peer-to-peer capacity-sharing product that consumed dario's sealed-sender primitive) is paused. With no active consumer of `/v1/pool/borrow`, `MUX_COORD_SECRET`, or the 550-line `sealed-pool.ts` module, the code is dead weight in dario — extra audit surface for users who will never call it, one more thing to maintain during template-drift updates, and a conceptual expansion that muddies dario's single-sentence pitch. Removing it returns dario to what the README opening says it is: a universal LLM router. If mux resumes later, the primitive can come back; for now, the mux repo carries the implementation independently and dario doesn't pay for code that has no consumer.

## [3.28.0] - 2026-04-17

### Added — Tunable session-ID lifecycle (direction #1)

Every outbound request to Anthropic carries a session identifier in the CC body's `metadata.session_id` and the `x-claude-code-session-id` header. Real Claude Code holds that id stable through a conversation and rotates when the user returns after an idle gap — roughly "one id per conversation", not per HTTP call. v3.18 rotated per request (itself a fingerprint); v3.19 hardcoded a single 15-minute idle window; v3.28 generalises that into a tunable registry so operators can shape rotation cadence, multi-client proxies stop collapsing onto one id, and always-on pipelines don't keep a single id alive indefinitely. Default behaviour (no flags, no env vars) is bit-identical to v3.27 — the old 15-minute idle window, one session across all callers, no max-age. Pool mode is unaffected: each pooled account keeps its stable `identity.sessionId` for its lifetime as before.

A subtle v3.27 inconsistency is also fixed along the way. v3.27 read the module-level `SESSION_ID` twice per request — once when building the CC body's `metadata.session_id`, once when emitting the `x-claude-code-session-id` header — with the rotation decision between those two reads. On rotation events, body and header disagreed. v3.28 resolves the outbound id once before the body build so the two always match.

- **`src/session-rotation.ts` — new pure module.** `SessionRotationConfig { idleRotateMs, jitterMs, maxAgeMs?, perClient }`, `decideSessionRotation(entry, now, cfg)` returning `keep` | `rotate-new` | `rotate-idle` | `rotate-age`, `SessionRegistry` class with LRU eviction at 1024 entries, and `resolveSessionRotationConfig(explicit, env)` with explicit > env > defaults precedence. Id generation and RNG are injected through the constructor so tests are deterministic without mocking the UUID module. Jitter is sampled once per session at creation (not per decision) so a given session has a fixed effective threshold for its lifetime — matches what a human-paced conversation looks like over many turns.
- **`src/proxy.ts` — registry replaces the hardcoded rotation block.** `SESSION_ID` / `SESSION_LAST_USED` / `SESSION_IDLE_ROTATE_MS` removed; the constructor wires `SessionRegistry` once per proxy start and uses it on every non-pool dispatch. `SESSION_ID` is retained purely as a mirror of the last-assigned single-account id so out-of-band consumers (the presence heartbeat pinging `/v1/code/sessions/$ID/client/presence`) can read the currently-active id without going through the registry. Body/header parity is enforced by resolving the id once (`preBodySessionId`) and threading it to both sides.
- **`src/cli.ts` — four new flags.** `--session-idle-rotate=MS` (default 900000), `--session-rotate-jitter=MS` (default 0), `--session-max-age=MS` (default off), `--session-per-client` (default off). All four are additive and independent; any combination is legal. Mirrored by env vars `DARIO_SESSION_IDLE_ROTATE_MS`, `DARIO_SESSION_JITTER_MS`, `DARIO_SESSION_MAX_AGE_MS`, `DARIO_SESSION_PER_CLIENT` for non-interactive deployments. Boolean env accepts `1` / `true` / `yes` / `on` (case-insensitive).

### Added — Test coverage

- **`test/session-rotation.mjs`** — new test file across 20+ sections covering: the pure `decideSessionRotation` branches (missing entry → `rotate-new`, fresh within window → `keep`, exactly at threshold → `keep` with strict `>`, past threshold → `rotate-idle`, jitter extends effective threshold, max-age triggers `rotate-age` under constant activity, idle wins over age when both trip, `maxAgeMs=0`/`undefined` both disable, negative `idleRotateMs` clamps to 0); `SessionRegistry` state transitions (first call mints + reports `rotate-new`, second call keeps, idle rotation replaces in place without growing the map, `lastUsedAt` refreshed on keep so the window slides, jitter offset is sticky for a session's lifetime, max-age rotates under constant activity, `perClient=false` collapses all `clientKey`s onto a single bucket, `perClient=true` separates by header, empty/undefined keys both fall back to `'default'`, LRU eviction honours the `maxEntries` cap, accessing a session refreshes its LRU position, `peek()` does not bump `lastUsedAt`, `clear()` empties); `resolveSessionRotationConfig` precedence (defaults match v3.27, env vars override, explicit wins over env, invalid numeric env falls through, all truthy/falsy boolean strings parsed, floats truncated via `Math.floor`).

Total test footprint grows to **32 files** with the v3.28 suite green alongside v3.27's MCP coverage.

### Why this release

Direction #1 from the "get ahead of Anthropic" roadmap — the sixth and last of the fingerprint-tightening directions. The previous five (TLS in v3.23, pacing in v3.24, stream-drain in v3.25, sub-agent in v3.26, MCP server in v3.27) each closed one axis of observable divergence from real Claude Code. Session-id lifecycle is the remaining behavioural axis visible in request metadata. The three new knobs (jitter, max-age, per-client) each correspond to a scenario where v3.27's single hardcoded 15-minute window falls short: long-running proxies holding one id across days (max-age), multi-UI fan-out collapsing distinct conversations onto a single id (per-client), and observers who can infer the exact 15-minute floor from long-run rotation cadence (jitter). Operators who are happy with v3.27's single-account behaviour don't have to touch anything — defaults are bit-identical. The v3.27 body/header rotation race is fixed as a side effect of consolidating the read: both now draw from the same `preBodySessionId` resolved once per request. The roadmap directions are complete; from here releases return to responding to issues and to upstream template drift.

## [3.27.0] - 2026-04-17

### Added — dario as MCP server (direction #4)

Claude Code, Claude Desktop, and the growing ecosystem of IDE plugins speak MCP (Model Context Protocol) — stdio-based JSON-RPC 2.0 with a small method set for exposing tools and resources to an LLM-driven session. v3.27 turns dario itself into an MCP server so any MCP client can introspect dario's state (auth, pool, backends, template / fingerprint, sub-agent install) the same way it would call any other tool. No more switching out of an MCP-aware editor to run `dario doctor` in a separate terminal — the LLM can query dario directly, in-context.

The server is strictly read-only: mutations (`dario login`, `accounts add`, `backend add`, `subagent install`, `proxy` start/stop) are not exposed. Same boundary as the CC sub-agent from v3.26 — an MCP client shouldn't be able to alter dario's persisted state just by being connected. All exposed tools take zero arguments (`inputSchema.required = []`) and return a single text block so the LLM consumer has a predictable shape to reason about.

- **`src/mcp/protocol.ts` — pure JSON-RPC 2.0 + MCP method dispatcher.** Zero-runtime-deps policy rules out `@modelcontextprotocol/sdk`; the protocol surface we need (`initialize`, `tools/list`, `tools/call`, plus notifications and the five canonical JSON-RPC error codes) is small enough to hand-roll and lock down with tests. `parseLine` / `encodeMessage` handle newline-delimited JSON framing; `handleMessage(msg, tools, serverInfo)` is pure over its inputs so the unit tests can exercise every branch without streams. Notifications (no-`id` messages) return `null` instead of a response frame per JSON-RPC spec. Handler errors are wrapped into `-32603 internal_error` responses — a buggy tool never propagates an unhandled rejection into the stdio loop.
- **`src/mcp/tools.ts` — six read-only tools wrapping existing dario subsystems.** `buildToolRegistry(data: ToolDataSources)` is a factory taking an injectable data-source bundle (fake in tests, real dynamic imports in `buildDefaultToolRegistry`) so the registry stays pure over its inputs. Tools: `doctor` (full health report — reuses `runChecks` + formats with aligned `[ OK ]` / `[WARN]` / `[FAIL]` / `[INFO]` prefixes + summary), `status` (OAuth auth state), `accounts_list` (pool accounts + expiry — never touches API keys), `backends_list` (configured OpenAI-compat backends — redacts keys completely, not even a `sk-…` prefix), `subagent_status` (sub-agent install + version-match state), `fingerprint_info` (runtime / TLS / template-source / schema version). No destructive tool names are reachable — the test suite asserts the forbidden set (`login`, `logout`, `accounts_add`, `accounts_remove`, `backend_add`, `backend_remove`, `proxy_start`, `subagent_install`, `subagent_remove`) is not exposed so a future drift accidentally shipping a mutation tool gets caught.
- **`src/mcp/server.ts` — stdio event loop.** `runMcpServer({ tools, server, stdin, stdout, stderr })` reads newline-delimited JSON from stdin with `readline` (`crlfDelay: Infinity` for Windows MCP clients), parses each line, dispatches through `handleMessage`, and writes back with a promise-wrapped back-pressure-aware `stream.write` so a slow consumer can't make us buffer unboundedly. Ordered serial processing — one message in flight at a time — keeps stdio frames deterministic and matches what tests assert on. Streams are injectable so end-to-end tests run against a `PassThrough` pair without spawning a subprocess.
- **`src/cli.ts` — `dario mcp` command.** Added to the command dispatcher alongside `subagent` and `doctor`. Redirects `console.log` / `console.info` to stderr for the lifetime of the server — MCP stdio requires that *only* protocol frames go to stdout, so any stray log from a downstream module (doctor checks, oauth probes) would corrupt the frame stream. Help text describes the six exposed tools and the read-only boundary.

### Added — Test coverage

- **`test/mcp-protocol.mjs`** — 62 new assertions across 16 sections: `parseLine` happy path (request, notification), blank-line tolerance (empty / whitespace-only return `ok=false, error=null`), parse errors (garbage, non-object top-level, `null`, wrong `jsonrpc` version, missing or non-string `method`), `successResponse` / `errorResponse` shape (id echoed, `data` passed through only when provided, `id: null` allowed for unparseable origin), `encodeMessage` newline framing + JSON round-trip, `handleMessage` for `initialize` (pinned `protocolVersion`, `capabilities.tools`, serverInfo), `tools/list` (order preserved, handler stripped from the exposed tool record), `tools/call` (happy path, missing arguments defaulted to `{}`, non-object arguments coerced to `{}`), error branches (`-32601` unknown method, `-32602` missing name, `-32601` unknown tool, `-32603` handler throw wrapped instead of propagating), and notifications (`null` return, including unknown notification method names).
- **`test/mcp-tools.mjs`** — 81 new assertions across 18 sections: registry shape (exactly six tools, forbidden mutation names absent, every tool has a description + object-typed schema with zero required args), `doctor` formatter (all four status prefixes render, label padding holds, summary reports counts, empty list handled gracefully), `status` for all three auth states (authenticated, no-credentials with login hint, expired-but-refreshable), `accounts_list` for empty pool / single-account / 2+-account (singular vs plural, expired marker, pool-mode hint only when actually in single-account mode), `backends_list` with key-redaction assertions (`sk-` prefix absent, `apiKey` label absent — defense-in-depth against a future data-source accidentally leaking the secret), `subagent_status` for all four computed states (not-installed + CC-missing, installed + current, installed + stale with re-install hint, not-installed + CC-present with install hint), `fingerprint_info` for Bun-match / Node-diverged / null-schema rendering.
- **`test/mcp-e2e.mjs`** — 25 new assertions across 6 sections exercising the stdio event loop against a `PassThrough` pair: full handshake flow (`initialize` → `notifications/initialized` [no response] → `tools/list` → `tools/call` → EOF — exactly 3 frames emitted, correct ids, correct order), parse-error recovery (malformed line emits `-32700` with `id: null`, next valid request still served), framing noise tolerance (blank lines + CRLF silent, producing zero extra frames), handler-throw recovery (`-32603` emitted, subsequent request still served — server doesn't die on a bad tool), unknown-method handling (`-32601` then continue), clean shutdown (EOF on stdin resolves `runMcpServer` within 1s).

Total test footprint: **1151 assertions across 31 files** (was 983). Full `npm test` green.

### Why this release

Direction #4 from the "get ahead of Anthropic" roadmap. The v3.26 sub-agent put dario at CC's fingertips inside a single CC session; v3.27 broadens that reach to every MCP client — Claude Desktop, Cursor, Zed, any future MCP-aware editor — without dario needing to know about any of them specifically. The design decisions that fell out of the zero-runtime-deps constraint ended up being wins on their own: hand-rolling the JSON-RPC dispatcher kept the surface small (three methods, five error codes), the pure `handleMessage` split made every branch testable without streams, and the injectable `PassThrough` streams let the e2e test stay in-process. Read-only scope is the other deliberate choice: exposing mutations to any connected MCP client would mean every tool the user connects could, say, add a backend without the user noticing. Read-only tools are strictly additive — an MCP client can *observe* dario, but changing dario's state stays a CLI action the user types with intent. Future directions from the roadmap — #1 (session-ID rotation on the interactive side) and the remaining fingerprint axes — can land on top without re-opening this scope.

## [3.26.0] - 2026-04-17

### Added — Claude Code sub-agent hook (direction #2)

Claude Code reads sub-agent definitions from `~/.claude/agents/*.md` — each one is a tool-scoped prompt context that CC can delegate work into via the Task tool (or that the user can invoke directly with "use the X sub-agent to…"). v3.26 registers a first-party `dario` sub-agent so CC has a named handle for running dario diagnostics and template-refresh operations inside an ongoing CC session — no more context-switching out to a terminal when you hit a `[WARN]` row or suspect template drift.

The sub-agent is tool-scoped to `Bash, Read` and its prompt forbids destructive operations (credential mutation, account pool changes, backend config changes) without explicit user confirmation. `dario proxy` is also explicitly off-limits from inside the sub-agent (it would block the parent CC session). The boundary is intentional: CC can ask dario to *report*, not to *change state*.

- **`src/subagent.ts` — install/remove/status lifecycle.** `buildSubagentFile(version)` returns the full markdown body (pure, pinned by tests — changing the content is a visible diff). `computeSubagentStatus` is pure over `(fileExists, fileBody, currentVersion)` and distinguishes four states: not-installed-and-CC-missing (`agentsDirExists: false`), not-installed-but-CC-present, installed-and-current, installed-but-stale (the on-disk `<!-- dario-sub-agent-version: X -->` marker doesn't match the running dario). `installSubagent` auto-creates `~/.claude/agents/` when absent, returns `created` / `updated` / `unchanged` so the CLI can log accurately, and never overwrites unrelated sub-agent files in the same directory. `removeSubagent` is idempotent and deliberately does not remove the parent `agents/` directory (other sub-agents may coexist).
- **`src/cli.ts` — `dario subagent install | remove | status`.** Three subcommands matching the `dario accounts` / `dario backend` pattern. `status` is the default when the verb is omitted. Unknown verbs print a short usage block and exit 1.
- **`src/doctor.ts` — new "Sub-agent" check.** Between the Backends and Home rows. Reports `info` when CC isn't installed (no `~/.claude/agents/` to write into), `info` when installed-but-sub-agent-missing (with the install command inline), `warn` when installed-but-stale (with the refresh command inline), and `ok` when installed and current.
- **`src/cli.ts` — help text.** Three new lines under the command list pointing at `install` / `remove` / `status`.

### Added — Test coverage

- **`test/subagent.mjs`** — 48 new assertions across 7 sections. Pure-helper coverage: `buildSubagentFile` pinned structure (frontmatter delimiter, name field, description field, tool restriction line, version marker embedding, safe-op mentions, destructive-op warnings), determinism (same version → byte-identical; differing version → only the marker changes). `computeSubagentStatus` branches: file absent (with CC dir present and absent), file present with matching marker, file present with mismatched marker (installed-but-stale), file present without any marker (user-hand-edited). Filesystem round-trip against an isolated temp HOME: pre-install status, install creates the directory + file, on-disk content matches `buildSubagentFile(r.version)`, post-install status reports installed+current, re-install with no change reports `unchanged`, stale-file install reports `updated`, remove reports `removed=true` then `removed=false` (idempotent), agents dir persists after remove (other sub-agents untouched). Dedicated "populated agents dir" section verifies `install` doesn't clobber an unrelated sub-agent and `remove` only unlinks `dario.md`.

Total test footprint: **983 assertions across 28 files** (was 935). Full `npm test` green.

### Why this release

Direction #2 from the "get ahead of Anthropic" roadmap. The original framing was "funnel consumer traffic through CC session" — a maximal-fidelity vision where third-party consumers would route through a running CC's own session, inheriting its TLS stack, headers, and billing classification. That shape needs infrastructure that doesn't fit a single release (CC-as-a-subprocess, request multiplexing, billing attribution). v3.26 ships the tighter, more-immediately-useful slice: a CC-side handle that makes dario's existing diagnostics and refresh commands first-class CC operations. The maximal vision is not ruled out — `src/subagent.ts`'s `buildSubagentFile` is the extension point, and the prompt can grow richer (e.g., add a "refresh-template" action that runs the capture pipeline directly) without changing the install/remove/status mechanics. For now, the value proposition is pragmatic: `/use dario` inside CC beats `Ctrl+Z → dario doctor → fg` every time.

## [3.25.0] - 2026-04-17

### Added — Stream-consumption replay (direction #5)

Native Claude Code, when it streams a response from `/v1/messages`, reads the SSE to its final event before closing the socket — even when the consumer logically already has enough (e.g., it saw the tool-use block it was waiting for). Third-party consumers routed through dario's proxy often abort mid-stream. Through v3.24, dario forwarded that abort upstream by triggering `upstreamAbort.abort()` from `req.on('close')`. Clean for billing, but "connection closed mid-stream" vs CC's "connection read to EOF" is visible on Anthropic's side. v3.25 adds an opt-in knob to replay CC's consumption pattern regardless of the real consumer's shape.

- **`src/stream-drain.ts` — `decideOnClientClose` + `resolveDrainOnClose`.** Pure decision function: `(writableEnded, upstreamAborted, drainOnClose) → 'abort' | 'drain' | 'noop'`. Three branches captured explicitly so the truth table is enumerable and testable. `'noop'` covers the normal-teardown and already-aborted cases (no double-abort, no draining a finished response); `'abort'` is the pre-v3.25 default; `'drain'` is the new mode. `resolveDrainOnClose` accepts an explicit boolean override and falls through to `DARIO_DRAIN_ON_CLOSE` env (truthy set: `'1' | 'true' | 'yes'`, case-insensitive — not JS-truthy, because `'0'` shouldn't enable).
- **`src/proxy.ts` — `onClientClose` delegates to the decision function.** The existing inline `if (!res.writableEnded && !upstreamAbort.signal.aborted) { abort }` is replaced with `decideOnClientClose(...)`. When the result is `'drain'`, the handler sets a per-request `clientDisconnected` flag instead of aborting. The 5-minute `UPSTREAM_TIMEOUT_MS` abort still fires as a hard ceiling — drain mode doesn't let a hung upstream linger forever.
- **`src/proxy.ts` — gated writes in the streaming path.** A single `writeToClient(chunk)` helper inside the `if (isStream && upstream.body)` block short-circuits `res.write(...)` once `clientDisconnected` is true. The read loop keeps consuming the upstream SSE; the stateful transformers (analytics accumulator, `createStreamingReverseMapper` tool-use buffering, OpenAI stream translator) keep running so usage numbers are complete rather than truncated on disconnect. Every `res.write(...)` call in the streaming branch (SSE-overflow error payload, `[DONE]` sentinel, OpenAI-translated lines, streamMapper output, passthrough, buffer-flush, streamMapper tail) funnels through `writeToClient` — no exceptions.
- **`src/cli.ts` — `--drain-on-close` flag + `DARIO_DRAIN_ON_CLOSE=1` env.** Opt-in. Default is off: keep the v3.24 behavior (mid-stream client disconnect aborts upstream) so existing users don't silently start paying for generation their consumers aren't reading. Help text includes a note that the flag trades tokens (response is fully generated even if nobody reads it) for fingerprint fidelity, bounded by the 5-minute upstream timeout.

### Added — Test coverage

- **`test/stream-drain.mjs`** — 30 new assertions across 7 sections: `decideOnClientClose` already-ended paths (noop regardless of drain), already-aborted paths (noop regardless of drain), drain=false default-abort branch, drain=true → drain branch, and a full 2×2×2 truth-table sweep of the 8 input combinations so any future refactor that flips a branch gets caught. `resolveDrainOnClose` coverage: explicit boolean wins over env, truthy env values (`'1' | 'true' | 'yes'`, case-insensitive), falsy-by-default behavior (including `'banana'`, `'2'`, empty string, unset — only the allowlisted truthy strings enable drain).

Total test footprint: **935 assertions across 27 files** (was 905). Full `npm test` green.

### Why this release

Direction #5 from the "get ahead of Anthropic" roadmap. The v3.22 body-order replay and v3.23 TLS-fingerprint surfacing both closed wire-level axes; v3.24 attacked the inter-request rhythm. Stream-consumption shape is the next axis — a statistical property of how the proxy interacts with SSE that's independent of the bytes it sends. Making it default-on would silently cost users tokens; making it opt-in and documented respects users on metered accounts while giving subscription-only users a tighter fingerprint without a code change. The separation between "abort" and "drain" as named actions (vs a boolean) makes the intent explicit in the proxy code and lets future modes (e.g., "partial drain up to next `message_stop`" for finer-grained trade-offs) slot in without rewriting the call sites.

## [3.24.0] - 2026-04-17

### Added — Behavioral smoothing (direction #6)

Real Claude Code traffic has a human-shaped rhythm between requests: sub-second during a tool-loop burst, multi-second while the user is typing, occasionally idle for minutes. A proxy that fires back-to-back at a perfect 500ms floor stands out against that rhythm over a statistically meaningful sample — the floor itself becomes visible in the long-run minimum of inter-arrival times. v3.24 replaces the hardcoded-500ms rate governor with a configurable floor plus optional uniform jitter, and lifts the config out of an env-only knob into first-class CLI flags.

- **`src/pacing.ts` — `computePacingDelay` + `resolvePacingConfig`.** Pure delay calculator: given `(now, lastRequestTime, {minGapMs, jitterMs})`, returns how many ms to sleep before the next upstream fetch. Effective gap per request is `minGap + U(0, jitter)` where the RNG is injectable so tests are deterministic. The first request in a session (`lastRequestTime === 0`) is never paced — the purpose is smoothing the *gap between* requests, not delaying the first connect. Negative config values are clamped to 0 (lenient — a typoed env var shouldn't fail-loud). `resolvePacingConfig` applies precedence `explicit arg > DARIO_PACE_*_MS > legacy DARIO_MIN_INTERVAL_MS > defaults` so no existing setup regresses and invalid env strings fall through to the next source.
- **`src/proxy.ts` — rate governor switched to the pure calc.** The inline `if (elapsed < 500) setTimeout(remainder)` block that lived at the top of the dispatch loop now delegates to `computePacingDelay`. Defaults (minGap=500, jitter=0) are identical to v3.23 behavior on the wire — opting in to jitter is the whole new surface. `-v` logs the resolved pacing config at startup so operators can confirm what's active.
- **`src/cli.ts` — `--pace-min=MS` and `--pace-jitter=MS` flags.** Parsed into non-negative integers with a shared `parsePositiveIntFlag` helper that fails-loud on invalid values (typos on the CLI should fail, unlike typos in env — CLI is a direct user action). Wired through `ProxyOptions.pacingMinMs` / `pacingJitterMs` the same way `--strict-tls` was wired in v3.23. Help text adds both entries below `--strict-tls`.

Session-ID rotation is unchanged from v3.19 (15-minute idle threshold, per-conversation in pool mode). The existing heuristic already tracks CC's observed behavior closely; revisiting it in the same release would have muddied the blast radius.

### Added — Test coverage

- **`test/pacing.mjs`** — 32 new assertions across 12 sections: `computePacingDelay` correctness (first-request passthrough, elapsed-exceeds-gap, insufficient-elapsed, deterministic-jitter with injectable RNG, jitter=0 short-circuits the RNG call on the hot path, negative config clamped, default RNG produces an in-range result); `resolvePacingConfig` precedence (defaults, explicit > env > legacy env > defaults, legacy `DARIO_MIN_INTERVAL_MS` still honored, new `DARIO_PACE_MIN_MS` wins over legacy, invalid/empty strings fall through, explicit 0 is valid — distinct from "unset" — and number-typed CLI args pass through alongside string-typed env args).

Total test footprint: **905 assertions across 26 files** (was 873). Full `npm test` green.

### Why this release

Direction #6 from the "get ahead of Anthropic" roadmap. The 500ms floor that has lived in the proxy since the first public release did one job well (flood prevention) but carried the accidental second property of being a fingerprint axis: over thousands of requests, the minimum inter-arrival time trends to exactly 500ms. Any heuristic looking at the distribution shape — not just the mean — sees that clean boundary. Jitter breaks the boundary; raising `--pace-min` above the default lets operators choose a rhythm closer to their actual session pattern. This is deliberately not a distribution replay (human inter-arrival is log-normal, not uniform-on-an-interval) — that's a possible future tighten, but uniform jitter is dramatically better than no jitter and ships cleanly without statistical assumptions. The scope is kept tight so #5 (stream-consumption replay) and #2 (sub-agent hook) can land as separate, independently reviewable releases.

## [3.23.0] - 2026-04-17

### Added — Runtime / TLS-fingerprint axis visibility (direction #3)

Proxy mode terminates TLS to `api.anthropic.com` from dario's own process, which means the ClientHello Anthropic sees is whichever runtime dario is on. Claude Code is a Bun-compiled binary, so its ClientHello is Bun's BoringSSL shape (distinct JA3/JA4 hash). Dario already auto-relaunches under Bun when Bun is on `PATH` — but when Bun isn't installed, that relaunch is a silent no-op and proxy mode quietly emits Node's OpenSSL ClientHello with no indication to the operator. v3.23 closes that blind spot: the runtime mismatch is now a first-class check with an opt-in hard guardrail.

- **`src/runtime-fingerprint.ts` — `classifyRuntimeFingerprint` + `detectRuntimeFingerprint`.** Pure classifier over three inputs (`runningUnderBun`, `availableBunVersion`, `env`) so tests can exercise every combination without touching the real environment. Distinguishes three states: `bun-match` (ok — TLS matches CC), `bun-bypassed` (Node, Bun on PATH, auto-relaunch didn't fire — usually because `DARIO_NO_BUN` is set or the auto-relaunch was suppressed), and `node-only` (Node, Bun not installed — the silent mismatch case). Each state carries a human-readable `detail` + an actionable `hint`. `probeBunVersion` wraps `execFileSync('bun', ['--version'])` with a 3s timeout and output sanity checks so an unrelated `bun` binary can't poison detection.
- **`src/doctor.ts` — new "Runtime / TLS" check.** Reports the classification between the Platform and CC-binary rows. `ok` on bun-match, `warn` otherwise with the hint inlined. Users running `dario doctor` now see the TLS axis the same way they see OAuth, pool, template drift, etc.
- **`src/proxy.ts` — startup banner.** When `startProxy` boots under anything other than bun-match, the classification prints to stderr alongside the existing template / drift / compat warnings. Silence for known-fine environments with `DARIO_QUIET_TLS=1`.
- **`src/proxy.ts` — `--strict-tls` flag.** Opt-in hard guardrail: refuses to start proxy mode when the classification isn't `bun-match`. For operators who want certainty that the JA3 their proxy presents to Anthropic matches Claude Code's. Omit the flag to keep the existing permissive behavior (warn-and-continue).

### Added — Test coverage

- **`test/runtime-fingerprint.mjs`** — 31 new assertions across 7 sections: bun-match with a version, bun-match without a version (runtime identification matters, not the version string), node-with-Bun → bun-bypassed (bypass reason defaults to `unknown`), `DARIO_NO_BUN` set → bypass reason = `DARIO_NO_BUN` + hint targets the env var, node-without-Bun → node-only (hint targets the Bun install URL and shim as the alternative, detail mentions JA3 divergence), env-not-mutated invariant (classifier is pure over its input), `DARIO_NO_BUN` set but Bun not installed still classifies as node-only (the env var is not a bypass when there's nothing to bypass).

Total test footprint: **873 assertions across 25 files** (was 842). Full `npm test` green.

### Why this release

Direction #3 from the "get ahead of Anthropic" roadmap. Shim mode runs inside CC's own process, so its TLS stack is CC's by construction — no gap. Proxy mode is the divergent case, and the divergence was invisible to operators prior to v3.23. Making it visible doesn't *close* the gap (that needs a lower-level ClientHello rewrite, held back by the zero-runtime-deps policy), but it turns the silent axis into one operators can see and decide to act on. `--strict-tls` gives users who care an all-or-nothing knob; the default permissive behavior keeps backward compatibility. Directions #6 (behavioral smoothing) and #5 (streaming-consumption telemetry) follow in subsequent releases.

## [3.22.0] - 2026-04-17

### Added — Request body field order replay (fingerprint-tightening)

Every top-level key in the outbound `/v1/messages` body is a potential fingerprint: JSON is semantically unordered as a type but the wire serialization IS ordered, and two bodies with the same fields in different order produce different bytes. Up through v3.21 dario tried to match CC's order by hand — `buildCCRequest` in `src/cc-template.ts` built the object literal with `model, messages, system, tools, metadata, max_tokens, thinking, context_management, output_config, stream` and a comment saying "matches CC v2.1.104 exactly." That comment is the problem: every time CC reshuffles the order or adds a field (like `output_config` did silently), dario's hardcoded order lags until someone notices and ships a point release. v3.22 replaces the hand-maintained order with one captured from the live binary.

- **`src/live-fingerprint.ts` — `body_field_order` field on `TemplateData` (schema v3).** The live-capture extractor now runs `Object.keys(captured.body)` on the parsed request body and stores the result. Because V8 preserves insertion order for string keys (ES2015+) and the capture reads from JSON that was already parsed in order, the resulting array is a faithful record of CC's wire order. `CURRENT_SCHEMA_VERSION` bumps from 2 → 3; pre-v3 caches (`~/.dario/cc-template.live.json`) are rejected at load time by the existing `_schemaVersion !== CURRENT_SCHEMA_VERSION` check and the next background refresh writes a fresh one — no migration, no quarantine (schema-mismatch is an expected version-transition state).
- **`src/cc-template.ts` — `orderBodyForOutbound(body, overrideOrder?)`.** Reorders a built body to match a captured order. Mirrors `orderHeadersForOutbound`'s contract with one intentional difference: keys are case-sensitive (JSON keys are case-sensitive, unlike HTTP headers), and the return is a plain `Record` instead of an array of pairs — `JSON.stringify` walks string keys in insertion order so the record form is sufficient to reach the wire ordered. Missing captured names are skipped (never emitted as `undefined`), duplicates are deduped (first wins), and caller-supplied extras are appended at the tail in insertion order so a future Anthropic-added field isn't silently dropped by a stale capture.
- **`src/cc-template.ts` — `buildCCRequest` applies the replay.** The hardcoded object-literal build is kept as a deterministic fallback; `orderBodyForOutbound(ccRequest)` runs just before the function returns, so when the template has `body_field_order` the outbound key sequence matches the captured order exactly. When `body_field_order` is undefined (pre-v3.22 bundle or live cache miss), the passthrough path returns the input reference-equal — no behavior change, no overhead.
- **Re-captured `src/cc-template-data.json` against CC v2.1.112.** The baked fallback now carries `body_field_order: ["model", "messages", "system", "tools", "metadata", "max_tokens", "thinking", "context_management", "output_config", "stream"]`, which happens to match the hardcoded build order (v2.1.112 hasn't reshuffled), so this release is a no-op on the wire for existing installs — the value is in the mechanism, not the data.

### Added — Test coverage

- **`test/proxy-body-order.mjs`** — 29 new assertions across 9 sections: empty-order reference-equal passthrough, captured-order preservation with `Object.keys` + `JSON.stringify` walk verification, case-sensitive matching (unlike headers — `Model` and `model` are distinct), extras-at-tail with insertion-order preservation, absent-captured-name skipping (never synthesized as `undefined`), duplicate-name dedup, empty-caller-record edge, falsy-value preservation (`0`, `false`, `''`, `null` must not be stripped by a naive truthiness check), and idempotence (`reorder(reorder(x))` is byte-identical to `reorder(x)`).
- **`test/live-fingerprint.mjs` §"Schema v3"** — 2 new assertions + 1 updated: `_schemaVersion === 3` (was `=== 2`), `body_field_order` is an array, `body_field_order` captures the top-level keys in the caller-supplied insertion order. The prior schema-v2 section heading retitled to schema-v3 inline.

Total test footprint: **842 assertions across 24 files** (was 811). Net +31: +29 from `test/proxy-body-order.mjs`, +2 from `test/live-fingerprint.mjs`. Full `npm test` green.

### Why this release

The deferred v3.13 roadmap item (comment at `src/live-fingerprint.ts:72-79`) called out request body field order as a known fingerprint axis that was still on "hope CC doesn't change it" footing. v3.22 closes that loop: the order is now a captured-and-replayed property rather than a hand-maintained constant, the drift watcher's existing `template.version` check catches order drift as a byproduct of the version bump, and future CC releases that add or reshuffle a top-level field (the most recent precedent: `output_config` added somewhere in the v2.1.10x series) get picked up by the next live refresh without a dario release. Part of the broader "get ahead of Anthropic" push that started with v3.19's `header_order` capture.

## [3.21.0] - 2026-04-17

### Added — Baked template scrubber + re-capture (dario#45)

The bundled `src/cc-template-data.json` is consumed by every brand-new dario install on its very first proxy request, before the background live capture has had a chance to refresh the cache. Whatever sits in that file reaches Anthropic on that first request — which matters because the prior bake carried capture-host paths (`masterm1nd`, `DOCK`, `C--Users-masterm1nd-DOCK-Desktop-recover-dario`) baked into its system prompt. Separate from the privacy issue, user-path contamination is fingerprint-unsafe: every fresh install's first-request fingerprint briefly contained that path, which is a weak-but-real signal the request didn't originate on the user's own machine.

- **`src/scrub-template.ts` — `scrubTemplate(data)`** — strips host-identifying data from a captured `TemplateData` before baking. Removes the top-level sections CC populates with per-session context (`# Environment`, `# auto memory`, `# claudeMd`, `# userEmail`, `# currentDate`, `# gitStatus`), replaces any residual user-dir paths with a `user` placeholder (`C:\Users\<name>\…`, `/Users/<name>/…`, `/home/<name>/…`, and CC's flattened `C--Users-<name>-<segments>` convention used under `~/.claude/projects`), and drops any tool whose name begins with `mcp__` (those are the capturing user's MCP server tools, not CC-canonical). Preserves every fingerprint-sensitive field verbatim: `header_order`, `header_values`, `anthropic_beta`, `tools[].name`, `tools[].input_schema` structure. Idempotent.
- **`scripts/capture-and-bake.mjs`** — one-shot maintainer script: capture the user's own `claude` binary against a loopback MITM (same pipeline as `refreshLiveFingerprintAsync`), apply `scrubTemplate`, verify `findUserPathHits` returns 0 on the serialized result, write to `src/cc-template-data.json`. Fails loud on timeout, capture null, or residual user paths.
- **Re-captured `src/cc-template-data.json` against CC v2.1.112.** Schema bumped from v1 → v2 so the baked fallback now ships `header_order` (23 entries), `header_values` (15 static keys), and `anthropic_beta` (7 flags) — previously only the live cache populated these. System prompt trimmed from 25,204 → 12,049 chars (host-context sections removed); tool list: 25 → 26 (`PushNotification` added upstream, 6 `mcp__*` stripped by scrub).
- **`scripts/check-cc-drift.mjs` — scrub verification.** Two new categories: `template.user_paths` (high) fires if the baked file contains any `findUserPathHits` match; `template.mcp_tools` (high) fires if any `mcp__*` tool name slipped through. The nightly drift watcher now guards against regression in both dimensions alongside the existing OAuth / compat-range / tool-removed checks.
- **`test/proxy-header-order.mjs`** — updated the "passthrough unchanged" assertion. Pre-v3.21, calling `orderHeadersForOutbound(headers, undefined)` fell back to the baked template's (undefined) `header_order` and returned the input record reference-equal; post-v3.21 the baked template ships `header_order`, so the hermetic form passes `[]` explicitly.

### Added — Test coverage

- **`test/scrub-template.mjs`** — 48 new assertions across 11 sections: Windows / macOS / Linux user-path replacement, CC flattened-path collapse, prose/non-match preservation, full section removal (`# auto memory`, `# Environment`, `# userEmail`, `# currentDate`), `mcp__*` filter with `tool_names` mirroring, tool-description + `input_schema` string scrubbing with structure preservation, fingerprint-sensitive field preservation (`_version`, `_captured`, `_schemaVersion`, `header_order`, `header_values`, `anthropic_beta`), input-not-mutated guard, `scrub(scrub(x)) === scrub(x)` idempotence, and `findUserPathHits` detector positives + placeholder-accepted negatives.

Total test footprint: **811 assertions across 23 files** (was 764). Net +47: +48 from `test/scrub-template.mjs`, −1 from `test/proxy-header-order.mjs` (the `undefined` reference-equal assertion retired — see above). Full `npm test` green.

### Why this release

v3.19.5 deferred this re-capture precisely because a naive bake would have perpetuated the pollution — the scrub pipeline is the prerequisite. With scrub in place, the bake is safe to run on any maintainer machine: the capture goes through the MITM path, the scrub strips the host context, the drift watcher verifies the result, and the nightly `cc-drift-watch` workflow will auto-close dario#44 on its next run now that `template.version` matches `ccVersion` again. Every new dario install's first request now sees a clean, canonical CC prompt instead of the prior maintainer's git log.

## [3.20.1] - 2026-04-17

### Added — `--no-auto-detect` opt-out for text-tool-client auto-preserve (dario#40)

v3.19.3 shipped auto-detection that flips dario into preserve-tools mode when the incoming system prompt looks like Cline / Kilo Code / Roo Code, because the alternative (CC tools in the outbound `tools` array + the client's XML protocol in the system prompt) makes the model emit `<function_calls><invoke>` that those clients can't parse. Auto-preserve fixes the edit-fail symptom but changes one field of the outbound fingerprint (the `tools` array), and @ringge raised a fair concern: operators using dario specifically for stealth/fingerprint reasons may prefer to *keep* the CC fingerprint intact and pick `--preserve-tools` per session when they need it, rather than having dario auto-flip based on a heuristic.

- **`src/cli.ts` — `--no-auto-detect`** (alias `--no-auto-preserve`). When set on `dario proxy`, the text-tool-client detector is short-circuited: `detectTextToolClient()` isn't called, `detectedClient` is always `undefined`, `effectivePreserveTools` is whatever the operator explicitly chose. Explicit `--preserve-tools` still wins (explicit operator choice outranks everything); `--hybrid-tools` is unaffected (already outranked the detector).
- **`src/cc-template.ts` — `buildCCRequest` opts extended with `noAutoDetect?: boolean`.** The detector call is gated on `!opts.noAutoDetect`. When the flag is set on a Cline/Kilo/Roo prompt, the outbound `tools` array becomes the CC canonical set (not the client's schema), which is what the operator asked for — the trade-off is that text-tool clients will see `<function_calls><invoke>` in the model output and their parsers will reject edits. Users opt into that trade-off consciously.
- **`src/proxy.ts` — `StartProxyOptions.noAutoDetect`** threaded from CLI → proxy → `buildCCRequest`.
- **Help text** — `--no-auto-detect` documented under Proxy options with the trade-off spelled out inline.

### Added — Test coverage

- **`test/client-detection.mjs` §9** — 6 new assertions: detector skipped when `noAutoDetect: true` fires on a Cline prompt, outbound tools land on CC canonical (tool name no longer `execute_command`), `noAutoDetect` + explicit `preserveTools` → preserved (explicit wins), `noAutoDetect` on a plain (undetected) client is a no-op regression guard.

Total test footprint: **764 assertions across 22 files** (was 758). Full `npm test` green.

### Why this release

dario#40's fingerprint concern deserves an explicit operator escape hatch, not just "pick `--hybrid-tools` instead" (hybrid has its own session-injection semantics you may not want). `--no-auto-detect` is the narrow, purpose-built flag: disable only the heuristic, keep every other v3.19.3 behavior. Default is unchanged — auto-detect still fires out of the box, because that's still the right default for users who haven't thought about fingerprint trade-offs.

## [3.20.0] - 2026-04-17

### Added — Manual / headless OAuth flow (`dario login --manual`, dario#43)

dario's OAuth flow binds a local HTTP callback on the dario host (`http://localhost:${port}/callback`) and redirects the browser back to it after consent. That works for desktop installs but breaks in two common setups: **containers** (dario in a container, browser on the host — redirect lands on the wrong host) and **headless / SSH** installs (dario on a remote box with no browser, user has a browser on their laptop). Surfaced by @adubkov in dario#28 (docker-compose with `--host=0.0.0.0 --port=30000`); previous workaround was running `dario login` on a desktop and rsync'ing `~/.dario/` onto the headless box.

- **`dario login --manual`** (alias `--headless`) — mirrors Claude Code's own `claude setup-token` flow. Sends `code=true` + `redirect_uri=https://platform.claude.com/oauth/code/callback` on the authorize URL, so Anthropic renders the authorization code on a copy-paste success page instead of redirecting. dario reads the pasted code from stdin, verifies state (when present; Anthropic's success page returns `code#state`), and exchanges it against the token endpoint with the same PKCE `code_verifier`. Browser and dario can run on different hosts, different networks, or across an SSH jump.
- **Heuristic hint before the auto flow.** When `--manual` isn't set but `detectHeadlessEnvironment()` fires — `SSH_CLIENT` / `SSH_TTY` / `SSH_CONNECTION` env vars, `/.dockerenv` present, or `/proc/1/cgroup` matches `docker|containerd|lxc|kubepods` — `dario login` prints a one-liner suggesting `--manual` before starting the auto flow. No auto-pivot: false positives are more annoying than false negatives; the user can always ignore the hint if their specific setup happens to forward the redirect.
- **Hint on auto-flow bind failure.** When `startAutoOAuthFlow` rejects with `Failed to start OAuth callback server` / `EADDRINUSE` / `timed out`, the error output now includes `Hint: try dario login --manual for headless / container setups.`
- **Help text updated.** `dario login [--manual]` with a one-sentence explanation of when to use it.

Security posture unchanged from the auto flow: PKCE + `client_id` + single-use code + server-side code expiry. State is verified when the pasted input includes it; bare-code pastes (some browsers / copy UIs strip the `#fragment`) still exchange because state isn't load-bearing for the token endpoint (it's CSRF protection for a redirect we don't have in the manual path — the user is pasting their own code, not being redirected anywhere dario controls).

### Added — Test coverage

- **`test/manual-oauth-flow.mjs`** — 30 new assertions: authorize-URL shape (9 params including `code=true` and `MANUAL_REDIRECT_URI`), regression guard that manual flow doesn't re-request the `org:create_api_key` scope Anthropic rejected in dario#42, paste parser across `code#state` / bare / whitespace / empty / leading-# / multi-# inputs, SSH env-var detection (`SSH_CLIENT`, `SSH_TTY`, `SSH_CONNECTION`) with save/restore, and a negative/positive branch for the container cgroup check (CI runs containerized; test accepts either the null or the legitimate `container detected` branch).

Total test footprint: **758 assertions across 22 files** (was 728). Full `npm test` green.

### Why this release

Containers and SSH installs were the last common setup dario couldn't unblock without friction. The "rsync `~/.dario/` from a desktop" workaround worked but required users to have *two* machines with dario installed, which is backwards for a tool whose value prop is "run it on the box that needs the API proxy." The manual flow is the same PKCE handshake Anthropic already supports for CC's own headless login — dario just wasn't surfacing it. No behavior change for desktop users: the auto flow is still the default and the heuristic hint is silent on machines that aren't SSH-ing or containerized.

## [3.19.5] - 2026-04-17

### Changed — `SUPPORTED_CC_RANGE.maxTested` bumped to `2.1.112` (dario#44)

Nightly CC-drift watcher (shipped earlier today) flagged `@anthropic-ai/claude-code@2.1.112` as beyond dario's pinned `maxTested: '2.1.104'`, surfacing as a `[WARN] CC compat` line in `dario doctor` / `dario proxy` for users on current CC. tetsuco's v3.19.4 confirmation on dario#42 showed the same WARN against their real 2.1.112 install — the proxy still started and OAuth refreshed cleanly, so this is a soft-warn cleanup, not a fix for broken behavior.

- **`src/live-fingerprint.ts` — `SUPPORTED_CC_RANGE.maxTested: '2.1.104' → '2.1.112'`.** 2.1.112 is the version tetsuco exercised end-to-end (login → proxy start → fingerprint refresh) on dario#42, so it's the right floor to call "tested" from. The `min: '1.0.0'` floor is unchanged. `checkCCCompat` now returns `ok` for CC v1.0.0 – v2.1.112; users on v2.1.113+ continue to get the `untested-above` soft warn until the next bump.
- **Template re-capture deferred.** `cc-template-data.json` is still stamped `_version: "2.1.104"`, which the drift watcher flags as a low-severity `template.version` drift against 2.1.112. Deferring: the baked template is a seed — the runtime auto-refreshes from the user's own CC binary on first proxy run (see `refreshLiveFingerprintAsync` and tetsuco's `[dario] live fingerprint refreshed from CC 2.1.112` log), so a stale baked template only affects the very first request of a brand-new install before the background capture completes. The re-capture also needs a user-path scrubbing pass first (the current baked file contains capture-host paths). Tracked separately.

### Why this release

Mechanical drift-catch-up follow-up to dario#42 / dario#44. No behavior change for users who were already on 2.1.112 — just silences the spurious `[WARN]` noise and keeps `dario doctor` honest about what's actually been tested.

## [3.19.4] - 2026-04-17

### Fixed — `dario login` fails with "Invalid request format" on CC v2.1.107+ (dario#42)

Between CC v2.1.104 and v2.1.107, Anthropic's authorize endpoint inverted its policy on the `org:create_api_key` scope for CC's prod client_id (`9d1c250a-e61b-44d9-88ed-5944d1962f5e`): the 6-scope list that dario's `FALLBACK` had been sending since v3.4.4 is now rejected with "Invalid request format", and the 5-scope user-only set (the one CC v2.1.107's own binary requests) is the only one accepted. dario#42 (tetsuco) surfaced this as a fresh-login failure on macOS — the authorize URL in the browser returned an Anthropic error before the user could ever complete consent.

- **Drop `org:create_api_key` from `FALLBACK.scopes` in `src/cc-oauth-detect.ts`.** Fallback scope list now matches CC v2.1.107's n36 union: `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`. The scanner already extracts values from the installed binary when possible; `FALLBACK` only kicks in when the binary is missing or unscannable. History comment rewritten to reflect the policy inversion (prior note warned against dropping this scope; that warning is now inverted).
- **Bump cache path `cc-oauth-cache-v3.json` → `cc-oauth-cache-v4.json`.** On upgrade, users regenerate the cache with the new scope list automatically — no manual `rm ~/.dario/cc-oauth-cache-v3.json` required. README and SECURITY references follow the bump.
- **`test/oauth-detector.mjs` scope assertions inverted.** The test that previously demanded `scopes.includes('org:create_api_key')` now asserts its absence; the expected scope count dropped from 6 to 5.

### Fixed — `dario login` silently burns fresh OAuth flows when refresh would have worked (dario#42, secondary)

The old login flow printed `No Claude Code credentials found. Starting OAuth flow...` in two different situations: no credentials at all, and credentials present but expired. The second case was common (any long-running proxy session that didn't refresh in time) and the fresh OAuth flow it triggered was wasteful — the existing refresh token would have worked. Worse, users reading the "not found" message assumed their credentials had been deleted somewhere.

- **`src/cli.ts login()` now attempts `refreshTokens()` before falling through to `startAutoOAuthFlow()`** when credentials exist but `expiresAt < Date.now()` and a `refreshToken` is present. On success, it reports the new expiry and exits; on failure, it reports why refresh failed (redacted via `sanitizeError`) and then proceeds to the OAuth flow. The fresh-OAuth fallthrough message is only printed when there are genuinely no credentials.

### Why this release

#42 was an outright blocker for new installs on current CC: the login URL dario generated was rejected by Anthropic before the user could see the consent page, with a generic error message that looked like a dario bug and had no actionable fix. The root cause was a policy flip on Anthropic's side that matched CC's own binary change, so the fix is mechanical — bring `FALLBACK.scopes` in line with what CC v2.1.107 actually sends. The refresh-before-fresh-flow change is a small UX correction that only bit users whose credentials had expired, but it was confusing them into deleting their `~/.dario/credentials.json` thinking something was wrong.

## [3.19.3] - 2026-04-17

### Fixed — Cline/Kilo/Roo tool calls appear as generic XML in client UI (dario#40)

Default dario mode swaps the client's `tools` array for CC's canonical set so the upstream request looks like a real CC request. For text-tool-protocol clients (Cline, Kilo Code, Roo Code and forks) this confuses the model: it sees CC's canonical `Bash` / `Read` / `Edit` in the `tools` array but it sees the client's XML tool protocol (`<execute_command>`, `<replace_in_file>`, `<attempt_completion>`) in the system prompt. The model resolves the ambiguity by emitting Anthropic's generic `<function_calls><invoke>` wrapper — well-formed for a CC-tool client, unparseable for a text-tool client, so every edit surfaces as an error in the client UI even though the model produced a valid response. `--preserve-tools` resolves it (confirmed by @ringge on v3.19.2), but users shouldn't need to discover a flag exists to use the software.

- **Auto-detect text-tool clients in `src/cc-template.ts`.** New `detectTextToolClient(systemText)` fingerprints the incoming system prompt against three identity strings (`You are Cline`, `You are Kilo Code`, `You are Roo`) and three protocol signatures (`<attempt_completion>`, `<ask_followup_question>`, `<<<<<<< SEARCH`). Identity strings are checked before `scrubFrameworkIdentifiers` strips brand names; protocol signatures survive scrubbing and catch forks that edited the identity line out.
- **Auto-enable preserve-tools behavior in `buildCCRequest`.** When the detector fires and the operator hasn't picked `--hybrid-tools`, `effectivePreserveTools` is set to true for that request — the outbound `tools` array becomes the client's schema verbatim, message-history tool_use remapping is skipped, and the client receives the model's native XML shape. Explicit `--preserve-tools` is unchanged (still honored with or without detection). Explicit `--hybrid-tools` takes precedence over detection: operator opt-in wins, and the detector's output is still returned in `detectedClient` for logging.
- **Detection log in `src/proxy.ts`.** First sighting of each client family ("cline", "kilo", "roo", "cline-like") emits `[dario] detected <family>-style text-tool protocol — auto-enabling preserve-tools for this client …` to stdout. Set-based dedupe so heavy traffic doesn't spam the log. Suppressed when the operator already picked `--preserve-tools` or `--hybrid-tools` (they know what they picked).

### Added — Body-dump verbose mode (dario#40, @ringge feedback)

`-v` alone emitted only a one-line per-request summary (method + path + billing bucket), which wasn't enough to diagnose wire-level client-compat problems without attaching a MITM. `-vv` / `--verbose=2` / `DARIO_LOG_BODIES=1` now dump the outbound request body (redacted via `sanitizeError`: bearer tokens, `sk-ant-*` keys, JWT triples) to stdout, capped at 8KB per request with a truncation marker. Default `-v` is unchanged — file content and tool output stay out of the log unless the operator opts in. Response-body logging is not in this patch; SSE stream buffering is a separate scope.

### Added — Test coverage

- **`test/client-detection.mjs`** — 23 new assertions across 8 cases: identity-string detection for Cline / Kilo / Roo; protocol-signature fallback via `<attempt_completion>`, `<ask_followup_question>`, and the SEARCH/REPLACE diff fence; five negatives (empty / undefined / plain prompt / CC system prompt / generic "search-and-replace" prose) to guard against false positives; auto-preserve wiring through `buildCCRequest` (tools preserved, not replaced); `--hybrid-tools` override semantics; explicit `--preserve-tools` regression guard; default-mode regression guard (no system prompt, no flag → CC remap); array-form `system` field handling.

Total test footprint: **728 assertions across 21 files** (was 705). Full `npm test` green.

### Why this release

v3.19.1 fixed Cline's reverse-translation shape, but the default tool-swap path itself was the trap for text-tool clients — they were getting a correct-but-unparseable response format. `--preserve-tools` was the right knob, it was just undiscoverable. Auto-detection makes correct behavior the default for the clients that need it while keeping the CC fingerprint for every other client that doesn't. `-vv` closes the other half of the issue: when compat breaks on a client dario hasn't seen before, the operator can now see exactly what landed on the wire without reaching for Wireshark.

## [3.19.2] - 2026-04-17

### Fixed — `invalid x-api-key` 401 on live-captured templates (dario#42)

Users on Max 20x and Pro subscriptions started getting `authentication_error: invalid x-api-key` (HTTP 401) against a valid, unexpired OAuth token on v3.19.1. Max 5x was unaffected by the 401 itself but produced a different downstream failure (`Unexpected value(s) 'afk-mode-2026-01-31' for the anthropic-beta header`). Both symptoms traced back to the same root cause: the schema-v2 live capture was lifting CC's on-the-wire headers verbatim into the replay template, and two of those values are only valid in the *capture environment*, not at request time.

- **`x-api-key` placeholder leaked into the template.** The fingerprint spawn sets `ANTHROPIC_API_KEY=sk-dario-fingerprint-capture` and points CC at a loopback MITM, so CC emits `x-api-key: sk-dario-fingerprint-capture` on the captured request. Pre-v3.19.2 that header landed in `template.header_values` and got replayed upstream alongside the real OAuth `Authorization: Bearer` on every proxy request. Anthropic historically ignored `x-api-key` when a Bearer was present, so the bug was latent — as of 2026-04-17 some account tiers started rejecting it with a 401. `src/live-fingerprint.ts` now adds `x-api-key` to `STATIC_HEADER_EXCLUDE` so fresh captures don't store it, and `src/proxy.ts` skips `x-api-key` when overlaying `header_values` onto outbound headers so existing caches self-heal without a template refresh.
- **`oauth-2025-04-20` beta flag was absent from captures.** CC only appends `oauth-2025-04-20` to `anthropic-beta` when it's actually using an OAuth Bearer token — the capture env uses a placeholder API key, so the flag never made it into the captured beta set. The proxy always speaks OAuth upstream, so the flag is required. `src/proxy.ts` now force-adds `oauth-2025-04-20` to the beta list if the template didn't carry it. Same reasoning applies whether the cache is fresh or stale.
- **Generic `Unexpected value(s)` retry for tier-gated betas.** The captured template reflects whatever flags CC emits on the capture host's account tier, so a template taken on a Max 20x machine may carry flags (`afk-mode-2026-01-31`, etc.) that a Max 5x or Pro account doesn't have access to. When the upstream rejects a beta flag as `Unexpected value(s) 'X'` (HTTP 400), `src/proxy.ts` now parses the offending tokens out of the error body, strips them from the beta header, retries once, and caches the rejection per-account for the session — same shape as the existing context-1m retry. Pre-v3.19.2 behavior: the 400 propagated to the client.

### Added

- **Test coverage for the capture-artifact filter (`test/live-fingerprint.mjs`).** One additional assertion verifies `x-api-key` is excluded from `header_values` when present in the captured request, and the schema-v2 fixture's headers now include the real capture-env placeholder to exercise the path end-to-end.

Total test footprint: **705 assertions across 20 files** (was 704). Full `npm test` green.

### Why this release

v3.19.0's schema-v2 capture introduced the "verbatim" principle — whatever CC puts on the wire, we replay. That's the right default for stealth, but two values (`x-api-key`, beta flag set) are environment-dependent: `x-api-key` only exists because dario's capture env forces it, and CC's beta set varies with account tier. v3.19.2 tightens the capture filter to drop the placeholder at write time, adds a defensive skip at replay time so existing caches self-heal, force-adds the oauth beta flag the capture env can't observe, and handles tier-gated beta rejections the same way long-context rejections are already handled — one retry, cached per account.

## [3.19.1] - 2026-04-16

### Fixed — Cline reverse-translation shape (dario#40)

Two `translateBack` entries produced inputs that Cline's schema validator rejected, so every CC tool call going to a Cline client showed an error banner in the Cline UI even though the operation eventually succeeded.

- **`execute_command` — `requires_approval` now emitted.** Cline's `execute_command` marks `requires_approval: boolean` as required alongside `command`. Pre-v3.19.1 the reverse map produced `{command, description?}` only, so Cline logged `execute_command without value for required parameter 'requires_approval'`. Default is `false` — CC already gates Bash upstream through its own permission model, and the borrower controls their own auto-approval settings on the Cline side.
- **`replace_in_file` — `diff` now emitted as a SEARCH/REPLACE block.** Cline's `replace_in_file` takes `{path, diff}` where `diff` is one or more SEARCH/REPLACE blocks in the exact format specified by `cline/cline/src/core/prompts/system-prompt/tools/replace_in_file.ts`. Pre-v3.19.1 the reverse map produced `{path, old_string, new_string}` — valid for Anthropic's Edit tool, not for Cline's `replace_in_file`. Reverse now assembles `------- SEARCH\n<old>\n=======\n<new>\n+++++++ REPLACE` from the Edit input.

Both raw `old_string` / `new_string` fields are removed from the reverse output so Cline doesn't see stray properties.

### Added

- **Regression test for Cline reverse translation (`test/issue-29-tool-translation.mjs` sections 6 and 7).** 17 new assertions covering: `execute_command` emits `requires_approval` as a boolean defaulting to `false`, `command` and `description` forwarded; `replace_in_file` emits a valid `diff` with SEARCH/REPLACE delimiters, the old_string/new_string content survives a regex round-trip from the diff block, and the raw fields are dropped.

Total test footprint: **704 assertions across 20 files** (was 687). Full `npm test` green.

## [3.19.0] - 2026-04-16

### Changed — Stealth + robustness pass

Ten targeted fixes across proxy and shim, combining a stealth audit (proxy vs. shim wire parity, behavioral fingerprints) with a broken-code/logic audit (unbounded buffers, path traversal, silent data loss). The common shape: every item was either a drift vector where proxy and shim emit different bytes for the same request, or a path where a malformed input could corrupt state instead of failing clean.

**Stealth — wire parity and behavioral cadence.**

- **Betas sourced from the live template (schema v2).** `src/proxy.ts` previously hardcoded the v2.1.104 `anthropic-beta` flag set (eight comma-separated flags). `src/shim/runtime.cjs` already read `tmpl.anthropic_beta` with a fallback string — so proxy and shim diverged the instant CC shipped a new beta. Proxy now loads `CC_TEMPLATE.anthropic_beta` identically and uses the same bundled-snapshot fallback. A CC beta-date bump propagates to both transports on the next fingerprint refresh, no dario release needed.
- **Fingerprint schema v2 — `anthropic_beta` + `header_values`.** `src/live-fingerprint.ts` now captures CC's outbound `anthropic-beta` verbatim and a curated set of static header values (`user-agent`, `x-app`, `x-stainless-*`, `anthropic-version`). Excluded by construction: `authorization`, `content-type`/`content-length`/`host` (body-framing), `x-claude-code-session-id` / `x-client-request-id` (session-scoped), `anthropic-beta` (captured separately), `x-anthropic-billing-header` (rebuilt per-request from `cc_version`). `CURRENT_SCHEMA_VERSION` bumped 1 → 2; pre-v2 caches are dropped and rewritten on next refresh. The proxy's `staticHeaders` overlays `header_values` after its own defaults so any CC-side value nudge is replayed automatically.
- **Single-account session stickiness.** `src/proxy.ts:98` previously rotated `SESSION_ID = randomUUID()` on every request, reasoning that "a persistent session ID is a behavioral fingerprint." Empirically the opposite: real CC rotates once per conversation, not per call, so a user with a distinct session-id per request looks nothing like a CC user. v3.19 keeps `SESSION_ID` stable across a conversation window (`SESSION_IDLE_ROTATE_MS = 15m`) and only rotates after an idle gap long enough to credibly indicate a new conversation. Pool mode still uses `poolAccount.identity.sessionId` (stable per account) — unchanged.
- **FRAMEWORK_PATTERNS expansion.** Seven additional identifiers (`zed`, `plandex`, `tabby`, `amazon q`, `opencode`, `daytona`, `roo code`) added to the scrub list in `src/cc-template.ts`. Same word-boundary + path-preservation semantics as the existing set — stripped in prose, preserved inside paths and URLs (dario#35 still holds).
- **Context-1m retry variance.** `src/proxy.ts:1078` rebuilt the reduced-beta header via `beta.replace(',context-1m-…','').replace('context-1m-…,','')` — a deterministic string-replace that leaves trailing-comma or ordering artifacts exploitable if the base set ever carries context-1m in multiple positions. Switched to `beta.split(',').filter(t => t !== 'context-1m-…').join(',')` — matches the skipContext1m fast-path exactly, and the retry shape is now byte-identical to a request that started without context-1m.

**Broken-code/logic — unbounded buffers, silent truncation, path safety.**

- **SSE line 413-reject.** `src/proxy.ts:1317` silently truncated SSE lines longer than 1MB with `buffer = buffer.slice(-MAX_LINE_LENGTH)`, which hid upstream protocol bugs (a runaway event stream indefinitely with the tail overwritten each chunk) and guaranteed a malformed JSON parse at the client. v3.19 emits an OpenAI-shape error marker, the `[DONE]` sentinel, and aborts the upstream read (`upstreamAbortReason = 'sse_overflow'`) so billing stops. Fails loud, fails once.
- **BufferedToolBlock.partial size cap.** `src/cc-template.ts:1224` accumulated `input_json_delta` chunks per content block with no ceiling. A malformed upstream `tool_use` stream could OOM the proxy in-process. v3.19 caps at 2MB (`MAX_TOOL_PARTIAL_BYTES`) — on overflow, the accumulated bytes flush as a passthrough `content_block_delta`, the block is dropped from the buffered map, and subsequent deltas/stop events pass through unchanged. Client loses translation for that one block but the proxy doesn't starve.
- **Envelope shape guard on `/v1/pool/borrow`.** `src/proxy.ts:613` forwarded `envelope.request` to Anthropic under the lender's identity without checking shape. Typed `unknown` on the wire — a borrower could waste a lender's rate-limit slot with a primitive, an array, or an object missing `model`/`messages`. v3.19 validates the minimum Anthropic `/v1/messages` shape (plain object, string `model`, array `messages`) before spending the slot; malformed envelopes get 400 locally. (Not SSRF — the upstream URL is a hardcoded `ANTHROPIC_API` constant.)
- **Windows `.cmd`/`.bat` shell-char guard.** `src/live-fingerprint.ts` — `probeInstalledCCVersionUncached` and the fingerprint-capture spawn both use `shell: true` on Windows when the resolved binary ends in `.cmd`/`.bat` (Node 20+ / CVE-2024-27980 hardening requires it). Both paths now reject the binary if it contains any shell metacharacter (`& | > < ^ " ' % \r \n ` $ ; ( ) { } [ ]`) before spawning — `DARIO_CLAUDE_BIN` is user-controlled, so an override reaching the shell path could otherwise let cmd.exe interpret its contents.
- **`path.basename` defense on account/backend file ops.** `src/accounts.ts` and `src/openai-backend.ts` previously joined caller-supplied alias/name directly into the filesystem path (`join(ACCOUNTS_DIR, '${alias}.json')`), so an alias like `../../etc/passwd` landed outside the accounts dir. v3.19 routes both through `safeAliasPath` / `safeBackendPath` — strips any directory component via `basename`, rejects `.`/`..`, enforces `^[A-Za-z0-9][A-Za-z0-9_\-.]{0,63}$`. CLI input was already constrained, but the module API is importable — defense in depth.

### Added

- **Test coverage for the schema-v2 capture, the tool-partial cap, and the expanded framework patterns.** `test/live-fingerprint.mjs` now has 16 additional assertions covering `_schemaVersion === 2`, verbatim `anthropic_beta` capture, inclusion of fingerprint-relevant static headers, and exclusion of every auth/body-framing/session-scoped key. `test/streaming-edge-cases.mjs` adds section 8 — a 2.2MB aggregate `input_json_delta` stream verifies the mapper flushes the full payload on overflow, emits `content_block_stop`, reaches `[DONE]`, and loses no bytes. `test/scrub-paths.mjs` adds 13 assertions across the new framework identifiers (prose-strip and path-preserve both directions).

Total test footprint: **687 assertions across 20 files** (was ~640). Full `npm test` green.

### Why this release

v3.18 closed the contract gap between dario and Anthropic's schema validator. v3.19 closes the parity gap between dario's two transports (the hardcoded proxy path had drifted from the template-driven shim path across every CC beta-date bump since v3.13) and the failure-mode gap for malformed upstreams (silent SSE truncation, unbounded tool-input buffers, and path-traversal holes that all existed since the corresponding file's first commit). Every observable dario emits now comes from the live template or fails loud — no more hardcoded strings quietly diverging as CC upgrades, and no more degraded-but-silent paths where a bad upstream corrupts a good proxy.

---

## [3.18.0] - 2026-04-16

### Fixed — Tool-schema contract audit (dario#43)

An audit of `TOOL_MAP` against CC's live `input_schema` definitions surfaced three entries that produced shapes Anthropic's schema validator would reject before the model ever saw them. Each one looked fine in isolation and had zero test coverage, so they failed only in production with clients that exercised those paths.

- **WebFetch requires `prompt` (eight entries).** `web_fetch`, `webfetch`, `fetch`, `browse`, `read_url_content` (Windsurf), `web_extract` (Hermes), `fetch_webpage` (Copilot), and `browser` all produced `{url}` only. CC's WebFetch schema marks both `url` and `prompt` as required (`required: ["url", "prompt"]` in `cc-template-data.json`). A new `webFetchArgs(url, clientPrompt?)` helper injects a generic extraction prompt when the client omits one, and promotes client-side intent fields (Copilot's `query`, Hermes' `prompt`) into the CC slot when present. No API change.
- **`message`, `ask_followup_question` (Cline/Roo), `clarify` (Hermes) → AskUserQuestion.** All three produced `{question: "..."}`. CC's AskUserQuestion requires a structured `{questions: [{question, options: [{label, description?}], header?, multiSelect?}]}` with `minItems: 2` on options. Synthesizing fake yes/no options would misrepresent what the client's agent actually asked and mislead the model about the user's real choices. The mappings are dropped. Clients that need ask-user flows should use `--preserve-tools` so their real schema flows through untouched.
- **`notebook_read` → NotebookEdit.** NotebookEdit requires `new_source`; the old mapping supplied only `notebook_path`. Because CC has no notebook-read tool, no valid 1:1 mapping exists — a synthesized empty `new_source` with `edit_mode: 'replace'` would be silently destructive (overwrite a cell with empty content). Dropped. Clients that need it should use `--preserve-tools`.

### Added

- **`create_file` → Write (Copilot).** Previously round-robin'd to a fallback; now a direct map.
- **`str_replace_editor` limitation documented.** Only the `str_replace` discriminator is translatable into CC's Edit. The `view`, `create`, `insert`, and `undo_edit` commands don't have clean 1:1 maps (view → Read, create → Write, insert → Edit with different semantics) and would silently produce empty old/new string pairs. Comment updated to point users at `--preserve-tools` for non-str_replace flows.
- **Schema-contract regression test (`test/tool-schema-contract.mjs`).** 129 assertions. Declares one client tool per known TOOL_MAP key, runs `buildCCRequest` to get the resolved toolMap, and validates every `translateArgs` output against the corresponding CC tool's live `input_schema` from `cc-template-data.json`. Catches:
  - Missing required fields (the dario#43 WebFetch + AskUserQuestion class).
  - Type mismatches (string-where-array, etc).
  - `minItems` violations on array fields.
  - Dropped mappings re-appearing: the four intentionally-unmapped client tool names (`message`, `ask_followup_question`, `clarify`, `notebook_read`) are asserted to land in `unmappedTools` — re-adding them without fixing the shape fails the test loudly.
  - Missing test samples: a new entry added to TOOL_MAP without a sample in the test fails with "no test sample defined."

Total test footprint: **~640 assertions across 20 files** (was ~511 across 19). Full `npm test` green.

### Why this release

v3.17 closed the environmental flakiness gaps — disk, network, upstream binary drift. v3.18 closes the contract gap between dario's client-facing tool map and Anthropic's server-side schema validator. Three of these bugs had been in the code for months but failed silently: the client's `tool_use` got routed correctly on dario's side, then Anthropic rejected the translated shape before the model saw it, producing a 400 that looked like a client error to the user and an Anthropic error to the server logs — with dario invisible in both. The new contract test runs entirely in-process from the bundled template, so it catches the whole class of "dario built a shape CC doesn't accept" regressions at `npm test` time instead of at user-bug-report time.

---

## [3.17.0] - 2026-04-16

### Added — Robustness pass: drift detection, compat matrix, doctor command, atomic cache, OAuth single-flight, corruption recovery, streaming audit

v3.17.0 doesn't add user-facing features — it closes seven reliability gaps that only show up when the real world gets weird. Upstream `claude` updates invalidate captured templates silently. Concurrent token refreshes race. Partial disk writes corrupt the cache mid-rename. Unparseable cache files kill startup. SSE chunks arrive mid-JSON, mid-UTF-8, or mid-tool-block. Each of these had a latent path to a confused error message or a hung proxy; v3.17 makes each of them loud, recoverable, or provably handled.

- **Drift detection (`src/live-fingerprint.ts`).** The live cache now carries `_schemaVersion: 1` and the captured `claude` version. On startup, `detectDrift()` probes the installed binary (`execFileSync('claude', ['--version'])`, with `shell: true` on Windows for `.cmd` shims — bounded input so CVE-2024-27980 doesn't bite) and compares. Mismatch logs a one-line warning and triggers a forced `refreshLiveFingerprintAsync({ force: true })`. Users no longer silently sit on a template captured against an older `claude` binary. `describeTemplate(t)` formats `"live capture, CC v2.1.104 (3h old)"` for the startup banner; `formatCaptureAge(iso)` handles the `30s`/`5m`/`3h`/`3d` buckets.
- **Compat matrix (`src/live-fingerprint.ts`).** `SUPPORTED_CC_RANGE = { min: '1.0.0', maxTested: '2.1.104' }` encodes the tested band in code. `checkCCCompat()` returns `ok` / `below-min` (warn, dario may break) / `untested-above` (warn, may work) / `unknown` (no binary found). `compareVersions()` is a 60-line zero-dep dotted-numeric comparator with prerelease suffix tiebreaker — no `semver` import, per the zero-runtime-deps policy.
- **`dario doctor` (`src/cli.ts`, new `src/doctor.ts`).** Single aggregating diagnostic command. Checks: dario version, Node (≥18 ok), platform, `claude` binary path + version + compat status, template source + age + drift, OAuth status, pool aliases + expired count, configured backends, home dir. Output is column-aligned with `[ OK ]` / `[WARN]` / `[FAIL]` / `[INFO]` prefixes; exit code is 1 if any check is `fail`, else 0. Each check is individually try/caught so one failure doesn't hide the others. Gives support threads one command to ask for instead of a screenshot dragnet.
- **Atomic cache writes (`src/live-fingerprint.ts`).** `writeLiveCache` now goes through `atomicWriteJson(path, data)`: write to a pid-qualified `.tmp` sibling, `rename` into place. The pid suffix means two concurrent dario processes writing the same target don't clobber each other's in-flight tmp. Replaces the prior direct `writeFileSync`, which could leave a half-written cache on an OS crash mid-write.
- **OAuth single-flight (`src/accounts.ts`).** `refreshAccountToken(creds)` wraps `doRefreshAccountToken(creds)` behind a per-alias `Map<string, Promise<AccountCredentials>>` with `.finally` cleanup. Two concurrent calls for the same alias now share one outbound `POST /oauth/token` and both resolve to the same credentials; two concurrent calls for *different* aliases still each run their own fetch. The pool's background refresh timer and a user-triggered request hitting the same alias at the same millisecond was the silent-failure case here — pre-fix it sent two refreshes, the loser invalidated the winner's refresh token, and the next request blew up trying to re-authenticate.
- **Cache corruption recovery (`src/live-fingerprint.ts`).** `readLiveCache` now does staged validation: read → parse → structural validate → schema-check. Parse or validation failures quarantine the file (`cc-template.live.json.bad-<timestamp>`) and log a one-line stderr note; a future-version schema returns null silently (the next refresh writes a current-schema file). Before v3.17, a corrupt cache from a half-written disk or a cross-version binary downgrade would throw at startup. Now it self-heals on the next capture and keeps the bad file for post-mortem.
- **Streaming robustness audit (`test/streaming-edge-cases.mjs`).** 23 assertions across seven sections: (1) byte-by-byte chunking produces byte-identical output to whole-input feed, (2) two concurrent `tool_use` blocks at indices 0 and 1 translate independently, (3) a tool_use with zero deltas between start and stop still emits a synthetic `{}` input, (4) a 4-byte UTF-8 emoji (🦀) split across single-byte chunk boundaries survives intact, (5) `:keep-alive` SSE comments and the `[DONE]` sentinel pass through untouched, (6a/b/c) `end()` on empty is a no-op, `end()` flushes a trailing event with no final blank line, `feed()` on an empty chunk is a no-op, (7) an empty tool map returns the zero-overhead passthrough mapper. No implementation changes — the audit caught no regressions, but locks in the behavior so future edits to `createStreamingReverseMapper` can't quietly break any of these axes.
- **Test coverage added.** `test/drift-detection.mjs` (28 pass), `test/compat-range.mjs` (28 pass), `test/doctor-formatter.mjs` (17 pass), `test/atomic-write.mjs` (9 pass), `test/account-refresh-singleflight.mjs` (10 pass), `test/streaming-edge-cases.mjs` (23 pass). All wired into `npm test`.

Total test footprint: **~511 assertions across 19 files** (was ~396 across 13). Full `npm test` green.

### Why this release

v3.13–v3.16 were about audience and fingerprint. v3.17 is about what happens when the machine is cold, the disk is slow, the network is flaky, or the user upgrades `claude` without restarting dario. None of those scenarios were rare — they just failed in ways that looked like dario bugs, not environment bugs. With drift detection and `dario doctor`, the diagnostic loop shrinks from "paste your logs" to "paste `dario doctor`." With atomic writes, single-flight, and corruption recovery, the three most common "dario got weird after I did X" patterns (OS crash, pool + manual refresh race, cache got truncated) stop being silent-failure paths. With the streaming audit, the one code path where a subtle off-by-one would corrupt every user's `tool_use` call for a week before anyone noticed now has lockstep coverage for chunk boundaries, UTF-8 splits, and `end()` corners.

---

## [3.16.0] - 2026-04-16

### Added — Proxy-mode header_order replay (closes v3.13.0 deferred item)

v3.13.0 captured CC's exact outbound header sequence in `template.header_order` and wired it into the shim's `rewriteHeaders`, but left the proxy emitting headers in the insertion-order Node's fetch happens to serialize. That was the explicit deferred item: *"Proxy-mode replay of header_order is deferred to v3.13.x — the same `template.header_order` field is already loaded into the proxy's template replay path and will pick up automatically when the proxy's outbound header builder is extended."* v3.16.0 extends it. Every outbound `/v1/messages` request from the proxy now serializes headers in the exact sequence CC emits on the wire, matching the shim — so header sequence is no longer a signal that distinguishes proxy traffic from shim traffic from real CC.

- **`src/cc-template.ts`** — new `orderHeadersForOutbound(headers, overrideHeaderOrder?)` helper. When the live template has no `header_order` (bundled-only installs, or a capture that didn't record `rawHeaders`) it returns the input record unchanged — strict no-op, no behavior change for users who haven't run a live fingerprint capture yet. When `header_order` is present it returns an `Array<[string, string]>` of pairs in captured order. The array form is used because it's the one `HeadersInit` variant that preserves wire order under the fetch spec — a plain object gets iterated case-insensitively by the underlying HTTP library, and a `Headers` instance iterates alphabetically. Caller-supplied headers absent from the captured order (content-type, content-length, client betas that weren't in CC's capture) are appended at the tail in caller insertion order so nothing is silently dropped. Name matching is case-insensitive so the helper works equally on the proxy's mixed-case record and the shim's lowercased Map. Logic mirrors `rewriteHeaders` in `src/shim/runtime.cjs` — two transports, one wire shape.
- **`src/proxy.ts`** — both outbound fetch call sites (main dispatch at `/v1/messages`, and the context-1m retry) now pass `orderHeadersForOutbound(headers)` to `fetch` instead of the raw record. Pool-failover paths mutate the same `headers` record in place and re-enter the main dispatch loop, so they pick up the new ordering through the main site. Passthrough mode (`--passthrough` / `--thin`) is explicitly bypassed — passthrough means "don't shape this request to look like CC," and reordering is a form of shaping; preserving that split keeps passthrough's intent intact.
- **`test/proxy-header-order.mjs`** — 20 assertions on the pure helper. Covers: undefined/empty `header_order` returns the input record reference-unchanged (no-op), captured five-header order is preserved exactly, case-insensitive matching with case-preserving emission from the captured order, extras tail-append in caller insertion order, absent-from-caller names skipped rather than emitted as `undefined`, duplicate names in captured order deduped (first-occurrence wins), empty caller record with non-empty captured order produces an empty array. Registered in `npm test`.

Total test footprint: **~396 assertions across 13 files** (was ~376 across 12). Full `npm test` green.

### Why this release

Closes the last of the v3.13.0 "hide in the population" deferred work. With shim mode and proxy mode now emitting identical header sequences, the remaining fingerprint vectors (TLS JA3/JA4, HTTP/2 SETTINGS, request timing, sessionId rotation cadence, body field ordering — see `src/live-fingerprint.ts` design comment) are transport-layer concerns that don't live at the outbound-header boundary. This is the cheapest lever-pull per line of code on that roadmap, and it's the one that was already designed in v3.13.0 and just needed shipping.

---

## [3.15.0] - 2026-04-16

### Added — OpenClaw + Hermes coverage on TOOL_MAP

Three new entries close out tool-name coverage for the Hermes agent framework on top of the universal `TOOL_MAP` introduced in v3.14. OpenClaw's `exec` / `process` / `web_search` / `web_fetch` / `browser` / `message` were already covered from prior releases, and Hermes's `terminal` shares the `{command}` shape of the existing `terminal` entry — so neither needed new entries, only a confirmation pass and a code comment recording the overlap. Total `TOOL_MAP` entry count: **71**.

- **`src/cc-template.ts`** — three new entries. `patch` (Hermes → `Edit`, translateBack rebuilds the `{mode: "replace", replace_all: false}` envelope Hermes's validator expects). `web_extract` (Hermes → `WebFetch`, handles the `{urls: [...]}` input shape by forwarding the first URL and rebuilds the array on the return path). `clarify` (Hermes → `AskUserQuestion`). A short comment near the `execute_bash` / `terminal` region documents that Hermes's `terminal` tool routes through the existing entry unchanged, so future readers don't assume it's missing.

### Why this release

Pure compatibility expansion on top of v3.14. Users on Hermes (or any future framework whose `patch` / `web_extract` / `clarify` names collide with these) now route through the Claude backend without `--preserve-tools`, keeping the CC fingerprint intact. No crypto, no fingerprint, no new surface area — the point is that dario stops being the source of tool-validation failures for one more agent family.

---

## [3.14.0] - 2026-04-16

### Added — Universal TOOL_MAP for every major coding agent (#40)

Pre-mapped tool-name translations for **Cline, Roo Code, Cursor, Windsurf, Continue.dev, GitHub Copilot, and OpenHands**. Each ships its own tool schema — seven different ways to say "run a command" (`execute_command`, `run_terminal_cmd`, `run_command`, `builtin_run_terminal_command`, `run_in_terminal`, `execute_bash`), and equivalent divergence on edit / read / write / search / glob. Before v3.14 most of these needed `--preserve-tools` to route through the Claude backend without the model's outputs coming back stripped of required fields, which meant trading away the CC subscription fingerprint to make the agent work. The universal `TOOL_MAP` lifts that trade: whichever agent you're running, its tool calls translate to CC's `Bash/Read/Write/Edit/Grep/Glob/WebSearch/WebFetch` on the outbound path and rebuild to the agent's exact expected shape — including agent-specific fields CC's schema never carried — on the inbound path. Subscription fingerprint stays intact. Validator is happy.

- **`src/cc-template.ts`** — 28 new `TOOL_MAP` entries plus broadened `translateArgs` alias-accept on several existing ones.

  - **Bash family.** `execute_command` (Cline / Roo), `run_terminal_cmd` (Cursor, preserves `explanation` ↔ `description`), `run_command` (Windsurf, rebuilds `CommandLine` + `Blocking: true`), `builtin_run_terminal_command` (Continue.dev), `run_in_terminal` (Copilot), `execute_bash` (OpenHands, rebuilds `is_input: "false"` + `security_risk: "LOW"`).
  - **Read family.** `view_file` (Windsurf, with `StartLine`/`EndLine` ↔ `offset`/`limit` arithmetic so line ranges round-trip), `builtin_read_file` (Continue.dev), plus `target_file` (Cursor) now accepted as an alias on the existing `read_file` mapping.
  - **Write family.** `write_to_file` (Cline / Roo / Windsurf, with `TargetFile` + `CodeContent` aliases), `builtin_create_new_file` (Continue.dev). The existing `edit_file` was fleshed out from a bare `{ccTool: 'Edit'}` to a full args/translateBack pair that accepts Cursor's `target_file` and OpenHands's `old_str`/`new_str` aliases.
  - **Edit family.** `replace_in_file` (Cline / Roo), `apply_diff` (Roo, `reverseScore: 1` because the true inbound shape carries a `diff` string dario can't reconstruct from `{old_string, new_string}` alone — legitimate Edit mappings win the reverse-path tie), `search_replace` (Roo / Cursor), `builtin_edit_existing_file` (Continue.dev, with `replacement` ↔ `new_string`), `insert_edit_into_file` (Copilot, with `code` ↔ `new_string`), `str_replace_editor` (OpenHands, rebuilds `command: "str_replace"` + `security_risk: "LOW"`).
  - **Glob family.** `file_search` (Cursor, accepts `glob_pattern` / `query`), `list_dir` (Cursor / Windsurf / Copilot, `reverseScore: 3` — it's a common collision target), `find_by_name` (Windsurf, `reverseScore: 5` — highest in the Glob slot because the `{Pattern, SearchDirectory}` shape is most specific), `builtin_file_glob_search` + `builtin_ls` (Continue.dev, `builtin_ls` carries `reverseScore: 1` to yield to any real glob).
  - **Grep family.** `grep_search` (Cursor / Windsurf, handles `Includes[]` → `glob` on the outbound path), `codebase_search` (Cursor / Windsurf / Roo / Copilot, `reverseScore: 3`), `builtin_grep_search` (Continue.dev), `semantic_search` (Copilot, `reverseScore: 2`).
  - **Web family.** `read_url_content` (Windsurf), `fetch_webpage` (Copilot), `search_web` (Windsurf → `WebSearch`).

  Tool-schema-unique fields that CC's schema doesn't carry (`is_background`, `Blocking`, `recursive`, `security_risk`, `explanation`, `CommandLine`, `AbsolutePath`, `TargetFile`, `CodeContent`, `SearchDirectory`, `Includes`, etc.) are reconstructed on `translateBack` with the agent's expected defaults so the inbound validator is satisfied. Reverse-score values on colliding entries keep the v3.9.6 / v3.12.1 disambiguation machinery working correctly when more than one agent's tools map onto the same CC slot.

### Why this release

The `--preserve-tools` discoverability issue surfaced in v3.8.1 and the hybrid-tools workaround from v3.9.0 both existed because dario's translator knew about Claude Code's own tools and not much else. Every agent with its own tool names was a silent failure case unless the user knew to flip `--preserve-tools` (and lose the fingerprint) or `--hybrid-tools` (and paper over the gap with request context). v3.14 makes the default mode work for the agents people actually run — no flag, no fingerprint loss, no validator errors, no issue thread. It's the biggest single audience-expansion release dario has shipped.

---

## [3.13.0] - 2026-04-15

### Added — Session stickiness for AccountPool

Multi-turn agent sessions now pin to a single account for the life of the conversation, so the Anthropic prompt cache isn't destroyed by account rotation between turns.

**The problem.** Claude Max prompt cache is scoped to `{account × cache_control key}`. When the pool rotates a long agent conversation across accounts on headroom alone, turn 1 builds a cache entry on account A, turn 2 lands on account B and reads nothing from A's cache, paying full cache-create cost again. For a long agent session that's a 5–10× token cost multiplier on the cache-reused portion of every turn after the first — the exact opposite of what the pool should be doing for users.

**The fix.** A new `selectSticky(stickyKey)` path on `AccountPool`. The proxy hashes a conversation's first user message into a 16-hex-char `stickyKey` (SHA-256 truncated, deterministic, trims whitespace, null on empty input), and binds the key to whichever account `select()` would have picked on the first turn. Subsequent turns of the same conversation re-use that account as long as it's still healthy (not rejected, token not within the 30s expiry grace window, headroom > 2%). When any of those conditions fails the binding rebinds to a new headroom winner — at that point the old account's cache entry for this conversation is effectively stranded until reset anyway, so there's no cost to moving. The proxy also calls `rebindSticky` on both 429 failover paths so the next turn doesn't re-select the exhausted account through a stale binding.

**Why hashing the first user message.** Multi-turn agent sessions carry the same first user message on every turn (CC, OpenClaw, Hermes, Claude Code itself). Hashing it gives a stable per-conversation key without requiring client cooperation — no header to plumb, no opt-in. Conversations where the first user message is empty or whitespace-only return null and bypass stickiness entirely (delegate to plain `select()`).

**Bookkeeping.** Bindings have a 6-hour TTL (matches Max's 5-hour rate-limit window plus buffer — past that point a "same" conversation is starting a fresh window anyway, so rebinding is free) and a 2,000-entry size cap with lazy O(n) cleanup on each `selectSticky` call. Removed accounts have their bindings dropped on the next cleanup pass. The `/accounts` endpoint surfaces `stickyBindings: <count>` for observability.

#### What's in this release

- **`src/pool.ts`** — new `computeStickyKey(firstUserMessage)` helper, `StickyBinding` interface, `STICKY_TTL_MS` / `STICKY_MAX_ENTRIES` constants, `sticky: Map<string, StickyBinding>` field on `AccountPool`, and methods `selectSticky`, `rebindSticky`, private `cleanupSticky`, plus `stickyCount` / `stickyAliasFor` test helpers. The existing `select()` is unchanged — sticky is layered on top, never replacing it.
- **`src/proxy.ts`** — imports `computeStickyKey`, derives `stickyKey` from `extractFirstUserMessage(r)` inside the template replay path, calls `pool.selectSticky(stickyKey)` to swap to the bound account before `bodyIdentity` is built (so identity headers and access token stay consistent). Both 429 failover paths now call `pool.rebindSticky(stickyKey, nextAccount.alias)`. The `/accounts` endpoint reports `stickyBindings`.
- **`test/pool-sticky.mjs`** — 35 assertions across 10 sections: `computeStickyKey` deterministic / whitespace-trim / null cases / 16-hex-char shape; `selectSticky` first-call binds to headroom winner; second-call returns the same account even when a different one has better headroom now (the core cache-preservation property); null key bypasses stickiness; rebind on rejected bound account; rebind on headroom collapse below 2%; rebind on token expiry; explicit `rebindSticky` from 429 failover path; null-key / unknown-alias `rebindSticky` no-ops; `cleanupSticky` drops bindings for removed accounts; multi-conversation distinct keys bind to distinct accounts and don't interfere.

### Added — Sealed-sender overflow protocol (decentralized pooling, privacy layer)

Trust-group members can now lend each other Claude capacity with **cryptographic unlinkability**: a lender can verify the borrower is a valid group member without learning *which* member, so no one in the pool can surveil another through borrow telemetry. This is the privacy primitive underneath the decentralized pooling model — it does not provide anonymity from Anthropic (the request still lands under the lender's attributable account), only between group members.

**The primitive.** RSA blind signatures (Chaum 1983), implemented from scratch on top of Node's `crypto` module using `RSA_NO_PADDING` to get raw `m^e mod n` / `c^d mod n` primitives. Full-Domain Hash via MGF1-SHA256 (with counter retry to stay within Z_n) prevents multiplicative forgery on the signing step. The flow: the group admin signs *blinded* tokens in a batch without seeing their real values; the member unblinds locally to obtain valid RSA-FDH signatures on random tokens the admin has never seen and can never correlate to the member. When a member spends a token with a lender, the lender verifies the signature with the group public key — it proves "some member got this signed" without identifying who.

**Key management.** `GroupAdmin` holds the private key, enforces per-member quotas and expiry on `signBatch`, and tracks membership in a flat map (`addMember` / `removeMember`). `GroupMember` prepares blinded batches, finalizes them locally against the admin's signed blobs, and spends tokens one at a time via `consumeToken`. `GroupLender` accepts incoming borrow envelopes, verifies signatures against the imported group public key, and prevents double-spend through a SHA-256 hash set scoped to the group — a replayed token is rejected before any Anthropic call is made.

**Wire format.** `{v:1, groupId, token, sig, request}` — JSON envelope, base64url-encoded token, hex-encoded signature, the real Anthropic request body nested inside. Exports/imports via `ExportedGroupKey` let admins distribute the public key + groupId alongside per-member keypairs (admins never share the private modulus factors).

**Proxy integration.** A new `POST /v1/pool/borrow` endpoint on `src/proxy.ts`, gated by the presence of `~/.dario/group.json` (populated by `exportGroupPublicKey`). The endpoint sits **before** `checkAuth` because the group signature IS the authentication — doubling it with a local API key would add nothing. On a valid borrow, the proxy delegates to `pool.select()` to pick one of the lender's local accounts and forwards the request to Anthropic under that account's identity, updating rate limits on the response. Full feature-parity with `/v1/messages` (streaming, 429 failover, reverse tool mapping) is intentionally a separate change so v3.13.0 doesn't rewrite the 1.3k-line proxy handler at the same time as shipping new crypto.

- **`src/sealed-pool.ts`** — ~450 lines. BigInt helpers (`egcd`, `modInverse`), raw RSA via `publicEncrypt`/`privateDecrypt` with `RSA_NO_PADDING`, FDH with MGF1-SHA256, `blindToken` / `signBlinded` / `unblindSignature` / `verifyTokenSignature`, `GroupAdmin` / `GroupMember` / `GroupLender` classes, key export/import, wire-format helpers.
- **`src/proxy.ts`** — `groupLender` init from `~/.dario/group.json`, `/v1/pool/borrow` handler with body-size/timeout limits, envelope decode, group match, token parse, `acceptBorrow` verification, upstream forwarding with rate-limit update. `/accounts` now surfaces `sealedSender: { groupId, seenTokens }` for observability.
- **`test/sealed-pool.mjs`** — 57 assertions: raw RSA roundtrip, blind-signature unlinkability (admin cannot link finalized signature to the batch index), rejection of wrong-key / tampered-sig / wrong-group / double-spend cases, key export/import roundtrip, `GroupAdmin` membership + quota + expiry enforcement, `GroupMember` token finalization and spend tracking, `GroupLender` double-spend prevention under concurrent borrows, wire-format decode/encode, end-to-end two-member unlinkability proof.

### Added — Live fingerprint header_order capture (hide in the population, #1)

The live-fingerprint capture path (`src/live-fingerprint.ts`) now records the exact HTTP header order the real CC binary emitted, not just header values. HTTP libraries emit headers in distinctive orders — Node's alphabetical, undici's insertion-order, browsers' own specific orderings — and header sequence alone is a strong fingerprint vector for anyone trying to tell a proxy from a real client. Capturing it lets the outbound path (today: the shim; tomorrow: the proxy-mode replay) match CC exactly.

- **`src/live-fingerprint.ts`** — new ~80-line design comment at the top documenting the six known fingerprint vectors (header order, TLS JA3/JA4, HTTP/2 SETTINGS, request timing distribution, sessionId rotation cadence, body field ordering) with a roadmap for incremental mitigation. `CapturedRequest` gains a `rawHeaders: string[]` field that snapshots Node's `req.rawHeaders` (flat `[k1, v1, k2, v2, ...]` array that preserves insertion order — unlike the flattened `req.headers` map, which loses it). `extractTemplate` calls a new `extractHeaderOrder(rawHeaders)` helper to walk the flat array, lowercase names, de-duplicate while preserving first-occurrence order, and store the result in `TemplateData.header_order?: string[]`. When `rawHeaders` is empty or absent (older captures, synthetic fixtures) `header_order` is `undefined` and downstream replay paths fall through to default ordering.
- **`test/live-fingerprint.mjs`** — 7 new assertions covering `header_order` captured from rawHeaders, dedup of repeated headers (first occurrence wins), exact insertion-order preservation for a five-header capture, and the fallthrough case when `rawHeaders` is empty. Brings the live-fingerprint suite to 27 total.

### Changed — Shim runtime hardening (`src/shim/runtime.cjs`)

Doubling down on the in-process shim introduced in v3.12.0. The shim is the one transport Anthropic literally cannot detect without shipping signed-binary integrity checks against `globalThis` from inside their own CC binary, so it's worth making it robust enough to live there quietly across CC upgrades.

- **Runtime detection.** New `detectRuntime()` checks `globalThis.Bun` / `globalThis.Deno` / `process.versions.node`. Non-Node runtimes log a warning through the existing `DARIO_SHIM_VERBOSE` channel — the shim still tries to patch `globalThis.fetch` (which all three runtimes expose) but flags that body/header semantics were only validated against Node. This is the canary for the day Anthropic ships a Bun-compiled CC: users will see the warning and know to expect quirks before they hit a silent drift.
- **Template mtime-based auto-reload.** `loadTemplate()` now stats `cc-template.live.json` on every call and only re-reads + re-parses when the mtime changes. Previously the template was loaded once at require time and never refreshed; long-running child processes (a `claude` session running for hours) could miss a mid-session fingerprint refresh from dario's live capture. Cached instance returned for unchanged mtime so we don't stat on every intercept in the hot path is still cheap. Version transitions log through `DARIO_SHIM_VERBOSE`.
- **Strict defensive `rewriteBody`.** The previous logic accepted `body.system.length >= 1` and invented `[1]` and `[2]` blocks out of thin air if they didn't exist — a recipe for silent corruption on the day Anthropic ships a restructured system array. Rewritten to require exactly `length === 3` with every block being `{type: 'text', text: string}`. On any mismatch the shim logs the skip reason and returns `null`, falling through to the original fetch — passthrough on a shape CC shipped without us knowing is always safer than blind replacement.
- **`rewriteHeaders` honors `template.header_order`.** Ties the v3.13.0 header_order capture (above) directly into the shim: when the template carries a `header_order`, the shim rebuilds the outgoing header list in that exact sequence, appending any caller-supplied extras at the tail. The return type changed from `Headers` to `Array<[name, value]>` — a valid `HeadersInit` — because `Headers` iteration is spec-sorted alphabetically, which would destroy the captured order. An array of pairs is the one `HeadersInit` variant that guarantees wire order is preserved by fetch()'s HTTP layer.
- **`checkVersionDrift`.** New helper logs (verbose only) when the child's `user-agent` cc_version differs from the template's, so a CC upgrade landing during a stale-cache window is visible in logs instead of silently impersonating the old version. The shim still overrides the user-agent regardless — this is a debug signal, not an error path.
- **`test/shim-runtime.mjs`** — 21 new assertions (47 total, up from 26) covering: runtime detection identifies Node, `loadTemplate` caches on unchanged mtime and reloads on bumped mtime, `rewriteBody` strict shape rejects `length=1` / `length=4` / missing-system / non-text-block bodies and accepts the correct three-text-block shape, `rewriteHeaders` honors `header_order` (five captured headers replayed in exact order with extras tail-appended, user-agent still overridden to template version), `rewriteHeaders` no-op path keeps old behavior when `header_order` is absent, `checkVersionDrift` handles null / mismatched-UA / no-cc-UA / missing-template edge cases without throwing.

Total test footprint: ~376 assertions across 12 files. Full `npm test` green.

### Why this release

v3.13.0 is about **fighting back against fingerprinting — at every layer at once.** Session stickiness is the economic layer: it makes pool mode actually cache-cheap for long agent sessions, where dario's bill is dominated by cache-reused tokens. Sealed-sender is the social layer: it makes group-pooling models possible without one member having to trust every other member's honesty about borrow telemetry. Header-order capture is the transport layer: it removes one of the easier fingerprint vectors from every outbound replay path the shim sees. Shim hardening is the stealth layer: it makes the one transport Anthropic can't detect from outside their own process robust enough to carry a session through CC upgrades and body-shape drift. Stickiness and header_order feed directly into shim hardening — option 2 (hide in the population) handing captured shape to option 1 (in-process replay) is where the layers physically connect in `rewriteHeaders`.

Proxy-mode replay of `header_order` is deferred to v3.13.x — the shim is the higher-leverage target today because it's the transport that most directly exposes header order to Anthropic's fetch layer, but the same `template.header_order` field is already loaded into the proxy's template replay path and will pick up automatically when the proxy's outbound header builder is extended.

---

## [3.12.1] - 2026-04-15

### Fixed

- **`src/cc-template.ts`** — tool dispatcher regression (#37 Glob half, also #36). When a client declared an unmapped tool that round-robin'd onto a CC fallback tool Anthropic also emits directly (Glob in the OpenClaw `image` / `memory_get` repros), the reverse lookup routed real upstream tool_use blocks back to the unmapped client tool with the wrong input shape — which then failed the client's own input validation (`{"tool":"image","error":"image required"}`) and could trigger a runaway loop if the client retried. Unmapped-fallback mappings now carry `reverseScore: 0`, and `buildReverseLookup` skips any mapping with score 0 entirely. If no legitimate mapping claims a CC tool, the upstream tool_use passes through unchanged — the client sees an honest unhandled-tool case instead of a corrupted-shape masquerade.

  Bash-half fix from v3.10.3 (process/exec collision on Bash) is unchanged and still covered; the new logic generalizes the same "unmapped fallback must lose reverse collisions" principle to every CC fallback slot, not just Bash.

- **`test/hybrid-tools.mjs`** — 4 new assertions covering the Glob-half repro directly (unmapped `image` round-robin'd onto Glob, real Glob tool_use passes through with name preserved and input intact) plus a legitimate-mapping-wins case (`find_files` + `image` sharing Glob's slot, legitimate mapping claims the reverse path).

### Why this release

@tetsuco's #37 and `boeingchoco`'s #36 both reported the same OpenClaw symptom: Bash tool calls returning "Unknown action" and Glob tool calls misrouting to `memory_get` / `image` with validation errors. v3.10.3's `reverseScore: 1` on `process` closed the Bash half. The Glob half stayed open because the pre-fix round-robin fallback didn't distinguish forward-only distribution from reverse-path claiming — both used the same `ToolMapping` shape and both competed for the reverse slot at the same score. v3.12.1 draws that line explicitly.

---

## [3.12.0] - 2026-04-15

### Added — Shim mode (experimental, opt-in)

A second transport for routing CC traffic through dario, alongside the existing proxy. Where proxy mode runs an HTTP server and asks CC to talk to it via `ANTHROPIC_BASE_URL`, **shim mode** injects a `--require` CommonJS payload into a CC child process via `NODE_OPTIONS`, monkey-patches `globalThis.fetch` inside that process, and rewrites outbound `/v1/messages` calls in-place. CC keeps its own OAuth, its own retry/streaming machinery, its own TLS — dario only intercepts the request body (template replay) and the response headers (billing attribution).

The point: detection cost. Anthropic can fingerprint a proxy via TLS, headers, IP, or `BASE_URL` env. They can't easily detect a fetch monkey-patch from inside their own process without shipping signed-binary integrity checks against `globalThis`, and even then the shim runs *before* CC code loads, so it could patch the integrity check too. This is "get ahead of Anthropic" part 2 — part 1 was live fingerprint extraction in v3.11.0.

**Why it's not the new default.** dario's value prop is "one endpoint, every provider, your tools don't need to change," and that requires an HTTP boundary so the same dario can serve CC + OpenClaw + Hermes + raw curl simultaneously, share an OAuth pool across all of them, do failover, and expose `/analytics` to a dashboard. Shim mode only intercepts the one specific child you spawn; it can't multiplex clients, can't share pool state across separate child processes, and is Node-only — if Anthropic ships CC as a Bun or single-binary build, shim mode is dead and proxy mode is the only path. **Proxy stays the router; shim is the stealth escape hatch.** Pick shim when (a) you're only running CC, (b) you suspect Anthropic is fingerprinting your proxy traffic, (c) you accept the Node-only constraint.

#### What's in this release

- **`src/shim/runtime.cjs`** — hand-written CommonJS payload, ~180 lines. Loaded into the child via `NODE_OPTIONS=--require=...`. Exports nothing user-facing; activated by `DARIO_SHIM=1` (so it's a no-op if dario installs it globally and the child isn't a CC invocation). Patches `globalThis.fetch`, gates on POST + `*.anthropic.com/v1/messages`, replaces `body.system[1]` and `body.system[2]` with the live-fingerprint template's agent identity and system prompt, replaces `body.tools` from the template, and sets fingerprint headers (`user-agent: claude-cli/X.Y.Z (external, cli)`, `x-anthropic-billing-header`, `anthropic-beta`). Failsafe: any internal error falls through to the original fetch — the shim cannot break the host process.
- **`src/shim/host.ts`** — dario-side spawn host. Stands up a unix domain socket (or named pipe on Windows), spawns the user's command with the shim require'd in via `NODE_OPTIONS`, listens for newline-delimited JSON billing relay events from the runtime, and feeds them into the existing `Analytics` class so they show up in `/analytics`-style summaries (request counts and claim distribution; token costs are not recorded by the shim transport because that would require parsing SSE bodies in the child, which is the kind of cost-and-complexity we explicitly chose to avoid).
- **`src/cli.ts`** — new `dario shim [-v] -- <command> [args...]` subcommand. Pass-through stdio, propagates the child's exit code, optional verbose log of relay events at the end. Example: `dario shim -- claude --print -p "hi"`.
- **`src/shim/runtime.cjs` is copied into `dist/shim/`** by the build script (alongside the existing `cc-template-data.json` copy). The host module's `locateShimRuntime()` checks both `dist/shim/runtime.cjs` (production) and `src/shim/runtime.cjs` (dev under tsx).
- **`test/shim-runtime.mjs`** — 26 unit assertions covering the URL gate (literal `anthropic.com` host, suffix-attack rejection, localhost passthrough), the method gate (POST-only), the body rewriter (billing tag preserved, agent identity replaced, system prompt replaced, cache control preserved, tools replaced, messages untouched, model untouched, null on garbage), and the header rewriter (user-agent, billing header, anthropic-beta, existing headers preserved).
- **`test/shim-e2e.mjs`** — 15 cross-process assertions. Spawns a real `node -e` child with the shim CJS require'd in, hits a local HTTP server pretending to be `api.anthropic.com`, and verifies on the wire that the body was rewritten (billing tag preserved, identity/prompt/tools replaced) and that the header rewrite landed (`user-agent: claude-cli/9.9.9-e2e (external, cli)`). Also covers the relay socket transport: child writes a newline-delimited JSON event to the unix socket, host parses it, billing claim is round-tripped end-to-end.

Total test footprint: 241 assertions across 10 files (was 200 across 8). Full `npm test` green.

#### Deferred to v3.12.x / v3.13

- Auto-detect Bun in the child and refuse with a clear error (Bun's `--require` semantics differ; needs verification before claiming support).
- `dario shim --replace claude` global wrapper install (drop a `claude` shim into PATH that re-execs into `dario shim -- /path/to/real/claude`).
- Token cost recording (would require the runtime to parse SSE bodies in-flight; intentionally not in v3.12.0).
- Windows named-pipe coverage in CI (host code paths exist; CI matrix doesn't currently exercise them).
- README section and `--help` example walkthrough.

---

## [3.11.1] - 2026-04-15

### Added — Billing bucket visibility (#34)

- **`src/analytics.ts`** — new `BillingBucket` type and `billingBucketFromClaim()` pure helper that maps the raw `anthropic-ratelimit-unified-representative-claim` header value (`five_hour`, `five_hour_fallback`, `overage`, `api`) to a user-friendly bucket (`subscription`, `subscription_fallback`, `extra_usage`, `api`, `unknown`). `Analytics.computeStats()` now produces `billingBucketBreakdown` (per-bucket counts) and `subscriptionPercent` (share of *classified* requests that hit a subscription bucket — the headline "is dario actually routing me through my subscription?" number) on every `/analytics` summary.
- **`src/proxy.ts`** — the per-request billing log line now leads with the friendly bucket: `billing: subscription (five_hour, overage: 0%)` instead of forcing users to memorize that `five_hour` means subscription. The raw claim is still shown in parentheses for parity with the underlying header.
- **`test/analytics-billing-bucket.mjs`** — 23 assertions covering pure derivation across every enum value (including `null`/`undefined`/garbage → `unknown`), mixed-bucket aggregation (8 subscription + 1 extra_usage + 1 unknown → `subscriptionPercent ≈ 88.89%`), the clean 100% case, the @mikelovatt silent-drain scenario from #34 (10 `overage` requests → `subscriptionPercent === 0`, the alarm), and empty-state divide-by-zero safety.

### Why this release

Closes #34. The original #31 work added the raw `claim` header to logs and analytics, but users still had to know that `five_hour` = subscription and `overage` = paying out of pocket. @mikelovatt's complaint was that dario *appeared* to be routing through his subscription while extra_usage was silently burning his real balance — `subscriptionPercent < 100%` is now a one-glance answer to that question, surfaced in `/analytics` and in the per-request log line.

---

## [3.11.0] - 2026-04-15

### Added — Live fingerprint extraction

- **`src/live-fingerprint.ts`** — new module. At dario proxy startup, spawns the user's own `claude` binary against a loopback MITM endpoint, captures its outbound `/v1/messages` request, and extracts the live agent identity, system prompt, tool definitions, and CC version from the captured body. Writes the result to `~/.dario/cc-template.live.json` with a 24h TTL. Template replay reads the live cache at module init, falling back to the bundled `cc-template-data.json` snapshot only when the live cache is absent.

  This eliminates the "Anthropic ships a new CC, dario is stale for 48 hours" window. Every dario install with CC available self-heals to the current CC fingerprint on next startup. No user action, no flag, no opt-in — it runs in the background on every `dario proxy` launch and never blocks startup. Users without CC installed see the exact same behavior as before.

  The capture uses a single loopback HTTP server on a random high port, returns a minimal-valid SSE stream so CC completes cleanly, kills the child on capture, and writes the result atomically. Hard-timeout is 10 seconds; failures log a one-line warning and fall through to the bundled snapshot. Security boundary: the MITM only accepts 127.0.0.1, only lives for one request, and the child is killed immediately after the body is read. CC's OAuth token never leaves the machine — we hand CC a URL it already trusts because we set `ANTHROPIC_BASE_URL` in its environment.

- **`test/live-fingerprint.mjs`** — 20 assertions covering: happy-path extraction from a synthetic CC-shaped request, version parsing from `x-anthropic-billing-header`, user-agent fallback when the billing header is absent, null-return on malformed bodies (missing system, short system, empty tools), live cache preference over bundled, and bundled fallback when no cache exists.

### Changed

- **`src/cc-template.ts`** — template loading delegates to `loadTemplate()` from `live-fingerprint.ts` instead of reading `cc-template-data.json` directly. The bundled snapshot is still shipped and still loaded when no live cache exists — behavior is a strict superset of pre-v3.11.
- **`src/proxy.ts`** — on `startProxy()`, kicks off `refreshLiveFingerprintAsync()` in the background right before `server.listen()`. Fire-and-forget; errors are swallowed. The refresh result is written to cache for the **next** dario startup, so the first run after this upgrade still uses the bundled snapshot and every subsequent run uses live data.

### Why this release

Fingerprint maintenance has been a manual treadmill: every CC release could in principle shift the agent identity, tool schemas, or the system prompt, and until we updated `cc-template-data.json` any new user would be running a stale template. Live capture makes the treadmill self-service — each user's dario pulls the fingerprint from their own CC install at startup, so template replay is always in sync with whatever CC version is actually installed locally, without any dependency on us shipping updates.

This is part 1 of a two-part "get ahead of Anthropic" plan. Part 2 (shim-mode, NODE_OPTIONS injection into a live CC process, discussed in the architecture notes) is not in this release — it's a larger change and will land as v3.12 opt-in.

---

## [3.10.3] - 2026-04-15

### Fixed

- **`billing: five_hour (overage: ?)` log spam** (`src/proxy.ts`, follow-up to #37). Anthropic omits the `anthropic-ratelimit-unified-overage-utilization` header when the subscription claim fully covered the request and no overage bucket was consumed. Pre-fix, dario treated the missing header as an unparseable value and printed `?`, which looked like a broken parser even though routing was working correctly — every request in @tetsuco's #37 log dump showed `overage: ?` despite the `five_hour` claim being correct.

  Fix: when the overage header is absent and the claim is `five_hour` (or `five_hour_fallback`), display `0%` instead of `?` — the subscription covered the request, so overage consumption is zero by definition. If headers are missing entirely (non-200 responses, server errors), verbose mode now logs `billing: headers absent (status=N)` so the gap in the request numbering is explained instead of silent.

---

## [3.10.2] - 2026-04-15

### Fixed

- **Runaway request loop on OpenClaw / framework clients that preserve trailing assistant turns** (`src/cc-template.ts`, #37). v3.10.1's trailing-turn-drop fix was too aggressive: it popped **any** trailing assistant message, not only empty ones. When an agent framework locally appended its model's reply to conversation state and asked the model to continue, dario stripped the assistant turn from the next upstream request. The model never saw its prior reply, regenerated essentially the same response, dario stripped that, and the loop never terminated. @tetsuco reproduced with a single "check Bash/Glob availability" prompt that resulted in 133 POSTs to `/v1/messages` before hitting rate limits and 500s — billing classification held (`five_hour` on every request), so this was purely a loop, not a reclassification.

  Fix: narrow the post-condition pass to drop **only** trailing messages with empty content (`content: []`), which is what the thinking-strip actually produces for a thinking-only turn. Trailing assistant messages with real text or tool_use content are left intact. The original #36 prefill-rejection case is still covered because the failing shape was specifically `content: []` after the strip.

### Changed

- **`test/hybrid-tools.mjs`** — the v3.10.1 regression case that asserted "trailing assistant with real content is dropped" is inverted to "trailing assistant with real content is preserved", and tagged as #37 to match the regression it now guards against. The thinking-only-drop case and the well-formed-conversation-untouched case are unchanged.

---

## [3.10.1] - 2026-04-15

### Fixed

- **`LLM request rejected: This model does not support assistant message prefill. The conversation must end with a user message.`** (`src/cc-template.ts`, #36). Clients that preserve `thinking` blocks in conversation history (OpenClaw, Hermes) would intermittently hit this error on Opus 4.6 under adaptive thinking + the `claude-code-20250219` beta. Root cause: an interrupted prior turn whose assistant content was thinking-only would be emptied to `content: []` by dario's thinking-strip, then forwarded with the envelope still in place. Anthropic's server interprets a trailing assistant message as a prefill request, and the model/beta combination rejects prefill outright.

  Fix: after the thinking-strip loop, a post-condition pass drops any trailing message that is empty-after-scrub or still has `role: "assistant"`. The client's original shape is not mutated beyond what was already going to be scrubbed, and a well-formed conversation ending on a `tool_result` (user role) is untouched. Credit to @boeingchoco for the reproduction.

### Added

- **`test/hybrid-tools.mjs`** — three regression cases for the trailing-turn fix: thinking-only assistant turn dropped, real-content trailing assistant dropped, well-formed tool-loop conversation untouched.

---

## [3.10.0] - 2026-04-14

Repositioning + new routing primitive. No bug fixes, no breaking changes.

### Added

- **Provider prefix in `model` field** (`src/proxy.ts`). Requests can now use `<provider>:<model>` in the `model` field to force backend routing regardless of model-name regex. Recognized prefixes: `openai:`, `groq:`, `openrouter:`, `local:`, `compat:`, `claude:`, `anthropic:`. The prefix is stripped before the request goes upstream — the backend sees the bare model name.

  Example: `openai:gpt-4o` forces the OpenAI-compat backend; `openrouter:meta-llama/llama-3.1-70b` routes a non-GPT model through the OpenAI-compat backend without modifying the default regex; `claude:opus` explicitly forces the Claude subscription backend.

  Ollama-style names like `llama3:8b` (colon used for tag, not provider prefix) pass through untouched — only recognized prefixes are parsed.

- **`--model` accepts provider prefix** (`src/cli.ts`, `src/proxy.ts`). `dario proxy --model=openai:gpt-4o` applies the prefix to every request server-wide. Useful for one-flag routing override without editing every tool's config. Back-compat: `--model=opus` and full Claude IDs still work as before.

- **`test/provider-prefix.mjs`** — 16 assertions covering prefix detection, stripping, ollama compat, edge cases (empty, uppercase, unknown providers), and path-containing model names (`openrouter:meta-llama/llama-3.1-70b`).

### Changed

- **README repositioned as multi-backend gateway.** The framing shift: dario is a local endpoint your tools point at; backends are swappable adapters behind it. Claude subscription remains the most sophisticated backend (template replay, fingerprint, pool mode), but is now presented as one of several, not the headline identity. Bullet order in "What it is" now leads with OpenAI / OpenAI-compat and places the subscription backend third. "Who this is for" gains a provider-independence audience. "Why switch" gains a provider-independence paragraph. The durable proposition — "your tools point at one URL, backends swap underneath, nothing in your tools changes" — is now the top-line pitch.

### Why this release

A response to the obvious trajectory: Anthropic will keep tightening subscription-shaped routing, and every tightening becomes a dario issue. Provider prefix + gateway framing is the first step toward making dario useful even in a future where the Claude subscription backend degrades. Users with an OpenAI key, a Groq key, a local LiteLLM, or any other OpenAI-compat endpoint get one stable local URL and can route between them with a model-name change. Claude subscription remains fully supported and will continue to get bug fixes — it's just no longer the sole story.

---

## [3.9.6] - 2026-04-14

Fixes [#37](https://github.com/askalf/dario/issues/37) reported by [@tetsuco](https://github.com/tetsuco) on v3.9.3. The `Read`-on-directory symptom from #35 was fixed in v3.9.3, but two related symptoms (`Bash → Unknown action`, `Glob → image handler misroute`) remained under OpenClaw. v3.9.5 resolved the Glob misroute (hybrid mode now drops unmapped tools like `image`). This release resolves the Bash collision.

### Fixed

- **`buildReverseLookup` now resolves ccTool collisions by `reverseScore`** (`src/cc-template.ts`). When multiple client tools map to the same CC tool, the pre-fix two-pass reverse lookup used insertion-order last-wins. OpenClaw declares BOTH `exec` (bash-family, wants `{command}`) AND `process` (action-discriminator, wants `{action}`) as sibling tools — both exported from [`src/agents/bash-tools.ts:8-10`](https://github.com/openclaw/openclaw/blob/main/src/agents/bash-tools.ts) and registered together in the default agent tool set. Both map to CC's `Bash`. Depending on the order OpenClaw emitted them in the request, `process` could win the reverse slot, and every subsequent CC `Bash` tool call came back rewritten to `{action: "<command string>"}` — OpenClaw's process handler saw the command as an action name and threw `Unknown action pwd` / `Unknown action ls` / etc. for every shell call.

  Fix: `ToolMapping` now carries an optional `reverseScore` (default 10). The non-identity pass of `buildReverseLookup` picks the highest-scoring mapping per ccTool instead of last-wins. `process` has `reverseScore: 1` so when it collides with `exec`/`bash`/`shell`/`run`/`command`/`terminal` (all default score 10), the bash-family mapping always wins and CC's Bash tool calls round-trip correctly as `{command: "..."}`.

  Score wins over insertion order in either direction — test covers both orderings of `[exec, process]` and `[process, exec]` to pin this.

### Added

- **5 new collision-resolution tests** in `test/hybrid-tools.mjs`. Declares both `exec` and `process`, emits a CC `Bash` tool_use, asserts the reverse path routes to `exec` and the input carries `command` (not `action`). Both declaration orders tested. Suite total: 38 pass / 0 fail.

## [3.9.5] - 2026-04-14

Second fix for [#36](https://github.com/askalf/dario/issues/36). v3.9.4 fixed the `context-1m` retry loop; this release tackles the hybrid-tool reverse-mapping issues in the same report after pulling OpenClaw's source and reading their actual tool definitions. Two real bugs, one honest design admission.

### Fixed

- **`bash`-family `translateBack` now emits `command`, not `cmd`** (`src/cc-template.ts`). The `bash`, `exec`, `shell`, `run`, `command`, and `terminal` entries in TOOL_MAP were all emitting `{cmd: <CC command>}` on the reverse path. But every real client using one of those tool names — Anthropic's own standard `bash` convention, OpenClaw's `exec` (verified against [apps/shared/.../bash-tools.exec.ts:1340](https://github.com/openclaw/openclaw/blob/main/src/agents/bash-tools.exec.ts) where the handler does `params.command` and throws "Provide a command to start." on missing field) — declares `command` on its schema, not `cmd`. The translation was writing into a field nobody had declared. Changed to emit `{command: ...}` across all six bash-family aliases. `process` still emits `{action}` (OpenClaw's `process` session-manager tool actually wants `action` as the discriminator, verified against `bash-tools.process.ts:127`).

- **Hybrid mode now drops unmapped tools instead of round-robin'ing them onto CC fallbacks** (`src/cc-template.ts`). OpenClaw declares ~50 custom tools (`lobster`, `memory_get`, `memory_search`, `feishu_*`, `discord_*`, ...), none of which are in dario's TOOL_MAP. Pre-fix, the unmapped-tool distributor assigned them round-robin onto `[Bash, Read, Grep, Glob, WebSearch, WebFetch]`. Forward direction: the model saw CC's tool set and called `Grep` with a pattern. Reverse direction: dario renamed `Grep` → `lobster` and handed OpenClaw `{pattern: "..."}` on a tool whose handler expected `{action: "run"|"resume"}` and threw `Unknown action: undefined`. "Glob misrouted to memory_get" was the same mechanism: round-robin collision plus no reverse-shape fidelity.

  The hybrid-mode contract can't support this — adding custom tools alongside CC's set would break the fingerprint that makes hybrid mode worth using in the first place. Honest fix: in hybrid mode, drop unmapped tools at request build time. The model upstream never sees them, never calls them, never corrupts anything. `buildCCRequest` still reports them in the returned `unmappedTools` array so the caller (and future verbose logging) can surface which tools were dropped. **Default mode is unchanged** — round-robin fallback still applies there so existing simple clients don't regress.

### Known limitation (now documented in code)

- **`process`-style action-discriminator tools are fundamentally lossy under any TOOL_MAP translation.** OpenClaw's `process` tool takes `{action: "list"|"poll"|"log"|..., sessionId?, data?, keys?, hex?, literal?, text?, bracketed?, eof?, offset?, limit?, timeout?}`. Flattening the action onto `Bash.command` loses every sibling field, so the model upstream can only ever drive a subset of the tool's functionality. The TOOL_MAP.process entry is still present so the fingerprint check stays green and `process.action` still round-trips correctly for the one field it maps, but a comment now warns that clients with rich discriminator tools should use `--preserve-tools` rather than rely on hybrid mode to do the impossible.

### Added

- **12 new hybrid-tools test assertions** (`test/hybrid-tools.mjs`): exec/bash reverse translation produces `command`, no stale `cmd` field leaks through, hybrid mode drops lobster + memory_get from activeToolMap, default mode still round-robins them (regression guard). Suite total: 33 pass / 0 fail.

### Methodology note

v3.9.4 asked @boeingchoco for OpenClaw's tool schema to diagnose the remaining #36 issues. The user (correctly) pointed out that OpenClaw is open-source on GitHub and the schemas are one `git clone` away. Cloned `openclaw/openclaw` main, grepped for the relevant tool definitions, and the three bugs above were visible within ten minutes. Should not have outsourced that lookup.

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
