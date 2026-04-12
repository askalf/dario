# Changelog

All notable changes to this project will be documented in this file.

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
