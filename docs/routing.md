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

---

[← README](../README.md) · [all reference docs](../README.md#reference)
