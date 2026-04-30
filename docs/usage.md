# Usage — SDK examples

## Python (Anthropic SDK)

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3456",
    api_key="dario",
)

msg = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(msg.content[0].text)
```

## Python (OpenAI SDK — same proxy, different provider)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="dario",
)

# gpt-4o routes to the configured OpenAI backend
msg = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello!"}],
)

# claude-opus-4-7 routes to the Claude subscription backend — same SDK, same URL
claude_msg = client.chat.completions.create(
    model="claude-opus-4-7",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

## TypeScript / Node.js

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:3456",
  apiKey: "dario",
});

const msg = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

## OpenAI-compatible tools (universal env-var setup)

```bash
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Use Claude model names (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`, or shortcuts `opus` / `sonnet` / `haiku`) for the Claude subscription backend, or GPT-family / Llama / any-other-model names for your configured OpenAI-compat backends.

For per-tool setup (Cursor, Continue, Aider, Cline, Roo, Zed, OpenHands, etc.), see [agent compatibility](./agent-compat.md#per-tool-setup).

## curl

```bash
# Claude backend via Anthropic format
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4-7","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'

# OpenAI backend via OpenAI format
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dario" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello!"}]}'
```

## Streaming, tool use, prompt caching, extended thinking

All supported. Claude backend: full Anthropic SSE format plus OpenAI-SSE translation for tool_use streaming. OpenAI-compat backend: streaming body forwarded byte-for-byte. See [Wire-fidelity axes](./wire-fidelity.md) for the v3.25 `--drain-on-close` knob that matches CC's read-to-EOF stream-consumption pattern.

## Provider prefix

Any request's `model` field can be written as `<provider>:<name>` to force which backend handles it, regardless of what the model name looks like.

| Prefix | Backend |
|---|---|
| `openai:` | OpenAI-compat backend |
| `groq:` | OpenAI-compat backend |
| `openrouter:` | OpenAI-compat backend |
| `local:` | OpenAI-compat backend |
| `compat:` | OpenAI-compat backend |
| `claude:` | Claude subscription backend |
| `anthropic:` | Claude subscription backend |

The prefix gets stripped before the request goes upstream — the backend only sees the bare model name. Unrecognized prefixes are ignored, so Ollama-style `llama3:8b` passes through untouched. `dario proxy --model=openai:gpt-4o` applies the prefix to every request server-wide.

## Library mode

```typescript
import { startProxy, getAccessToken, getStatus, listBackends } from "@askalf/dario";

await startProxy({ port: 3456, verbose: true });
const token = await getAccessToken();
const status = await getStatus();
const backends = await listBackends();
```

## Health check

```bash
curl http://localhost:3456/health
```
