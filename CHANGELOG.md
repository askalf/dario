# Changelog

All notable changes to this project will be documented in this file.

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
