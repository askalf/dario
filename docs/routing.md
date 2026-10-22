# What it does with a request

You point every tool at one URL. dario reads each request, decides which plan or backend owns it, and forwards it in that backend's native protocol.

| Client speaks | Model | Routes to | What happens |
|---|---|---|---|
| Anthropic Messages | `claude-*` / `opus` / `sonnet` / `haiku` | Claude pool | OAuth swap + Claude Code template, then `api.anthropic.com` |
| Anthropic Messages | a slug your ChatGPT account lists | Codex engine | Messages→Responses translation, subscription auth |
| Anthropic Messages | `gpt-4o`, `llama-*`, any name no plan lists | Refused | `400` + `x-dario-upstream-rejection: model_unroutable`; reach an API-key backend from this shape with a provider prefix |
| OpenAI Chat | `gpt-*` / `o1-*` / `o3-*` / `o4-*` | OpenAI-compat backend | Auth swap, body forwarded byte-for-byte |
| OpenAI Chat | a slug your ChatGPT account lists | Codex engine | chat/completions→Responses translation, subscription auth |
| OpenAI Chat | `claude-*` | Claude pool | OpenAI→Anthropic translation, then the Claude path |
| Either | `<provider>:<model>` | Forced by prefix | Explicit override |

The tool doesn't know. The backend doesn't know. dario is the seam.

**The full Claude lineup, autodetected.** Fable 5, Opus 5.5, Opus 5, Sonnet 5 and Haiku 4.5, plus `[1m]` long-context variants on every family except Haiku, by full id (`claude-opus-5-5`) or shortcut (`fable` / `opus` / `sonnet` / `haiku`; append `1m` for the long-context form; `opus5` / `opus48` / `opus47` / `opus46` / `sonnet46` pin a generation and never float). `GET /v1/models` reads Anthropic's live catalog (TTL-cached, baked fallback offline), so a new model resolves the day it lands with no dario release, and the model-specific request shape is applied automatically. Families pulled upstream are filtered from both the live catalog and the fallback, so `/v1/models` never advertises a model that 404s. A name no provider lists at all, such as a ChatGPT slug your account doesn't have or a typo that belongs to no family, is refused locally with `400` and `x-dario-upstream-rejection: model_unroutable` instead of spending a pool request on an upstream 404. The guard steps aside for `claude-*` names (Anthropic's own 404 stays authoritative there), for requests under a `--model` / `--fast-model` override, for upstream-API-key mode, and for the legacy OpenAI names the built-in map translates.

## MiniMax API-key backend

`dario backend add minimax --key=<api-key>` uses `https://api.minimax.io/v1`.
Use the name `minimax-cn` for `https://api.minimax.cn/v1`, or pass `--base-url`
to keep a custom endpoint. This uses the existing single compatible-backend
slot; it does not add a second simultaneously active API-key backend. Restart
the proxy after changing its backend. With no subscription account, start it
with `dario proxy --no-claude-auth`.

On a direct MiniMax endpoint, model `minimax` on `/v1/chat/completions` selects
`MiniMax-M3.1-Flash`; on a custom gateway, `minimax` is that gateway's own model id and the request goes to the gateway with the name unchanged.
Direct endpoints advertise `MiniMax-M3.1-Flash` followed by `MiniMax-M3` in
`/v1/models`; either full ID routes directly. Use `minimax:<model>` for an
explicit legacy or custom ID, or `--model=minimax:MiniMax-M3.1-Flash` for a server-wide Flash
override. Custom gateways retain their own IDs and are not assigned a direct
MiniMax catalog. This API-key route supports Chat Completions, not Messages.

Request fields and streamed responses pass through unchanged. Flash defaults
to adaptive thinking and `reasoning_effort: "max"` upstream; it accepts `low`,
`medium`, `high`, `xhigh`, and `max`. Do not send `thinking.type: "disabled"`,
`reasoning_effort: "none"`, `service_tier`, or `reasoning_split: false` to Flash.
M3 also accepts disabled thinking. The proxy does not rewrite explicit settings
or remove image/video content parts, tool calls, or reasoning history.
See the [MiniMax API reference](https://platform.minimax.io/docs/api-reference/text-openai-api).

---

[← README](../README.md) · [all reference docs](../README.md#reference)
