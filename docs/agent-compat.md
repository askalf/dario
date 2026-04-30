# Agent compatibility

Dario's built-in `TOOL_MAP` carries **~66 schema-verified entries** covering the tool schemas of every major coding agent. On the Claude backend, tool calls translate to CC's native `Bash / Read / Write / Edit / Glob / Grep / WebSearch / WebFetch` on the outbound path (so the request stays on the subscription wire shape) and rebuild to your agent's exact expected shape on the inbound path (so your validator is happy). No flag required.

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

1. **Cmd/Ctrl + ,** to open Settings → **Models**
2. Under the **OpenAI API Key** section:
   - Check **Override OpenAI Base URL**: `http://localhost:3456/v1`
   - API key: `dario`
3. Under the **Model Names** section (or the Add Model button):
   - Add `claude-sonnet-4-6`
   - Add `claude-opus-4-7` (premium)
   - Add `claude-haiku-4-5` (cheap)
4. Select one of the new models in the chat input's model picker.

Cursor now routes those model names through dario → your Claude subscription (Pro / Max 5x / Max 20x). `gpt-*` and `o*` model names still route through Cursor's default OpenAI path — dario doesn't interfere with non-Claude traffic unless you point Cursor's base URL at it exclusively.

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
python -m openhands.core.main -t "task description"
```

Prefix the model with `anthropic/` so LiteLLM (OpenHands' inner routing layer) knows to hit the Anthropic path, which dario is now fronting.

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
