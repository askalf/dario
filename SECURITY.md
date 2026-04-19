# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 3.x     | Yes       |
| 2.x     | No        |
| 1.x     | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in dario, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. Email **security@askalf.org** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
3. **Response SLA:** Acknowledgment within 48 hours, fix within 7 days for critical issues.
4. We will coordinate disclosure with you before publishing a fix.

## Scope

The following are in scope for security reports:

- Token leakage (Claude OAuth access/refresh tokens, OpenAI-compat backend API keys, or any other stored credential exposed in logs, errors, or network responses)
- Credential file permission issues across `~/.dario/credentials.json`, `~/.dario/accounts/<alias>.json` (pool mode), and `~/.dario/backends/<name>.json` (OpenAI-compat backends)
- Proxy authentication bypass (`DARIO_API_KEY`)
- Proxy path traversal (accessing non-allowlisted paths)
- OpenAI-compat translation / routing exploits (injection via model names, system prompts, or backend `baseUrl` construction)
- Multi-account pool routing exploits (cross-account token leakage, rate-limit headroom poisoning)
- SSE streaming payload parse / framing exploits in the reverse-mapper
- Man-in-the-middle vulnerabilities
- Denial of service via the proxy

## Security Architecture

### Proxy Authentication
- Optional `DARIO_API_KEY` env var gates all endpoints except `/health`.
- Timing-safe comparison via `crypto.timingSafeEqual` with pre-encoded key buffer.
- Supports both `x-api-key` header and `Authorization: Bearer` header.

### Credential Storage
- **Single-account Claude backend**: reads from Claude Code (`~/.claude/.credentials.json`) or its own store (`~/.dario/credentials.json`). On macOS with modern Claude Code (v3.7.0+), also reads from the OS keychain via `security find-generic-password -s "Claude Code-credentials"`.
- **Multi-account pool mode (v3.5.0+)**: per-account credentials at `~/.dario/accounts/<alias>.json`, one file per Claude subscription. Each account has its own independent OAuth refresh lifecycle.
- **OpenAI-compat backends (v3.6.0+)**: API keys stored at `~/.dario/backends/<name>.json`. Supports OpenAI, OpenRouter, Groq, local LiteLLM, and any OpenAI-compat endpoint via configurable `baseUrl`.
- All dario-managed credential files stored with `0600` permissions (owner-only).
- Atomic file writes (temp + rename) prevent corruption.
- No credentials are logged or included in error messages. `dario backend list` redacts API keys as `***` (v3.7.2+); no substring of a key is ever emitted.

### OAuth Flow
- Standard PKCE (Proof Key for Code Exchange) — no client secret.
- Code verifier never leaves the local process.
- State parameter prevents CSRF.
- Auto flow: local callback server on random port captures authorization code.

### OAuth Config Auto-Detection (v3.4.3+)
- Reads the local Claude Code binary (`~/.local/bin/claude.exe`, `~/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js`, etc.) in read-only mode to extract OAuth `client_id`, authorize URL, token URL, and scopes.
- Never modifies, executes, or transmits the binary.
- Anchors on `BASE_API_URL:"https://api.anthropic.com"` — a literal that only appears inside CC's prod OAuth config block — then extracts `CLIENT_ID`, `CLAUDE_AI_AUTHORIZE_URL`, `TOKEN_URL`, and the full scope list from the surrounding object. A defensive check rejects any scan result matching a known-dead internal `client_id` (see the v3.4.3 CHANGELOG entry for the history).
- Cached at `~/.dario/cc-oauth-cache-v4.json` keyed by binary fingerprint (sha256 of first 64KB + size + mtime); cache file contains no secrets. Cache version bumped to `-v4` in v3.19.4 when Anthropic's authorize endpoint stopped accepting `org:create_api_key` for the CC client_id — prior caches are invalidated automatically on upgrade.
- Falls back to hardcoded known-good Claude Code 2.1.104 prod config values if no binary is found or scanning fails — dario remains functional.
- Optional operator-supplied overrides may be provided via `DARIO_OAUTH_CLIENT_ID`, `DARIO_OAUTH_AUTHORIZE_URL`, `DARIO_OAUTH_TOKEN_URL`, `DARIO_OAUTH_SCOPES`, or `~/.dario/oauth-config.override.json`. These override files contain public OAuth metadata only, not bearer tokens or API secrets.

### Proxy Security
- **Binds to `127.0.0.1` by default** — loopback-only and unreachable from other machines.
- `--host` / `DARIO_HOST` (v3.4.3+) can bind to a specific non-loopback interface for deliberate mesh/LAN use (e.g. a Tailscale interface, a LAN address). **When bound to anything non-loopback, `DARIO_API_KEY` is required** — dario prints a warning at startup and operators who ignore it and run `--host=0.0.0.0` without a key are explicitly exposing their OAuth session to anything that can reach the port.
- Hardcoded **upstream-proxy path allowlist**: `/v1/messages`, `/v1/complete` (Anthropic format), and `/v1/chat/completions` (OpenAI-compat format, routed by model name to either the Claude backend or the configured OpenAI-compat backend). These are the only paths that forward requests upstream.
- Local-only endpoints (no upstream forwarding): `/health`, `/status`, `/v1/models`, `/accounts` (pool mode only), `/analytics` (pool mode only).
- All other paths return 403.
- Only `GET` and `POST` methods allowed.
- 10 MB request body size limit.
- 30-second request body read timeout (prevents slow-loris).
- 5-minute upstream timeout, with client-disconnect abort wired to the same `AbortController` so cancelled client connections don't keep burning upstream tokens (v3.4.4+).
- Model names validated (alphanumeric, hyphens, dots, underscores only).
- SSE stream buffer capped at 1MB to prevent OOM.
- SSE event-group framing on reverse-mapped tool_use blocks verified by regression test (v3.7.1+) — streaming mapper emits well-formed multi-event output that parses cleanly in standard SSE parsers including the Anthropic SDK's.
- CORS scoped to the configured proxy port (`http://localhost:{port}` by default; overridable via `DARIO_CORS_ORIGIN` for mesh use).
- SSRF protection: hardcoded allowlist for the Claude backend upstream (`api.anthropic.com`); OpenAI-compat backend target is a per-backend `baseUrl` configured by the operator via `dario backend add <name> --base-url=<url>` and stored in `~/.dario/backends/<name>.json` — no user-request input participates in URL construction for either backend.
- Security headers on all responses: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`.
- OpenAI-compat backend 502 error bodies **do not include `Error.message`** (v3.7.2+) — detail logs server-side via `console.error` when `--verbose`; clients receive only `{error, backend}`. Prevents Node.js error messages from leaking internal paths, module names, DNS resolver state, or upstream hostnames via error responses.

### Error Sanitization
- API keys (`sk-ant-*`) redacted from all error messages.
- JWT tokens (`eyJ...`) redacted from all error messages.
- Bearer token values redacted from all error messages.
- `dario backend list` never emits any substring of a stored API key — displays `***` only (v3.7.2+).
- Upstream 502 bodies from the OpenAI-compat backend do not include `Error.message` (v3.7.2+); see Proxy Security above.

### Network
- Claude backend upstream traffic goes to `api.anthropic.com` over HTTPS/TLS only.
- Claude OAuth token traffic is sent only to `api.anthropic.com` and `platform.claude.com`.
- OpenAI-compat backend traffic goes to whatever `baseUrl` the operator configured for that backend (typically `api.openai.com`, `api.groq.com`, `openrouter.ai/api/v1`, or a local LiteLLM / vLLM / Ollama endpoint). **The operator is the trust anchor for that URL** — dario does no domain reputation or cert pinning beyond standard Node.js HTTPS verification.
- No telemetry, analytics, or external data collection.
