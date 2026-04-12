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

- Token leakage (OAuth access/refresh tokens exposed in logs, errors, or network)
- Credential file permission issues
- Proxy authentication bypass (`DARIO_API_KEY`)
- Proxy path traversal (accessing non-allowlisted paths)
- OpenAI-to-Anthropic translation exploits
- CLI backend injection via model names or system prompts
- Man-in-the-middle vulnerabilities
- Denial of service via the proxy

## Security Architecture

### Proxy Authentication
- Optional `DARIO_API_KEY` env var gates all endpoints except `/health`
- Timing-safe comparison via `crypto.timingSafeEqual` with pre-encoded key buffer
- Supports both `x-api-key` header and `Authorization: Bearer` header

### Credential Storage
- Reads from Claude Code (`~/.claude/.credentials.json`) or its own store (`~/.dario/credentials.json`)
- Own credentials stored with `0600` permissions (owner-only)
- Atomic file writes (temp + rename) prevent corruption
- No credentials are logged or included in error messages

### OAuth Flow
- Standard PKCE (Proof Key for Code Exchange) — no client secret
- Code verifier never leaves the local process
- State parameter prevents CSRF
- Auto flow: local callback server on random port captures authorization code

### OAuth Config Auto-Detection (v3.4+)
- Reads the local Claude Code binary (`~/.local/bin/claude.exe`, `~/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js`, etc.) in read-only mode to extract OAuth `client_id`, authorize URL, token URL, and scopes
- Never modifies, executes, or transmits the binary
- Anchors on stable string markers (`OAUTH_FILE_SUFFIX:"-local-oauth"`, `CLAUDE_AI_AUTHORIZE_URL`, `TOKEN_URL`) to extract config from the local-callback flow specifically (not the platform-hosted flow)
- Cached at `~/.dario/cc-oauth-cache.json` keyed by binary fingerprint (sha256 of first 64KB + size + mtime); cache file contains no secrets
- Falls back to known-good v2.1.104 hardcoded values if no binary is found or scanning fails — dario remains functional

### Proxy Security
- Binds to `127.0.0.1` only — not accessible from other machines
- Hardcoded API path allowlist (`/v1/messages`, `/v1/complete`, `/v1/chat/completions`) — all other paths return 403
- Only `GET` and `POST` methods allowed
- 10 MB request body size limit
- 30-second request body read timeout (prevents slow-loris)
- 5-minute upstream timeout
- Model names validated (alphanumeric, hyphens, dots, underscores only)
- SSE stream buffer capped at 1MB to prevent OOM
- CLI output capped at 5MB per stream to prevent OOM
- CORS scoped to actual proxy port (`http://localhost:{port}`)
- SSRF protection: hardcoded allowlist — no user input in URL construction
- Security headers on all responses: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`

### Error Sanitization
- API keys (`sk-ant-*`) redacted from all error messages
- JWT tokens (`eyJ...`) redacted from all error messages
- Bearer token values redacted from all error messages
- CLI stderr sanitized before forwarding to clients

### CLI Backend (`--cli` mode)
- Routes through locally installed Claude Code binary
- Uses `spawn()` with array args (no shell interpretation)
- System prompts written to temp file with `0600` permissions, cleaned up after use (avoids OS arg size limit)

### Network
- All upstream traffic goes to `api.anthropic.com` over HTTPS/TLS
- OAuth tokens are only sent to `api.anthropic.com` and `platform.claude.com`
- No telemetry, analytics, or external data collection
