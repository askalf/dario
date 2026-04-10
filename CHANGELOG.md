# Changelog

All notable changes to this project will be documented in this file.

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
- Credit: @GodsBoy (cherry-picked from PR #2)

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
