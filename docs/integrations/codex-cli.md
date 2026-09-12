# Codex CLI on your Claude plan

OpenAI's Codex CLI runs on a Claude subscription through dario, with its
tools, since 6.3. The other way round — Claude Code on a ChatGPT plan — has
worked since 5.5.89. Both on one machine, one `dario proxy`, is the whole
point of the project in two panes.

## Why this needed a new endpoint

Codex CLI 0.154 removed `wire_api = "chat"` for custom providers
([openai/codex discussion 7782](https://github.com/openai/codex/discussions/7782)):
a provider has to speak the **Responses API** or it cannot be used at all. So
dario now has `POST /v1/responses`. The request is translated once at the front
door into the Messages shape every other dario path already serves — pool,
template, failover, mid-stream continuation — and everything written back is
translated at the write boundary. For a ChatGPT-subscription model the body
goes through to the codex backend untouched instead (it speaks Responses
natively), which is what keeps Codex's newest request features working there:
`additional_tools` input items, `custom` tools, `reasoning.context`,
`include`.

The OpenAI Agents SDK and anything else that speaks Responses gets the same
endpoint.

## Setup

```bash
dario proxy                                   # your Claude plan, port 3456
```

`~/.codex/config.toml`:

```toml
model = "claude-opus-5"
model_provider = "dario"

[model_providers.dario]
name = "dario"
base_url = "http://127.0.0.1:3456/v1"
env_key = "DARIO_API_KEY"
wire_api = "responses"
```

`export DARIO_API_KEY=dario` (any value until you set one on the proxy; then it
has to match), and `codex` runs on the Claude pool. `-m claude-sonnet-5` /
`-m claude-opus-5` / any `claude-*` id; `codex exec` works the same way.

With a ChatGPT account attached as well (`dario add altman`),
`-m gpt-5.6-sol` on the same provider block goes to that plan through dario —
pooling, failover and `x-dario-*` headers included.

Codex prints `Model metadata for claude-opus-5 not found. Defaulting to fallback
metadata` for any model it does not ship metadata for. Harmless: it falls back
to its classic request profile (top-level `tools` and `instructions`), which is
exactly the one the translation reads.

## What runs, and what does not

Verified on 2026-09-12 with Codex CLI 0.154.0 on a Claude Max plan:

- a plain turn;
- the full agent loop — `exec_command` called by Claude, executed by Codex,
  the `function_call_output` returned, Claude answering from it — with the
  17 KB Codex system prompt cached on the Claude side (98–99% cache reads
  from the second turn);
- the same loop on a ChatGPT plan through the passthrough.

Translated on the Claude pool: `instructions` and `developer` messages
(hoisted to the system prompt, in order), `message` items with `input_text`,
`output_text` and `input_image` parts (data-URL and https images),
`function_call` / `function_call_output` (tool_use / tool_result, call ids
preserved), `function` tools (and `namespace` groups, flattened),
`tool_choice` including `required` and a named function,
`parallel_tool_calls: false`, `max_output_tokens`, `temperature`, `top_p`,
`reasoning.effort` (as dario's own `model:high` effort spelling). Back out:
`message`, `function_call` and `reasoning` items, the full Responses event
sequence with sequence numbers, usage in OpenAI terms (cached prefix inside
`input_tokens`, reported again under `cached_tokens`), `incomplete` on
`max_tokens`, `response.failed` on an upstream error.

Dropped, with a line at `--verbose`: hosted tool types the pool cannot run
(`web_search`, `file_search`, `mcp`, …), `custom` freeform tools,
`reasoning` items on the way in (OpenAI's encrypted content — the pool does
not need it back), `text.format`. `previous_response_id` on the Claude pool is a 400 naming the
field (dario is stateless there; send the full input each turn, which Codex
does); on a ChatGPT-subscription model it is forwarded untouched to a backend
that keeps state, `store` as you sent it.

Not built: a buffered (non-streaming) response from a ChatGPT-subscription
model on this route — the backend streams, and folding a Responses stream into
a response object is not written yet; the answer is a 400 naming `stream`.
Mid-stream continuation runs under this route on the Claude pool (the
translated request is an ordinary Anthropic-shape request) and not on the
passthrough.
