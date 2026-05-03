# Agent compatibility

Dario's built-in `TOOL_MAP` carries **59 schema-verified entries** covering the tool schemas of every major coding agent. On the Claude backend, tool calls translate to CC's native `Bash / Read / Write / Edit / Glob / Grep / WebSearch / WebFetch` on the outbound path (so the request stays on the subscription wire shape) and rebuild to your agent's exact expected shape on the inbound path (so your validator is happy). No flag required.

| Agent | Covered tool names (subset) |
|---|---|
| Claude Code / Claude Agent SDK | default — CC / SDK tools (same schema as of CC v2.1.114 / `@anthropic-ai/claude-agent-sdk@0.2.x`) |
| Cline / Roo Code / Kilo Code | `execute_command`, `write_to_file`, `replace_in_file`, `apply_diff`, `list_files`, `search_files`, `read_file` |
| Cursor | `run_terminal_cmd`, `edit_file`, `search_replace`, `codebase_search`, `grep_search`, `file_search`, `list_dir`, `read_file` (`target_file`) |
| Windsurf | `run_command`, `view_file`, `write_to_file`, `replace_file_content`, `find_by_name`, `grep_search`, `list_dir`, `search_web`, `read_url_content` |
| Continue.dev | `builtin_run_terminal_command`, `builtin_read_file`, `builtin_create_new_file`, `builtin_edit_existing_file`, `builtin_file_glob_search`, `builtin_grep_search`, `builtin_ls` |
| GitHub Copilot | `run_in_terminal`, `insert_edit_into_file`, `semantic_search`, `codebase_search`, `list_dir`, `fetch_webpage` |
| OpenHands | `execute_bash`, `str_replace_editor` |
| OpenClaw | `exec`, `process`, `web_search`, `web_fetch`, `browser`, `message` |
| hands ([askalf/hands](https://github.com/askalf/hands)) | Anthropic beta computer-use tools (`computer`, `bash`, `str_replace_based_edit_tool`) — auto-preserved via system-prompt identity match (v3.33.0) |
| Hermes Agent (Nous Research) | `terminal`, `process`, `read_file`, `write_file`, `patch`, `search_files`, `web_search`, `web_extract`, `todo` mapped directly. Hermes-specific tools (`browser_*`, `vision_analyze`, `image_generate`, `skill_*`, `memory`, `session_search`, `cronjob`, `send_message`, `ha_*`, `mixture_of_agents`, `delegate_task`, `execute_code`, `text_to_speech`) have no CC equivalent and auto-preserve through the identity detector. Also consider `--max-tokens=client` so Hermes's 64k/128k per-model caps survive dario's outbound pin. |

Text-tool clients (Cline / Kilo Code / Roo Code and forks) are auto-detected via system-prompt identity markers and automatically flipped into preserve-tools mode, because mixing CC's `tools` array with their XML protocol makes the model emit `<function_calls><invoke>` that their parsers can't read. The same identity path also catches `arnie` (askalf's portable IT-troubleshooting CLI) and `hands` (askalf's computer-use agent) — their tool names overlap with `TOOL_MAP` but their schemas diverge, so identity match → preserve-tools is the only correct routing. If you run dario specifically for wire-level fidelity and would rather pick `--preserve-tools` yourself, `--no-auto-detect` (v3.20.1, aka `--no-auto-preserve`) disables the heuristic — explicit operator choice then wins.

Beyond the identity path, dario falls back to a **structural** check: when a request carries 3+ tools and ≥80% of them aren't in `TOOL_MAP`, that's a custom client whose tool surface has effectively no overlap with CC's, and round-robin remap onto CC fallback slots silently corrupts the calls. The structural fallback flips those requests to preserve-tools too, with `client: 'unknown-non-cc'` in the request log. This catches in-house agents and OpenClaw derivatives that we haven't added an explicit pattern for, without needing per-client maintenance. `--no-auto-detect` disables both paths.

If your agent's tool names aren't pre-mapped and its tools carry fields CC's schema doesn't have, there are two escape hatches: **`--preserve-tools`** (forward your schema verbatim, lose the CC wire shape) or **`--hybrid-tools`** (keep the CC wire shape, fill request-context fields from headers). See [Custom tool schemas](#custom-tool-schemas).

The OpenAI-compat backend forwards tool definitions byte-for-byte and doesn't need any of this.

## Per-tool setup

### Cursor

> **⚠️ Architectural mismatch (read this before configuring)**
>
> Cursor's BYOK is **backend-mediated**, not client-side. When you set "Override OpenAI Base URL" in Cursor, the Electron app sends that URL up to Cursor's own backend (`api2.cursor.sh`), and **Cursor's servers** make the outbound LLM call — not your machine. Their backend has an SSRF (Server-Side Request Forgery) guard that rejects RFC1918 + loopback addresses by design, so `http://localhost:3456` is structurally unreachable. The error surfaces as either `Provider returned error: Access to private networks is forbidden` (older form) or `{"error":{"type":"client","reason":"ssrf_blocked","message":"connection to private IP is blocked"}}` (current form).
>
> Confirmed by Cursor staff in their own words across multiple forum threads — Colin, Feb 9 2026: *"we have SSRF (Server-Side Request Forgery) protection that blocks connections to private/internal IP ranges"* ([thread](https://forum.cursor.com/t/cannot-connect-to-self-hosted-llm)); Dean Rie, Jan 20 2026: *"BYOK API keys work through Cursor's backend. All requests go through our servers"* ([thread](https://forum.cursor.com/t/use-on-prem-model/149334)). No fix ETA. dario#190 + every other local-proxy project (e.g. [mergd/ccproxy](https://github.com/mergd/ccproxy)) hits the same wall.
>
> **The simple path:** if you want a frictionless setup, use Claude Code, Continue.dev, OpenHands, Aider, Cline, or Zed instead (sections below). Those clients make the outbound call from your machine, so `http://localhost:3456` Just Works — no tunnel required.
>
> **The Cursor path:** expose dario behind a public HTTPS tunnel (cloudflared, ngrok, etc.) so Cursor's backend can reach it. Walkthrough below.

#### 1. Expose dario via a public HTTPS tunnel

In two terminals:

```bash
# Terminal 1 — dario as usual
dario proxy --verbose

# Terminal 2 — cloudflared quick tunnel (free, no signup)
cloudflared tunnel --url http://localhost:3456
# → prints something like https://random-words-here.trycloudflare.com
```

Copy the `https://...trycloudflare.com` URL — you'll paste it into Cursor next.

> **🔐 The tunnel URL is a credential.** `.trycloudflare.com` URLs are unauthenticated by default — anyone who learns the URL can spend your Claude subscription against it. Random subdomains keep casual exposure low-risk, but **don't paste it publicly, and kill the tunnel when you're done.** For anything beyond a quick test:
> - ngrok with `--basic-auth` or a reserved domain + auth, or
> - Named cloudflared tunnels behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/) policies, or
> - dario behind your own VPS reverse proxy with TLS + auth.

#### 2. Configure Cursor

**Cmd/Ctrl + ,** → **Models**. Under the **OpenAI API Key** section:

- Check **Override OpenAI Base URL**: `https://random-words-here.trycloudflare.com/v1` *(your tunnel URL + `/v1`; the checkbox must be enabled, not just the field populated)*
- API key: `dario`
- *(Recent Cursor versions removed the explicit "Verify" button — the green toggle on its own is sufficient.)*

#### 3. Add models — use `anthropic:` (not `claude:`) to keep tool-format intact

Two name gotchas to dodge in this step. Both are about Cursor's behavior, not dario's.

**Gotcha A — built-in name collision.** Cursor recognizes any model name it ships natively (e.g., `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `gpt-5`, `gpt-4o`). Add one of those raw and Cursor pops a *"this model is already available as Opus 4.7"* toast and silently routes it through **its own** Anthropic gateway — billing your Cursor API credits, never reaching the override URL. The Override OpenAI Base URL only takes effect for model names Cursor does **not** recognize as built-ins.

**Gotcha B — Anthropic-format-switcher (matters for Agent mode).** Cursor inspects the model-name string and switches its outbound tool-call format based on substring match. From Cursor staff Dean Rie: *"When Cursor sees a model name like `claude-*`, it switches to a Claude-specific tool-calling format, which isn't compatible with OpenAI-compatible API endpoints"* ([forum thread](https://forum.cursor.com/t/using-byok-in-agent-mode-with-claude-opus-4-5-not-apply-to-file/148018)). So `claude:claude-opus-4-7` (or any name containing `claude-`) makes Cursor send Anthropic-shape tool blocks to the OpenAI-compat `/v1/chat/completions` endpoint — dario's OpenAI-compat handler can't parse those, the model receives a confused tool surface, and you get text-form tool calls in the response instead of structured edits. dario#190 is the canonical case.

Use the [provider prefix](./usage.md#provider-prefix) form that dodges **both** gotchas:

- **Claude** — `anthropic:opus`, `anthropic:sonnet`, `anthropic:haiku` (or full IDs: `anthropic:claude-opus-4-7` / `anthropic:claude-sonnet-4-6` / `anthropic:claude-haiku-4-5`). The `anthropic:` prefix routes through dario's Claude backend identically to `claude:`, but the visible model name doesn't contain the `claude-` substring, so Cursor ships OpenAI-shape `tool_calls` and dario's translator handles them cleanly.
- **OpenAI** *(if you've run `dario backend add openai --key=sk-...`)* — `openai:gpt-4o`, `openai:gpt-5`, `openai:o1`, etc. The `openai:` prefix dodges Cursor's `gpt-*` collision the same way.
- **Other OpenAI-compat backends** *(Groq, OpenRouter, local LiteLLM, Ollama, etc.)* — `groq:llama-3.3-70b`, `openrouter:moonshotai/kimi-k2`, `local:qwen-coder-32b`, etc.

dario v3.36+ resolves `anthropic:opus`/`sonnet`/`haiku` shortcuts to canonical Anthropic model IDs at request time. Older dario versions (≤ v3.35) need the full canonical form: `anthropic:claude-opus-4-7` etc.

> **Older docs / muscle memory note:** earlier versions of this guide recommended the `claude:` prefix. That works fine on tool-less Chat (Gotcha B doesn't fire when no tools are sent) but breaks Agent mode. Prefer `anthropic:` going forward — it's drop-in compatible with every dario version that supports `claude:`.

Select one of the registered models in Cursor's model picker.

#### 4. Use **Agent mode**, not Chat — Chat doesn't pass tools to BYOK models

Cursor's surfaces handle tools differently:

| Surface | Shortcut | Tools forwarded to BYOK? |
|---|---|---|
| Chat (right-pane chat tab) | — | No — chat-only, no `tools` array sent |
| Agent / Composer (Cmd-I) | **Cmd-I** (Mac) / **Ctrl-I** (Windows/Linux) | **Yes** — full `tools` array sent in OpenAI function-calling format |
| Tab Apply (autocomplete) | — | First-party model, BYOK ignored |
| Cmd-K (inline) | Cmd-K / Ctrl-K | Variable; uses its own model selection |

If you point dario at the **Chat** surface, the request body has no `tools` array, but dario still replays Claude Code's full system prompt (which tells the model "you have Bash/Read/Write/Edit/Grep/Glob…") — the model improvises by narrating tool calls in plain text. Same root cause as the *"system instructs me to default to no comments…"* leak: the model is decision-narrating because the wire shape it expected (full agent harness) doesn't match what arrived (plain chat with no tools).

**For agent-style work, open Cmd-I / Ctrl-I (Agent / Composer pane), not the Chat tab.** Pick one of the `anthropic:*` models in the picker and send your request. dario's logs should show the request/response cycle for each tool call, with `tool_use` blocks translated to OpenAI `tool_calls` on the way back to Cursor.

#### 5. Verify

With `dario proxy --verbose` running, send a test message in Cursor's **Agent** pane. You should see:

- A `provider prefix: anthropic:opus → claude backend with model claude-opus-4-6` line in dario's logs
- One or more `POST /v1/chat/completions` lines per turn (one per tool round-trip)
- An incremented request count in `dario doctor --usage`

If dario's logs stay silent and `Usage 5h (all)` stays at `0.0%`, the request never reached the tunnel. Three likely causes:

- **`Access to private networks is forbidden` / `ssrf_blocked` error in Cursor** — you pasted the `localhost:3456` URL, not the tunnel URL. Check step 2.
- **Cursor's name-collision toast fired** — the model name you added matches a Cursor built-in (Gotcha A). Use the `anthropic:` form (step 3).
- **You're testing in Chat, not Agent** — open Cmd-I / Ctrl-I and test there (step 4).

If logs show traffic but the model emits text-form tool calls (`Tool: Read\n{"file_path":...}`) instead of structured calls, you're hitting Gotcha B — your model name still contains `claude-`. Switch to `anthropic:opus` etc. (step 3).

**Why no "Override Anthropic Base URL"?** Cursor doesn't have one. There's a [year-old open feature request](https://forum.cursor.com/t/missing-anthropic-base-url-override-in-cursor-byok/158805) and no plans to ship it. Routing Claude through dario is only possible via the OpenAI-compat path with a prefixed model name as above.

### Continue.dev

In `~/.continue/config.yaml` (or the Continue settings UI, which edits the same file):

```yaml
models:
  - name: Claude Sonnet (dario)
    provider: anthropic
    model: claude-sonnet-4-6
    apiBase: http://localhost:3456
    apiKey: dario
  - name: Claude Opus (dario)
    provider: anthropic
    model: claude-opus-4-7
    apiBase: http://localhost:3456
    apiKey: dario
```

`provider: anthropic` + `apiBase: http://localhost:3456` points Continue's Anthropic SDK path at dario instead of `api.anthropic.com`. dario runs the full Claude Code wire replay on the outbound path.

### Aider

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
aider --model sonnet
```

Aider's Anthropic path honors `ANTHROPIC_BASE_URL` directly. `--model opus`, `--model haiku`, or any explicit `claude-*` model name works.

### Cline / Roo Code / Kilo Code

Cline and its forks use a UI-based "API Provider" dropdown. Pick **Anthropic** as the provider and fill in:

- **API Key**: `dario`
- **Anthropic Base URL**: `http://localhost:3456`
- **Model**: `claude-sonnet-4-6` / `claude-opus-4-7` / `claude-haiku-4-5`

Cline's tool-invocation protocol is XML-based (`<execute_command>`, `<write_to_file>`, etc.), not Anthropic's tool-use format. Dario auto-detects Cline-family clients via system-prompt identity markers and flips into preserve-tools mode automatically — Cline's own tool schema passes through, your commands route back to Cline's parser. No flag required. Override: `--no-auto-detect` if you'd rather force the CC wire shape and deal with the parser mismatch yourself.

### Zed

Zed's Anthropic provider config (`~/.config/zed/settings.json` or Cmd/Ctrl+,):

```json
{
  "language_models": {
    "anthropic": {
      "api_url": "http://localhost:3456",
      "version": "2023-06-01"
    }
  }
}
```

Set the `ANTHROPIC_API_KEY` env var to `dario` before launching Zed. Model picker then shows Claude models routed through your subscription.

### OpenHands

```bash
export LLM_BASE_URL=http://localhost:3456
export LLM_API_KEY=dario
export LLM_MODEL=anthropic/claude-sonnet-4-6
openhands --task "task description"
```

Prefix the model with `anthropic/` so LiteLLM (OpenHands' inner routing layer) knows to hit the Anthropic path, which dario is now fronting.

For a full end-to-end walkthrough — install, battletested model picks, subscription-billing verification, retries, multi-account pool, and the gotchas that bite first-time users — see [`openhands-walkthrough.md`](./openhands-walkthrough.md).

### OpenClaw

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
openclaw "task description"
```

OpenClaw uses the standard `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` env vars. Dario's structural-fallback tool detection auto-translates OpenClaw's `exec` / `process` / `web_search` / `web_fetch` / `browser` / `message` tools to CC's canonical set — no flag required.

**Heads up:** OpenClaw 2026.2.17+ reads `~/.openclaw/agents/main/agent/auth-profiles.json` before checking env vars, so a stale Anthropic key in that file silently overrides `ANTHROPIC_API_KEY=dario`. If you see 401s, see the [auth-profiles entry in faq.md](./faq.md#openclaw-returns-401-after-i-set-dario_api_key-or-upgrade-past-v3306). Dario's default template-replay mode also strips the `openclaw.inbound_meta.v1` classifier-trigger string from your local git context at the proxy boundary, so subscription billing is preserved on OpenClaw-namespaced projects without you doing anything.

For a full end-to-end walkthrough — auth-profiles handling, classifier-filter protection, subscription-billing verification, multi-account pool, and the gotchas that bite first-time users — see [`openclaw-walkthrough.md`](./openclaw-walkthrough.md).

### hands

[hands](https://github.com/askalf/hands) is a sister project to dario — a local computer-use agent that drives your OS through its native shell instead of a screenshot loop. Two modes: Claude Login (uses the `claude` CLI directly, no dario required) and SDK mode (audit-logged, supports `--dry-run`, routes through dario for $0 per task).

```bash
# SDK mode — env vars route the Anthropic SDK through dario
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario

dario proxy --verbose &
hands auth      # pick "API Key", paste: dario
hands run "open notepad and type hello world"
```

Dario v3.33.0+ auto-detects hands via system-prompt identity match and **preserves the Anthropic computer-use beta tools** (`computer`, `bash`, `str_replace_based_edit_tool`) instead of remapping them. No flag required — the `anthropic-beta: computer-use-*` header survives the proxy and the wire shape stays subscription-eligible.

For the full end-to-end walkthrough — both auth modes, audit log, dry-run patterns, voice mode, multi-account pool, and the gotchas that bite first-time users — see [`hands-walkthrough.md`](./hands-walkthrough.md).

### Everything else

If your tool isn't listed, check whether it reads `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` from the environment. Most do. For tools that don't, look in their settings for "Base URL" / "API URL" / "Endpoint" / "OpenAI-compatible endpoint" — all of those map to dario's `http://localhost:3456` (Anthropic-protocol) or `http://localhost:3456/v1` (OpenAI-protocol). If the tool only accepts `https://`, you'll need a loopback TLS shim (out of scope here — open an issue if you need one for a specific tool).

## Custom tool schemas

By default, on the Claude backend, dario replaces your client's tool definitions with the real Claude Code tools (`Bash`, `Read`, `Write`, `Edit`, `Grep`, `Glob`, `WebSearch`, `WebFetch`) and translates parameters back and forth. That's what keeps the request on the CC wire shape, which is what keeps the session on subscription billing instead of per-token API pricing. For the agents listed in the table above, the translation is pre-mapped and runs automatically — nothing to configure.

The trade-off shows up when you're running something that *isn't* in the pre-mapped list and whose tools carry fields CC's schema doesn't have — a `sessionId`, a custom request id, a channel-bound context token, a `confidence` score the model is supposed to emit. Those fields don't survive the round trip.

Symptom: your tool calls come back looking stripped-down, or your runtime complains about a required field being absent *only when routed through dario's Claude backend*.

Fix: run dario with `--preserve-tools`. That skips the CC tool remap entirely, passes your client's tool definitions through to the model unchanged, and lets the model populate every field your schema expects.

```bash
dario proxy --preserve-tools
```

The cost: requests no longer look like CC on the wire, so the subscription-billing wire shape is gone. On a subscription plan, that means the request may be counted against your API usage rather than your subscription quota. Hybrid tool mode below is the compromise that keeps both.

The OpenAI-compat backend is unaffected — it forwards tool definitions byte-for-byte and doesn't need this flag.

## Hybrid tool mode

For the very common case where the "missing" fields on your client's tool are **request context** — `sessionId`, `requestId`, `channelId`, `userId`, `timestamp` — dario can remap to CC tools *and* inject those values on the reverse path. The CC wire shape stays intact, the model still sees only CC's tools (so subscription billing still routes), and your validator still sees the fields it requires because dario fills them from request headers on the way back.

```bash
dario proxy --hybrid-tools
```

**How it works.** On each request, dario builds a `RequestContext` from headers (`x-session-id`, `x-request-id`, `x-channel-id`, `x-user-id`) plus its own generated ids and the current timestamp. After `translateBack` produces the client-shaped tool call on the response path, any field declared on the client's tool schema whose name matches a known context field (`sessionId`/`session_id`, `requestId`/`request_id`, `channelId`/`channel_id`, `userId`/`user_id`, `timestamp`/`created_at`/`createdAt`) and isn't already populated gets filled from the context. Fields the model genuinely populated are never overwritten.

**When to use which flag:**

| Your situation | Flag | Why |
|---|---|---|
| Your agent is listed in the table at the top | *(neither)* | Pre-mapped in `TOOL_MAP`; the default path already handles it. |
| Your custom fields are request context (session/request/channel/user ids, timestamps) | `--hybrid-tools` | Keeps the CC wire shape *and* your validator is satisfied. |
| Your custom fields need the model's reasoning (e.g. `confidence`, `reasoning_trace`, `tool_selection_rationale`) | `--preserve-tools` | The model has to see the real schema to populate these. Accept the CC-wire-shape loss. |
| Your client's tools are already a subset of CC's `Bash/Read/Write/Edit/Grep/Glob/WebSearch/WebFetch` | *(neither)* | Default mode works as-is. |
| You're on a text-tool client (Cline / Kilo Code / Roo Code) and want to override the auto-detect | `--no-auto-detect` (plus `--preserve-tools` or not, your call) | Operator choice outranks the heuristic. |
