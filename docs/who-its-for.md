# Who it's for

**Best fit:** developers juggling multiple LLM tools and per-tool API keys · Claude Pro/Max subscribers who want their plan usable everywhere, not just in Claude Code · ChatGPT Plus/Pro subscribers who want their plan in OpenAI-compatible harnesses · teams running local or hosted OpenAI-compat servers who want one stable local endpoint · Agent SDK users who want subscription routing with zero code change · power users wanting multi-account pooling with 429 failover.

**Not a fit:** you need vendor-managed production SLAs (use the provider APIs) · you want a hosted multi-tenant team platform with dashboards and SSO (dario is a single-owner local proxy) · you want a chat UI (use claude.ai).

**How it compares.** Only one of these routes a consumer subscription; the others route API keys, and that is the whole split.

| Tool | What it is | When it wins |
|---|---|---|
| **dario** | Local proxy that routes your Claude and ChatGPT plans, plus any OpenAI-compatible API | You already pay for a plan and want every tool on your machine to use it |
| **LiteLLM** | Python SDK + proxy, 100+ providers via API keys, enterprise features | You have API keys, want central spend controls, or run a hosted multi-tenant service |
| **OpenRouter** | Hosted aggregator, one API key for hundreds of models | You want model breadth and are fine with pay-per-token |
| **Kong AI Gateway** | Enterprise on-prem API gateway for LLMs | You already run Kong and need AI traffic under the same governance |

Longer version, with specifics: [#68](https://github.com/askalf/dario/discussions/68).

---

[← README](../README.md) · [all reference docs](../README.md#reference)
