<p align="center">
  <h1 align="center">dario</h1>
  <p align="center"><strong>Use your Claude subscription as an API.</strong></p>
  <p align="center">
    Two commands. No API key. Your Claude Max/Pro subscription becomes a local API endpoint<br/>that any tool, SDK, or framework can use.
  </p>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#how-it-works">How It Works</a> &bull;
  <a href="#usage-examples">Examples</a> &bull;
  <a href="#cli-backend">CLI Backend</a> &bull;
  <a href="#faq">FAQ</a>
</p>

---

```bash
npx @askalf/dario login   # authenticate with Claude
npx @askalf/dario proxy   # start local API on :3456

# now use it from anywhere
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
```

That's it. Any tool that speaks the Anthropic API now uses your subscription.

---

## The Problem

You pay $100-200/mo for Claude Max or Pro. But that subscription only works on claude.ai and Claude Code. If you want to use Claude with **any other tool** — OpenClaw, Cursor, Continue, Aider, your own scripts — you need a separate API key with separate billing.

**Note:** Claude subscriptions have undocumented weekly usage limits. When exceeded, Opus and Sonnet may return 429 errors while Haiku continues working. Use `--cli` mode to route through Claude Code's binary, which is not affected by these limits.

**dario fixes this.** It creates a local proxy that translates API key auth into your subscription's OAuth tokens — and with `--cli` mode, routes through the Claude Code binary for uninterrupted access.

## Quick Start

### Install

```bash
npm install -g @askalf/dario
```

Or use npx (no install needed):

```bash
npx @askalf/dario login
npx @askalf/dario proxy
```

### Login

```bash
dario login
```

Opens your browser to Claude's OAuth page. Log in, authorize, paste the redirect URL back. Takes 10 seconds.

### Start the proxy

```bash
dario proxy
```

```
dario — http://localhost:3456

Your Claude subscription is now an API.

Usage:
  ANTHROPIC_BASE_URL=http://localhost:3456
  ANTHROPIC_API_KEY=dario

OAuth: healthy (expires in 11h 42m)
Model: passthrough (client decides)
```

### Use it

```bash
# Set these two env vars — every Anthropic SDK respects them
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario

# Now any tool just works
openclaw start
aider --model claude-opus-4-6
continue  # in VS Code, set base URL in config
python my_script.py
```

## CLI Backend

If you're getting rate limited on Opus or Sonnet, use `--cli` mode. This routes requests through the Claude Code binary instead of hitting the API directly — and Claude Code has priority routing that bypasses subscription rate limits.

```bash
dario proxy --cli                    # Opus works even when rate limited
dario proxy --cli --model=opus       # Force Opus + CLI backend
```

```
dario — http://localhost:3456

Your Claude subscription is now an API.

Usage:
  ANTHROPIC_BASE_URL=http://localhost:3456
  ANTHROPIC_API_KEY=dario

Backend: Claude CLI (bypasses rate limits)
Model: claude-opus-4-6 (all requests)
```

**Requirements:** Claude Code must be installed (`npm install -g @anthropic-ai/claude-code` or already installed via the desktop app).

**Trade-offs vs direct API mode:**

| | Direct API (default) | CLI Backend (`--cli`) |
|---|---|---|
| Streaming | Yes | No (full response) |
| Tool use passthrough | Yes | No |
| Latency | Low | Higher (process spawn) |
| Rate limits | Subject to weekly quota | Bypassed |
| Opus when throttled | Blocked | **Works** |

## Model Selection

Force a specific model for all requests — useful when your tool doesn't let you configure the model:

```bash
dario proxy --model=opus      # Force Opus 4.6
dario proxy --model=sonnet    # Force Sonnet 4.6
dario proxy --model=haiku     # Force Haiku 4.5
dario proxy                   # Passthrough (client decides)
```

Full model IDs also work: `--model=claude-opus-4-6`

Combine with `--cli` for rate-limit-proof Opus:

```bash
dario proxy --cli --model=opus
```

## Usage Examples

### curl

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Python

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3456",
    api_key="dario"
)

message = client.messages.create(
    model="claude-opus-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)
```

### TypeScript / Node.js

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:3456",
  apiKey: "dario",
});

const message = await client.messages.create({
  model: "claude-opus-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Streaming (direct API mode only)

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-opus-4-6",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Write a haiku about APIs"}]
  }'
```

### With Other Tools

```bash
# OpenClaw
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario openclaw

# Aider
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario aider --model claude-opus-4-6

# Any tool that uses ANTHROPIC_BASE_URL
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario your-tool-here
```

## How It Works

### Direct API Mode (default)

```
┌──────────┐     ┌─────────────────┐     ┌──────────────────┐
│ Your App │ ──> │  dario (proxy)  │ ──> │ api.anthropic.com│
│          │     │  localhost:3456  │     │                  │
│ sends    │     │  swaps API key  │     │  sees valid      │
│ API key  │     │  for OAuth      │     │  OAuth bearer    │
│ "dario"  │     │  bearer token   │     │  token           │
└──────────┘     └─────────────────┘     └──────────────────┘
```

### CLI Backend Mode (`--cli`)

```
┌──────────┐     ┌─────────────────┐     ┌──────────────────┐
│ Your App │ ──> │  dario (proxy)  │ ──> │  claude --print  │
│          │     │  localhost:3456  │     │  (Claude Code)   │
│ sends    │     │  extracts prompt│     │                  │
│ API      │     │  spawns CLI     │     │  has priority    │
│ request  │     │  wraps response │     │  routing         │
└──────────┘     └─────────────────┘     └──────────────────┘
```

1. **`dario login`** — Standard PKCE OAuth flow. Opens Claude's auth page in your browser. You authorize, dario stores the tokens locally in `~/.dario/credentials.json`. No server involved, no secrets leave your machine.

2. **`dario proxy`** — Starts an HTTP server on localhost that implements the Anthropic Messages API. In direct mode, it swaps your API key for an OAuth bearer token. In CLI mode, it routes through the Claude Code binary.

3. **Auto-refresh** — OAuth tokens expire. Dario refreshes them automatically in the background every 15 minutes. Refresh tokens rotate on each use.

## Commands

| Command | Description |
|---------|-------------|
| `dario login` | Authenticate with your Claude account |
| `dario proxy` | Start the local API proxy |
| `dario status` | Check if your token is healthy |
| `dario refresh` | Force an immediate token refresh |
| `dario logout` | Delete stored credentials |
| `dario help` | Show usage information |

### Proxy Options

| Flag | Description | Default |
|------|-------------|---------|
| `--cli` | Use Claude CLI as backend (bypasses rate limits) | off |
| `--model=MODEL` | Force a model (`opus`, `sonnet`, `haiku`, or full ID) | passthrough |
| `--port=PORT` | Port to listen on | `3456` |
| `--verbose` / `-v` | Log every request | off |

## Supported Features

### Direct API Mode
- All Claude models (Opus 4.6, Sonnet 4.6, Haiku 4.5)
- Streaming and non-streaming
- Tool use / function calling
- System prompts and multi-turn conversations
- Prompt caching and extended thinking
- All `anthropic-beta` features (headers pass through)
- CORS enabled (works from browser apps on localhost)

### CLI Backend Mode
- All Claude models — including Opus when rate limited
- Non-streaming responses
- System prompts and multi-turn conversations (via context injection)
- Bypasses subscription rate limits

## Endpoints

| Path | Description |
|------|-------------|
| `POST /v1/messages` | Anthropic Messages API (main endpoint) |
| `GET /health` | Proxy health + OAuth status + request count |
| `GET /status` | Detailed OAuth token status |

## Health Check

```bash
curl http://localhost:3456/health
```

```json
{
  "status": "ok",
  "oauth": "healthy",
  "expiresIn": "11h 42m",
  "requests": 47
}
```

## Security

| Concern | How dario handles it |
|---------|---------------------|
| Credential storage | `~/.dario/credentials.json` with `0600` permissions (owner-only) |
| OAuth flow | PKCE (Proof Key for Code Exchange) — no client secret needed |
| Token transmission | OAuth tokens never leave localhost. Only forwarded to `api.anthropic.com` over HTTPS |
| Network exposure | Proxy binds to `127.0.0.1` only — not accessible from other machines |
| SSRF protection | Allowlisted API paths only. Internal networks and cloud metadata blocked |
| Token rotation | Refresh tokens rotate on every use (single-use) |
| Error sanitization | Token patterns redacted from all error messages |
| Data collection | Zero. No telemetry, no analytics, no phoning home |

## FAQ

**Does this violate Anthropic's terms of service?**
Dario uses the same public OAuth client ID and PKCE flow that Claude Code uses. It authenticates you as you, with your subscription, through Anthropic's official OAuth endpoints. The `--cli` mode literally uses Claude Code itself as the backend.

**What subscription plans work?**
Claude Max and Claude Pro. Any plan that lets you use Claude Code.

**Does it work with Claude Team / Enterprise?**
Should work if your plan includes Claude Code access. Not tested yet — please open an issue with results.

**What happens when my token expires?**
Dario auto-refreshes tokens 30 minutes before expiry. You should never see an auth error in normal use. If something goes wrong, `dario refresh` forces an immediate refresh, or `dario login` to re-authenticate.

**I'm getting rate limited on Opus. What do I do?**
Use `--cli` mode: `dario proxy --cli`. This routes through the Claude Code binary, which has priority access that bypasses subscription rate limits.

**Can I run this on a server?**
Dario binds to localhost by default. For server use, you'd need to handle the initial browser-based login on a machine with a browser, then copy `~/.dario/credentials.json` to your server. Auto-refresh will keep it alive from there.

**Why "dario"?**
Named after [Dario Amodei](https://en.wikipedia.org/wiki/Dario_Amodei), CEO of Anthropic.

## Programmatic API

Use dario as a library in your own Node.js app:

```typescript
import { startProxy, getAccessToken, getStatus } from "@askalf/dario";

// Start the proxy programmatically
await startProxy({ port: 3456, verbose: true });

// CLI backend mode
await startProxy({ port: 3456, cliBackend: true, model: "opus" });

// Or just get a raw access token
const token = await getAccessToken();

// Check token health
const status = await getStatus();
console.log(status.expiresIn); // "11h 42m"
```

## Contributing

PRs welcome. The codebase is ~700 lines of TypeScript across 4 files:

| File | Purpose |
|------|---------|
| `src/oauth.ts` | PKCE flow, token storage, refresh logic |
| `src/proxy.ts` | HTTP proxy server + CLI backend |
| `src/cli.ts` | CLI entry point |
| `src/index.ts` | Library exports |

```bash
git clone https://github.com/askalf/dario
cd dario
npm install
npm run dev   # runs with tsx (no build needed)
```

## License

MIT
