# Point your tools at it

Two base URLs, one key. Anthropic-shaped clients talk to `http://localhost:3456`; OpenAI-shaped clients — chat/completions and, since 6.3, the Responses API — talk to `http://localhost:3456/v1`. The key is `dario` (any value works until you set `DARIO_API_KEY`, which then has to match).

<details>
<summary><strong>Codex CLI</strong> — OpenAI's agent, on your Claude plan</summary>

```toml
# ~/.codex/config.toml
model = "claude-opus-5"
model_provider = "dario"

[model_providers.dario]
name = "dario"
base_url = "http://127.0.0.1:3456/v1"
env_key = "DARIO_API_KEY"
wire_api = "responses"
```

Codex CLI 0.154 dropped the chat wire for custom providers, so dario speaks the Responses API: the request is translated once at the front door and served like any Claude request — pool, failover, mid-stream continuation, the 17 KB Codex system prompt cached on the Claude side. The full agent loop runs: Claude calls `exec_command`, Codex executes it, the result goes back, Claude answers from it. Add a ChatGPT account too and `-m gpt-5.6-sol` on the same block goes to that plan through the same proxy. [Walkthrough and what is dropped](integrations/codex-cli.md).
</details>

<details>
<summary><strong>Claude Code</strong> — forwarded verbatim</summary>

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
claude
```

A genuine Claude Code request already *is* the Claude Code shape, so dario forwards it byte-for-byte — system prompt, tools, thinking, key order untouched — swapping in only the pool's credential, its billing tag and cache breakpoints. That covers the main loop, its Task/Agent sub-agents and the permission classifier. What you gain is the pool: several seats behind the one URL, with headroom routing and 429 failover. Background: [#678](https://github.com/askalf/dario/issues/678).
</details>

<details>
<summary><strong>Cursor</strong> — needs a public HTTPS tunnel, and the <code>anthropic:</code> prefix</summary>

Cursor's BYOK is backend-mediated: the app sends your base URL up to Cursor's servers and *they* make the call, behind an SSRF guard that rejects `localhost` by design (confirmed by Cursor staff, threads linked in the long-form guide). So:

```bash
dario proxy                                     # terminal 1
cloudflared tunnel --url http://localhost:3456   # terminal 2 → https://<random>.trycloudflare.com
```

In Cursor → Settings → Models: enable **Override OpenAI Base URL** with `https://<random>.trycloudflare.com/v1`, key `dario`, and add models as `anthropic:opus` / `anthropic:sonnet` / `anthropic:haiku`. The `anthropic:` prefix routes to the Claude backend without the `claude-` substring that makes Cursor switch to a tool format the OpenAI path can't parse, and it dodges Cursor's built-in-name collision. Use **Agent** mode (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>I</kbd>); Chat sends no tools. Treat the tunnel URL as a credential. Full walkthrough with every gotcha: [agent-compat.md#cursor](integrations/agent-compat.md#cursor).
</details>

<details>
<summary><strong>Cline · Roo Code · Kilo Code</strong> — API provider "Anthropic"</summary>

Provider **Anthropic** · API key `dario` · Anthropic Base URL `http://localhost:3456` · model `claude-sonnet-5` / `claude-opus-5` / `claude-haiku-4-5`.

These clients speak an XML tool protocol. dario detects them from their system-prompt identity markers and flips into preserve-tools mode on its own, so their schemas pass through and their parsers keep working. `--no-auto-detect` if you'd rather choose. [Details](integrations/agent-compat.md#cline--roo-code--kilo-code).
</details>

<details>
<summary><strong>Aider</strong></summary>

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
aider --model sonnet        # or opus, haiku, any claude-* id
```
</details>

<details>
<summary><strong>Continue.dev</strong></summary>

```yaml
# ~/.continue/config.yaml
models:
  - name: Claude Sonnet (dario)
    provider: anthropic
    model: claude-sonnet-5
    apiBase: http://localhost:3456
    apiKey: dario
```
</details>

<details>
<summary><strong>Zed</strong></summary>

```json
{ "language_models": { "anthropic": { "api_url": "http://localhost:3456", "version": "2023-06-01" } } }
```

Set `ANTHROPIC_API_KEY=dario` in the environment Zed launches from; the model picker then lists Claude models routed through your plan.
</details>

<details>
<summary><strong>OpenHands</strong></summary>

```bash
export LLM_BASE_URL=http://localhost:3456
export LLM_API_KEY=dario
export LLM_MODEL=anthropic/claude-sonnet-5
```

The `anthropic/` prefix tells LiteLLM (OpenHands' router) to take the Anthropic path, which dario is now fronting. End-to-end walkthrough: [openhands-walkthrough.md](integrations/openhands-walkthrough.md).
</details>

<details>
<summary><strong>OpenClaw</strong></summary>

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
openclaw "task description"
```

OpenClaw's `exec` / `process` / `web_search` / `web_fetch` / `browser` tools are translated to Claude Code's set without a flag; a tool outside the map (`message`, for one) rides a fallback slot instead. Newer OpenClaw reads `auth-profiles.json` before env vars, so a stale key there wins — the [walkthrough](integrations/openclaw-walkthrough.md) covers it.
</details>

<details>
<summary><strong>Codex CLI · OpenAI SDK · any OpenAI-compatible tool</strong></summary>

```bash
export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Ask for `gpt-5.5` and it is served by your ChatGPT plan once you've run `dario add altman`. Ask for `claude-sonnet-5` on the same URL and it is served by your Claude plan, translated both ways. Ask for `gpt-4o` or anything else your API-key backend lists and it goes there byte-for-byte. Names that don't look like OpenAI's (`llama-3.3-70b`, `qwen-coder`) need the provider prefix below; dario refuses them rather than guess:

```bash
dario backend add openai     --key=sk-proj-...
dario backend add groq       --key=gsk_...    --base-url=https://api.groq.com/openai/v1
dario backend add openrouter --key=sk-or-...  --base-url=https://openrouter.ai/api/v1
dario backend add local      --key=anything   --base-url=http://127.0.0.1:11434/v1
```

Force a backend with a prefix: `openai:gpt-4o`, `claude:opus`, `groq:llama-3.3-70b`, `local:qwen-coder`.

One holdover for old configs: six legacy OpenAI names (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.3`, `gpt-4`, `gpt-3.5-turbo`) sent to `/v1/chat/completions` are translated to Claude models when no other provider claims them.
</details>

<details>
<summary><strong>Claude Agent SDK · Anthropic SDK</strong> (TypeScript, Python)</summary>

```ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "http://localhost:3456", apiKey: "dario" });
```

```python
import anthropic
client = anthropic.Anthropic(base_url="http://localhost:3456", api_key="dario")
```

Zero code change beyond the base URL. Streaming, tool use, prompt caching and extended thinking all pass through. More in [usage.md](usage.md).
</details>

<details>
<summary><strong>curl</strong></summary>

```bash
curl http://localhost:3456/v1/messages -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":256,"messages":[{"role":"user","content":"Hello!"}]}'

curl http://localhost:3456/v1/chat/completions -H "content-type: application/json" \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"Hello!"}]}'
```
</details>

<details>
<summary><strong>Docker</strong> · Kubernetes · a Pi in a closet</summary>

```bash
docker volume create dario-config
docker run --rm -it -v dario-config:/home/dario/.dario ghcr.io/askalf/dario:latest login --manual
docker run -d --name dario -p 3456:3456 -v dario-config:/home/dario/.dario \
  -e DARIO_API_KEY="$(openssl rand -hex 32)" ghcr.io/askalf/dario:latest
```

The image binds `0.0.0.0`, so a key is mandatory; without one dario refuses to start rather than become an open relay for your subscription. No console at all? Start empty with `DARIO_ADMIN=1` and provision the first account over HTTP with the [admin API](admin-api.md). Two replicas sharing accounts need the [refresh lock](multi-instance.md). [Docker guide](docker.md).
</details>

Something not listed? If it reads `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`, or has a "Base URL" field, it works. The [compatibility matrix](integrations/compat-matrix.md) says which tools are exercised end-to-end, which are inferred from a shared code path, and which are untested — one honest cell per tool.

---

[← README](../README.md) · [all reference docs](../README.md#reference)
