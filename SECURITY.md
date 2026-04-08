# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in dario, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. Email **security@askalf.org** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
3. You will receive a response within 48 hours.

## Scope

The following are in scope for security reports:

- Token leakage (OAuth access/refresh tokens exposed in logs, errors, or network)
- Credential file permission issues
- Proxy bypasses (accessing non-API paths)
- Authentication bypass
- Man-in-the-middle vulnerabilities
- Denial of service via the proxy

## Security Architecture

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
- Redirect URIs: `http://localhost:{port}/callback` (auto) or `platform.claude.com/oauth/code/callback` (manual fallback)

### Proxy Security
- Binds to `127.0.0.1` only — not accessible from other machines
- Hardcoded allowlist of API paths (`/v1/messages`, `/v1/models`, `/v1/complete`) — all other paths return 403
- Only `GET` and `POST` methods are allowed
- 10 MB request body size limit
- 5-minute upstream timeout prevents hanging connections
- Token patterns (`sk-ant-*`) are redacted from all error messages and tool output
- CORS restricted to `http://localhost`
- SSRF protection: hardcoded API path allowlist — no user input used in URL construction

### CLI Backend (`--cli` mode)
- Routes through locally installed Claude Code binary
- No direct network access — all requests go through Claude Code's internal pipeline
- System prompts and conversation history passed via CLI arguments (no temp files)

### Network
- All upstream traffic goes to `api.anthropic.com` over HTTPS/TLS
- OAuth tokens are only sent to `api.anthropic.com` and `platform.claude.com`
- No telemetry, analytics, or external data collection
