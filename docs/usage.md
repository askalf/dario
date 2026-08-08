# Usage — SDK examples

## Python (Anthropic SDK)

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:3456",
    api_key="dario",
)

msg = client.messages.create(
    model="claude-opus-5",
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

# claude-opus-5 routes to the Claude subscription backend — same SDK, same URL
claude_msg = client.chat.completions.create(
    model="claude-opus-5",
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
  model: "claude-opus-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

## OpenAI-compatible tools (universal env-var setup)

```bash
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Use Claude model names (`claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`, plus `[1m]` long-context variants like `claude-fable-5[1m]` or `claude-opus-5[1m]` — every family except haiku has one, or shortcuts `fable` / `opus` / `sonnet` / `haiku` and their `1m` forms like `fable1m` / `opus1m`) for the Claude subscription backend, or GPT-family / Llama / any-other-model names for your configured OpenAI-compat backends. `GET /v1/models` autodetects the available set from Anthropic's live catalog (hourly TTL; baked fallback when offline), and the family shortcuts always resolve to the newest model of that family it lists.

For per-tool setup (Cursor, Continue, Aider, Cline, Roo, Zed, OpenHands, etc.), see [agent compatibility](./integrations/agent-compat.md#per-tool-setup).

## curl

```bash
# Claude backend via Anthropic format
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-5","max_tokens":1024,"messages":[{"role":"user","content":"Hello!"}]}'

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

dario has three health surfaces, and they answer different questions:

| Endpoint | Answers | Costs |
|---|---|---|
| `GET /livez` | Is the HTTP server accepting connections? Always 200. | nothing |
| `GET /health` | Do credentials and the pool look serviceable? 503 when not. | nothing |
| `GET /health?probe=1` | Did a real request to Anthropic just succeed? | one tiny billed request per TTL |

`/health` inspects state; it does not prove anything end-to-end. Adding
`?probe=1` sends a real `max_tokens: 1` request upstream and folds the verdict
into the response, so a proxy whose credentials look fine but whose requests all
fail returns 503 instead of `ok`:

```json
{
  "status": "degraded",
  "oauth": "valid",
  "probe": { "ok": false, "reason": "auth-rejected", "status": 401,
             "latencyMs": 233, "ageMs": 4812, "model": "claude-haiku-4-5" },
  "queue": { "active": 10, "queued": 4, "maxConcurrent": 10,
             "stalledSince": 1754790000000, "stalledForMs": 28800000 }
}
```

Notes that matter in production:

- **The probe is opt-in and never runs on a plain `/health`.** Existing docker
  healthchecks and uptime monitors keep costing nothing.
- **Only trusted callers can trigger it** — and never a caller that arrived
  through a Cloudflare tunnel, even an authenticated one. A `/health` reachable
  from the internet is not a button for spending tokens, and the probe's own
  cache means one request per TTL would be enough to keep it running.
- **Results are cached and single-flighted** (`DARIO_PROBE_TTL_MS`, default
  60000), so polling every second still costs at most one probe per minute.
- **A rate-limited or overloaded upstream is not an outage.** 429 and 529 keep
  `ok: true`; restarting dario cannot help either, and a watchdog that keys on
  them just thrashes. Only auth rejection, 5xx, network failure and timeout set
  `ok: false`.
- **`queue.stalledForMs` is the slot-exhaustion signal**, not `active`/`queued`.
  A busy proxy legitimately sits at its concurrency cap with a backlog; the
  failure mode in dario#905 was slots that stopped turning over entirely. Any
  release resets the stall clock, so sustained load never trips it.

### Who sees what

`/health` is auth-free by design — a docker healthcheck has to work before any
key is configured. The response body is therefore split two ways, while the HTTP
status (200/503) is identical for everyone, so uptime checks are unaffected:

| Caller | Gets |
|---|---|
| Presented a configured `DARIO_API_KEY` | full detail |
| Bare loopback (docker healthcheck, `dario doctor`) | full detail |
| Arrived through a Cloudflare tunnel (`cf-ray`) | `{"status": "ok"}` only |
| Anything else (LAN, another container, WAN) | `{"status": "ok"}` only |

> **Changed in 5.5.1.** "Presented a configured key" previously read as "passed
> the API-key check" — which every caller passes when **no** `DARIO_API_KEY` is
> set. On an unkeyed proxy published through a tunnel, that disclosed the OAuth
> countdown, request volume and refresh-failure count to anyone who asked. If
> you monitor `/health` through a tunnel with no key configured, you now get the
> liveness verdict only; set `DARIO_API_KEY` and send it, or query from
> loopback, to keep the detail.

A watchdog wants the probe; a container healthcheck usually does not:

```bash
# liveness — restart only if the process itself is gone
curl -sf http://localhost:3456/livez

# real serving check, e.g. every 5 minutes
curl -sf 'http://localhost:3456/health?probe=1' >/dev/null || alert
```

Knobs: `DARIO_PROBE_MODEL` (default `claude-haiku-4-5`),
`DARIO_PROBE_TTL_MS` (default `60000`), `DARIO_PROBE_TIMEOUT_MS` (default `15000`).
