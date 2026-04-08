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
  <a href="#faq">FAQ</a>
</p>

---

```bash
npx dario login   # authenticate with Claude
npx dario proxy   # start local API on :3456

# now use it from anywhere
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
```

That's it. Any tool that speaks the Anthropic API now uses your subscription.

---

## The Problem

You pay $100-200/mo for Claude Max or Pro. But that subscription only works on claude.ai and Claude Code. If you want to use Claude with **any other tool** — OpenClaw, Cursor, Continue, Aider, your own scripts — you need a separate API key with separate billing.

**dario fixes this.** It creates a local proxy that translates API key auth into your subscription's OAuth tokens. Your tools don't know the difference.

## Quick Start

### Install

```bash
npm install -g dario
```

Or use npx (no install needed):

```bash
npx dario login
npx dario proxy
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
dario v1.0.0 — http://localhost:3456

Your Claude subscription is now an API.

Usage:
  ANTHROPIC_BASE_URL=http://localhost:3456
  ANTHROPIC_API_KEY=dario

OAuth: healthy (expires in 11h 42m)
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

### Streaming

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role": "user", "content": "Write a haiku about APIs"}]
  }'
```

### With Other Tools

```bash
# OpenClaw
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario openclaw start

# Aider
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario aider --model claude-opus-4-6

# Any tool that uses ANTHROPIC_BASE_URL
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario your-tool-here
```

## How It Works

```
┌──────────┐     ┌─────────────────┐     ┌──────────────────┐
│ Your App │ ──> │  dario (proxy)  │ ──> │ api.anthropic.com│
│          │     │  localhost:3456  │     │                  │
│ sends    │     │  swaps API key  │     │  sees valid      │
│ API key  │     │  for OAuth      │     │  OAuth bearer    │
│ "dario"  │     │  bearer token   │     │  token           │
└──────────┘     └─────────────────┘     └──────────────────┘
```

1. **`dario login`** — Standard PKCE OAuth flow. Opens Claude's auth page in your browser. You authorize, dario stores the tokens locally in `~/.dario/credentials.json`. No server involved, no secrets leave your machine.

2. **`dario proxy`** — Starts an HTTP server on localhost that implements the full [Anthropic Messages API](https://docs.anthropic.com/en/api/messages). When a request arrives, dario:
   - Strips the incoming API key (you can use any string)
   - Injects your OAuth access token as a Bearer header
   - Forwards the request to `api.anthropic.com`
   - Streams the response back to your app

3. **Auto-refresh** — OAuth tokens expire. Dario refreshes them automatically in the background every 15 minutes. Refresh tokens rotate on each use. You never have to re-login unless you explicitly log out.

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
| `--port=PORT` | Port to listen on | `3456` |
| `--verbose` / `-v` | Log every request with token counts | off |

## Supported Features

Everything the Anthropic Messages API supports:

- All Claude models (`opus-4-6`, `sonnet-4-6`, `haiku-4-5`)
- Streaming and non-streaming
- Tool use / function calling
- System prompts and multi-turn conversations
- Prompt caching
- Extended thinking
- All `anthropic-beta` features (headers pass through)
- CORS enabled (works from browser apps on localhost)

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
| Network exposure | Proxy binds to `localhost` only — not accessible from other machines |
| Token rotation | Refresh tokens rotate on every use (single-use) |
| Data collection | Zero. No telemetry, no analytics, no phoning home |

## FAQ

**Does this violate Anthropic's terms of service?**
Dario uses the same public OAuth client ID and PKCE flow that Claude Code uses. It authenticates you as you, with your subscription, through Anthropic's official OAuth endpoints. It doesn't bypass any access controls — it just bridges the auth method.

**What subscription plans work?**
Claude Max and Claude Pro. Any plan that lets you use Claude Code.

**Does it work with Claude Team / Enterprise?**
Should work if your plan includes Claude Code access. Not tested yet — please open an issue with results.

**What happens when my token expires?**
Dario auto-refreshes tokens 30 minutes before expiry. You should never see an auth error in normal use. If something goes wrong, `dario refresh` forces an immediate refresh, or `dario login` to re-authenticate.

**Can I run this on a server?**
Dario binds to localhost by default. For server use, you'd need to handle the initial browser-based login on a machine with a browser, then copy `~/.dario/credentials.json` to your server. Auto-refresh will keep it alive from there.

**What's the rate limit?**
Whatever your subscription plan provides. Dario doesn't add any limits — it's a transparent proxy.

**Why "dario"?**
Named after [Dario Amodei](https://en.wikipedia.org/wiki/Dario_Amodei), CEO of Anthropic.

## Programmatic API

Use dario as a library in your own Node.js app:

```typescript
import { startProxy, getAccessToken, getStatus } from "dario";

// Start the proxy programmatically
await startProxy({ port: 3456, verbose: true });

// Or just get a raw access token
const token = await getAccessToken();

// Check token health
const status = await getStatus();
console.log(status.expiresIn); // "11h 42m"
```

## Contributing

PRs welcome. The codebase is ~500 lines of TypeScript across 4 files:

| File | Purpose |
|------|---------|
| `src/oauth.ts` | PKCE flow, token storage, refresh logic |
| `src/proxy.ts` | HTTP proxy server |
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
