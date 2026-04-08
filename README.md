# dario

**Use your Claude subscription as an API.**

A lightweight OAuth bridge that turns your Claude Max or Pro subscription into a local API endpoint. Point any tool that uses the Anthropic API at dario and it just works — no API key needed.

## Why

You're paying for Claude Max/Pro. You should be able to use it with any tool — not just claude.ai and Claude Code. Dario bridges the gap.

## Install

```bash
npm install -g dario
```

Or run directly:

```bash
npx dario login
npx dario proxy
```

## Quick Start

```bash
# 1. Login with your Claude account
dario login

# 2. Start the proxy
dario proxy

# 3. Use it from any tool
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario your-tool-here
```

## Usage with OpenClaw

```bash
ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario openclaw start
```

## Usage with the Anthropic SDK

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3456",
    api_key="dario"  # any string works, auth is handled by OAuth
)

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
```

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://localhost:3456',
  apiKey: 'dario',
});

const message = await client.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

## Commands

| Command | Description |
|---------|-------------|
| `dario login` | Authenticate with your Claude account |
| `dario proxy` | Start the API proxy (default: port 3456) |
| `dario status` | Check authentication status |
| `dario refresh` | Force token refresh |
| `dario logout` | Remove saved credentials |

### Proxy Options

```bash
dario proxy --port=8080    # Custom port
dario proxy --verbose      # Log all requests
```

## How It Works

1. **Login**: Opens Claude's OAuth flow in your browser. You authorize dario to use your subscription. Standard PKCE flow — no secrets stored on any server.

2. **Proxy**: Runs a local HTTP server that speaks the Anthropic API protocol. When a request comes in, dario swaps the API key header for an OAuth bearer token and forwards it to `api.anthropic.com`.

3. **Auto-refresh**: Tokens are refreshed automatically in the background. Set it and forget it.

```
Your App  →  localhost:3456  →  api.anthropic.com
              (dario proxy)      (OAuth bearer token)
```

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

- All credentials stored locally in `~/.dario/credentials.json` with `0600` permissions
- PKCE OAuth flow — no client secret, nothing leaves your machine
- Tokens auto-refresh; refresh tokens rotate on each use
- The proxy only listens on localhost by default
- No telemetry, no analytics, no data collection

## Billing

Your Claude Max or Pro subscription handles all the billing. Dario doesn't charge anything — it just bridges the auth.

## License

MIT
