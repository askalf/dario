<div align="center">

# `dario`

### Your Claude and ChatGPT subscriptions each work in exactly one place.<br/>dario makes them work **everywhere** — at subscription pricing, not per-token API bills.

<p>
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/v/@askalf/dario?color=6f42c1&label=npm&logo=npm" alt="npm version"></a>
  <a href="https://github.com/askalf/dario/releases"><img src="https://img.shields.io/github/v/release/askalf/dario?color=6f42c1&label=release&logo=github" alt="Latest release"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/ci.yml"><img src="https://github.com/askalf/dario/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/codeql.yml"><img src="https://github.com/askalf/dario/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/askalf/dario"><img src="https://api.scorecard.dev/projects/github.com/askalf/dario/badge" alt="OpenSSF Scorecard"></a>
  <a href="https://www.bestpractices.dev/projects/13638"><img src="https://www.bestpractices.dev/projects/13638/badge" alt="OpenSSF Best Practices"></a>
  <a href="https://github.com/askalf/dario/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@askalf/dario?color=6f42c1" alt="License"></a>
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/dm/@askalf/dario?color=6f42c1" alt="Downloads"></a>
  <a href="https://x.com/ask_alf"><img src="https://img.shields.io/badge/follow-@ask__alf-1da1f2?style=flat-square" alt="Follow on X"></a>
</p>

<p><strong>One local endpoint. Every AI tool you own. The subscriptions you already pay for.</strong></p>

<sub><code>npm i -g @askalf/dario</code> · <strong>0</strong> runtime deps · <a href="https://www.npmjs.com/package/@askalf/dario">SLSA-attested</a> every release · nothing phones home · ~29k lines you can read in a weekend · independent, unofficial, third-party (<a href="DISCLAIMER.md">DISCLAIMER.md</a>)</sub>

<sub>Part of <a href="#own-your-stack"><strong>Own Your Stack</strong></a> — 12 open tools for owning your AI infra: <a href="https://github.com/askalf/truecopy">truecopy</a> · <a href="https://github.com/askalf/strongroom">strongroom</a> · <a href="https://github.com/askalf/fieldpass">fieldpass</a> · <a href="https://github.com/askalf/plumbline">plumbline</a> · <a href="#own-your-stack">full family ↓</a></sub>

</div>

---

> ## 🎉 dario `v6.0` — any client shape, any subscription, and failover between them
>
> Through v5, dario was a Claude proxy that had recently learned to reach a ChatGPT subscription on one path. v6 finishes that: **either subscription can serve either wire shape, and either one can cover for the other.**
>
> - **🔀 Both wire shapes, both plans.** Your ChatGPT plan now answers `/v1/messages`, not just `/v1/chat/completions` — so Claude Code, the Anthropic SDKs and agent runtimes can be served by it without knowing. Your Claude plan already answered both.
> - **🪂 Failover between subscriptions.** `--pool-fallback=gpt-5.6-sol,claude-sonnet-5` is a *chain*: a drained Claude pool is served by ChatGPT, and a rate-limited ChatGPT is handed back to Claude. Two consumer plans, no API keys, and neither one going down takes you with it. → [Failover](#failover-between-subscriptions)
> - **🧪 Shadow compare.** `x-dario-compare: <model>` answers you normally *and* runs the same prompt past the other family, writing both to `~/.dario/compare/`. Which model is better at **your** work, measured on your own traffic. → [Shadow compare](#shadow-compare)
> - **➕ `dario add altman` / `dario add amodei`.** Attach a plan by whose it is.
> - **🩺 `dario doctor` reports failover readiness** — including *armed but INERT*, the state that is green on every other check and cannot actually do anything.
>
> **Upgrading from v5?** Nothing to do — every v6 feature is opt-in and a single-value `--pool-fallback` behaves exactly as it did. [CHANGELOG](CHANGELOG.md#600---2026-08-30)

---

You're already paying $20, $100, or $200 a month for Claude. Then Cursor wants an API key. Aider wants an API key. Cline, Continue, Zed, your scripts — every one of them bills you **again**, per token, while the subscription you already bought sits idle in Claude Code.

**dario is one local endpoint that routes all of them through the Claude subscription you already pay for.** Point any Anthropic- or OpenAI-compatible tool at `http://localhost:3456` and you're done. No per-tool config, no second bill.

```bash
# 1. Install
npm install -g @askalf/dario

# 2. Log in to your Claude subscription (Pro, Max 5x, or Max 20x)
dario login                 # or `dario login --manual` for SSH / headless

# 3. Start the local proxy
dario proxy                 # separate terminal or background

# 4. Point any Anthropic-compat tool at it
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
```

That's the whole setup. Every tool that honors those env vars now runs on your subscription.

**Works with:** Claude Code, Cursor, Aider, Cline, Roo Code, Continue.dev, Zed, Windsurf, OpenHands, OpenClaw, Hermes, Codex CLI, the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), your own scripts.

Add other providers and reuse the same proxy:

```bash
dario backend add openai     --key=sk-proj-...
dario backend add groq       --key=gsk_...    --base-url=https://api.groq.com/openai/v1
dario backend add openrouter --key=sk-or-...  --base-url=https://openrouter.ai/api/v1
dario backend add local      --key=anything   --base-url=http://127.0.0.1:11434/v1

export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Force a specific backend with a model prefix: `openai:gpt-4o`, `claude:opus`, `groq:llama-3.3-70b`, `local:qwen-coder`. Prefer Docker? `ghcr.io/askalf/dario:latest` — multi-arch (`amd64`+`arm64`), published every release ([guide](./docs/docker.md)). Something off? `dario doctor` prints one paste-ready health report.

### The interactive TUI

Type `dario` with no args (in another terminal) for a full-screen control panel — live request stream, per-model burn-rate, rate-limit utilization, billing-bucket breakdown, and an in-place config editor that writes to `~/.dario/config.json`. Subscription accounting you watch happen instead of reading out of log files. Pure ANSI, zero new runtime deps.

```
┌─ dario ─────────────────────────────[ q quit · Tab next · ? help ]──┐
│  Status   Config   ▎Analytics▎   Hits   Accounts   Backends         │
├─────────────────────────────────────────────────────────────────────┤
│  ANALYTICS — last 60 min                                            │
│                                                                     │
│  Requests:       247  (4.1/min)        Tokens in:    142,830        │
│  Tokens out:      38,200               Subscription %:  98%         │
│                                                                     │
│  Per-model:                                                         │
│   opus-5        ████████████░░░░░░░░  60%  (148 req)                │
│   sonnet-5      █████░░░░░░░░░░░░░░░  26%  ( 64 req)                │
│   haiku-4-5     ███░░░░░░░░░░░░░░░░░  14%  ( 35 req)                │
│                                                                     │
│  Rate-limit:                                                        │
│   5h  ████░░░░░░░░░░░░░░░░░░░░░░░░  18%                             │
│   7d  ██░░░░░░░░░░░░░░░░░░░░░░░░░░   8%                             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The money

| Setup | Monthly cost — heavy user |
|---|---|
| Cursor + Anthropic API direct | **$80–$300** |
| Multi-tool heavy use (Cursor + Aider + Cline + Continue), per-token | **$200–$600+** |
| **Any of the above + dario** | **$20–$200 flat** — your existing Pro/Max plan, nothing extra |

One subscription, every tool. Switching providers is a model-name change, not a reconfigure — add a backend once and the same `localhost:3456` speaks OpenAI, Groq, OpenRouter, or a local Ollama too.

---

## What it routes

You point every tool at one URL. dario reads each request, decides which backend owns it, and forwards it in that backend's native protocol.

| Client speaks | Model | Routes to | What happens |
|---|---|---|---|
| Anthropic Messages | `claude-*` / `opus` / `sonnet` / `haiku` | Claude backend | OAuth swap + CC template → `api.anthropic.com` |
| Anthropic Messages | a slug your ChatGPT account lists | Codex backend | Messages→Responses translation, subscription auth |
| Anthropic Messages | `gpt-*`, `llama-*`, … | OpenAI-compat backend | Anthropic→OpenAI translation, forwarded |
| OpenAI Chat | `gpt-*` / `o1-*` / `o3-*` | OpenAI-compat backend | Auth swap, body forwarded byte-for-byte |
| OpenAI Chat | a slug your ChatGPT account lists | Codex backend | chat/completions→Responses translation, subscription auth |
| OpenAI Chat | `claude-*` | Claude backend | OpenAI→Anthropic translation, then Claude path |
| Either | `<provider>:<model>` | Forced by prefix | Explicit override |

The tool doesn't know. The backend doesn't know. dario is the seam.

**The full Claude lineup, autodetected.** Fable 5, Opus 5, Sonnet 5, and Haiku 4.5 — plus `[1m]` long-context variants on every family except haiku — by full id (`claude-opus-5`) or shortcut (`fable` / `opus` / `sonnet` / `haiku`, append `1m` for the long-context form; `opus48` / `opus47` / `opus46` / `sonnet46` pin a specific generation and never float). `GET /v1/models` reads Anthropic's live catalog (TTL-cached, baked fallback when offline), so a new model resolves the day it lands with no dario release, and the model-specific request shape is applied automatically. The TUI's Status tab lists whatever the catalog currently advertises, so it tracks the same set without a release either. Families pulled upstream are filtered from both the live catalog and the fallback so `/v1/models` never advertises a model that 404s — reversible via `DARIO_SUSPENDED_MODELS` if a family is ever pulled again.

---

## ChatGPT subscription accounts (Codex engine)

Your ChatGPT Plus/Pro plan, served on **both** of dario's endpoints — so any client that speaks `/v1/chat/completions` can use it (Codex CLI, the OpenAI SDKs, your own scripts), and so can any client that speaks `/v1/messages` (Claude Code, the Anthropic SDKs, agent runtimes). The harness does not need to know which subscription is behind it.

```bash
dario add altman            # prints an authorize URL; paste the redirect URL back
dario codex list
dario codex remove altman
```

`dario add altman` names whose plan you are attaching; `dario add amodei` attaches a Claude account instead. `dario codex add <name>` is the same command and still works.

The browser lands on a `localhost` page that doesn't load — that's expected, nothing is listening there. Copy the whole address bar and paste it at the prompt; dario reads the code out of it. A bare code (or `code#state`) works too.

Once an account is stored, a request naming a model that account may use is served from the subscription — on either endpoint:

```bash
curl localhost:3456/v1/models | jq -r '.data[].id'
curl localhost:3456/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"hi"}]}'

# same subscription, Anthropic wire shape — this is what Claude Code speaks
curl localhost:3456/v1/messages -H 'content-type: application/json' \
  -d '{"model":"gpt-5.5","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

**Model names are discovered, not hardcoded.** The set a ChatGPT subscription may use is per-account and moves; dario asks the backend which models this account lists, caches the answer, and advertises them on `GET /v1/models` so a client's model picker finds them. Anything not on that list — `gpt-4o` and friends — is untouched and still routes to a configured API-key backend as before. `codex:<model>` / `chatgpt:<model>` forces the route explicitly.

Streaming, tool calls, and tool-result round trips work on both shapes: dario translates chat/completions **or** Messages into the Responses API the subscription backend speaks, and translates the stream back into `chat.completion.chunk` or Anthropic message events to match what the client asked in. There is no `/v1/responses` inbound yet.

**Chat/completions fidelity:** text and `image_url` user-content parts (HTTPS URLs and data URIs) carry through to Responses input items. The Codex subscription backend does not accept every chat field, so `response_format`, `stop`, `n`, `logprobs`, `stream_options`, and other unmapped chat-only fields are intentionally lossy; with `--verbose`, dario reports each dropped field once per process.

Codex accounts live in `~/.dario/codex-accounts/`, entirely separate from the Claude pool. Nothing about `dario login`, `dario accounts`, or Claude routing changes.

---

## Failover between subscriptions

Two consumer plans, no API keys, and neither one able to take you down on its own.

```bash
dario proxy --pool-fallback=gpt-5.6-sol,claude-sonnet-5
```

That is a **chain**, read left to right, and each provider takes the first entry it can actually serve. When the Claude pool is drained or cooling, the request is served as `gpt-5.6-sol` from your ChatGPT subscription. When the subscription is rate-limited or down, the request is handed back to the Claude pool as `claude-sonnet-5`. Every substituted response carries `x-dario-pool-fallback: <model>` — a silently swapped model family is exactly the surprise this project exists to avoid.

A single-entry chain is one-way and means what it always meant, so an existing config is unaffected. Failover is entirely opt-in: without `--pool-fallback`, a drained pool still returns its honest 429/503.

The Claude entry has to be a model the pool can actually serve. "Not a GPT model" is not the same thing, and swapping in a typo would trade a recoverable 429 for an unrecoverable 404 — so each entry is checked positively against the live model catalog and skipped if it fails, letting the real error surface. Canonical ids (`claude-sonnet-5`), long-context variants (`claude-sonnet-5[1m]`), catalog shorthands (`opus`, `sonnet1m`) and explicit provider prefixes (`claude:opus`, `anthropic:sonnet`) all qualify.

Only a **429 or 5xx** fails over. A 400 surfaces to you, because a bad request that fails over just reproduces itself on the other provider and buries the real cause.

`dario doctor` tells you which of these you are actually in:

```
[ OK ]  Failover   symmetric: gpt-5.6-sol → claude-sonnet-5, across 1 Codex account
[WARN]  Failover   armed (gpt-5.6-sol) but INERT — no Codex account and no backend
                   to fall back to. Add one: `dario add altman`
```

That warning is the whole reason the check exists. Armed with nothing to fall back to is green on every other check and incapable of doing anything.

---

## Shadow compare

Once either subscription can serve either wire shape, the interesting question stops being *can I reach GPT* and becomes *which of these is better at my work*. Benchmarks answer that badly. Your own traffic answers it well.

```bash
curl localhost:3456/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-dario-compare: gpt-5.6-sol' \
  -d '{"model":"claude-opus-4-8","max_tokens":1024,"messages":[…]}'
```

You get the Claude answer, exactly as you would have. Beside it, dario runs the same prompt past `gpt-5.6-sol` and writes both to `~/.dario/compare/<timestamp>-<model>.json`, in your own wire shape so you are comparing like with like rather than eyeballing across two formats.

The comparison cannot degrade the request it observes: it only reads bytes already on their way out, your request is never held open for it, and a comparison that fails, times out, or has nowhere to go is dropped with the record still written. Both sides are stored as raw payloads — extracting text is where a bug would quietly make two answers look more alike than they are.

Compares run against a Codex account. Comparing against the Claude pool would occupy a seat for a request nobody is waiting on.

---

## Multi-account pool

**In v5 every dario is a pool** — a plain `dario login` is a pool of one, no separate mode to switch on. One Claude subscription has a ceiling; hold more than one seat — a personal Max and a work Max, a couple of Pros, team seats — and the same `localhost:3456` routes every request to whichever seat has the most headroom, live, per request. A single `dario accounts add` even bootstraps a servable proxy with no `dario login` step:

```bash
dario accounts add work
dario accounts add personal
dario proxy
```

Three things it does that a round-robin doesn't:

- **Per-model headroom routing.** Anthropic meters each model family separately — a `5h` bucket, a `7d` bucket, and a per-model `7d_<family>` bucket. dario reads all of them off every response and routes each request by the bucket that governs it: an Opus call to the seat with Opus room, a Sonnet call to the seat with Sonnet room, independently. Plan tiers mix freely — dario cares about headroom, not tier.
- **Session stickiness.** Claude's prompt cache is scoped to `{account × cache key}`, so rotating a long conversation across seats on headroom alone re-pays cache-create every turn — a **5–10× token-cost multiplier** on the cached portion. dario pins each conversation to one account (hashed from its first message, deterministic) for the life of the session, and rebinds only when that account is exhausted.
- **In-flight 429 failover.** A seat hits its wall mid-request and dario retries the *same request* against the next-best account before your client ever sees an error. The sticky binding follows to the new seat, so the next turn doesn't re-select the cold one.

```
┌─ dario ─────────────────────────────[ q quit · Tab next · ? help ]──┐
│  Status   Config   Analytics   Hits   ▎Accounts▎   Backends         │
├─────────────────────────────────────────────────────────────────────┤
│  ACCOUNTS — 3 pooled · routing by headroom                          │
│                                                                     │
│  work       Max 20x   5h ██░░░░░ 12%   7d ████░░░ 41%   ← next opus │
│  personal   Max 5x    5h █████░░ 78%   7d ██████░ 88%               │
│  side       Pro       5h ░░░░░░░  3%   7d █░░░░░░  9%   ← next sonnet│
│                                                                     │
│  sticky bindings: 4 active    ·    429 failovers (1h): 2            │
└─────────────────────────────────────────────────────────────────────┘
```

`dario accounts {add,list,remove}` from any shell, or provision entirely over HTTP with the headless [admin API](#capabilities) — zero-console Docker / k8s / Pi installs included. Routing internals and the live `/accounts` + `/analytics` endpoints: [`docs/multi-account-pool.md`](./docs/multi-account-pool.md); covered end-to-end by [`test/pool-e2e.mjs`](./test/pool-e2e.mjs).

---

## Overage guard

During normal operation, a subscriber should never see a single response billed outside their subscription pool. If one is, something is wrong — wire-shape drift, an account misconfig, a change upstream — and forwarding more requests in the same shape either bleeds real money (accounts with extra-usage enabled) or returns a wall of rejections. The first hit is the signal; the rest are damage.

So the moment any upstream response bills to something other than your subscription pool, dario **halts the proxy**. The check is an allow-list, not a match on one string: anything that isn't a known subscription claim (`five_hour` / `seven_day` and their fallbacks) and isn't the `unknown` no-header sentinel trips it — so a billing bucket dario has never seen still halts. Subsequent requests return `503` with an Anthropic-shaped error body until you run `dario resume`, press `R` in the TUI, or the cooldown clears (default 30 min). The halt shows across the TUI, fires a best-effort OS notification, and emits named SSE events. Tune it via `~/.dario/config.json` → `overageGuard` or `--overage-behavior=warn` / `--no-overage-guard` / `--overage-cooldown=<ms>`. (In upstream-API-key passthrough mode — `ANTHROPIC_UPSTREAM_API_KEY` — the guard is off; `api` billing is the point there.) Verified end-to-end by [`test/overage-guard-e2e-live.mjs`](./test/overage-guard-e2e-live.mjs). Background: [#288](https://github.com/askalf/dario/issues/288).

---

## Staying current: dario tracks a moving target

Claude Code's request shape changes between releases — new betas, tool renames, per-model thinking configs — usually with no subscriber-facing note. dario doesn't *guess* that shape: it captures it live from your own installed `claude` binary on every startup, diffs it against each upstream release, and replays it byte-for-byte. That's why your subscription routes the same through dario as it does through Claude Code itself — the request that leaves your machine *is* the shape your plan expects. Details: [`docs/wire-fidelity.md`](./docs/wire-fidelity.md) · [#13](https://github.com/askalf/dario/discussions/13) · [#14](https://github.com/askalf/dario/discussions/14).

Keeping that current is the whole job, and it's automated. Three watchers run unattended:

- **npm-release drift** — [`cc-drift-watch.yml`](./.github/workflows/cc-drift-watch.yml) catches each new Claude Code npm release; [`cc-drift-auto-release.yml`](./.github/workflows/cc-drift-auto-release.yml) auto-drafts, merges, and ships within minutes.
- **Same-binary remote-config drift** — [`cc-drift-template-watch.yml`](./.github/workflows/cc-drift-template-watch.yml) runs on a self-hosted runner with a live Claude session (the only place this class is visible) and opens an auto-rebake PR with the diff inline. Anthropic ships changes through Claude Code's *remote config*, not just npm.
- **Rate-map drift** — [`cc-billing-classifier-canary.yml`](./.github/workflows/cc-billing-classifier-canary.yml) sends one live request a day and asserts the response still bills to a subscription bucket.

Guarded by a PR-time compat gate that runs the full suite against a live proxy before any wire-shape change merges, and a liveness alarm if a watcher goes quiet. A few recent changes the watchers caught and shipped fixes for, same-day:

| Change (no subscriber-facing note) | Effect | dario shipped |
|---|---|---|
| `context-1m` dropped from the default beta set on the OAuth path | Subscription requests default to the 200K window on Sonnet/Opus | v3.38.3–4 |
| `thinking: {type:"adaptive"}` gated per-model server-side | Sonnet/Opus 4-5 400 every request through any proxy | [v3.38.5](https://github.com/askalf/dario/pull/273) |
| Per-model `anthropic-beta` sets (opus 10, sonnet 9, haiku 6 — they track the baked base, so counts shift when CC's set does) | Proxies sending one set diverge for non-opus models | [v4.8.53](https://github.com/askalf/dario/pull/478) |

The full ledger lives in the [CHANGELOG](CHANGELOG.md). Setup + walkthrough: [`docs/drift-monitor.md`](./docs/drift-monitor.md). Residual manual cases — OAuth rotation, runner re-registration — are in the [recovery runbook](./docs/recovery.md).

---

## The billing split — a contingency dario is built for

On **2026-05-13** Anthropic [announced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) that, from 2026-06-15, Agent-SDK and `claude -p` (headless) traffic would leave the subscription pool for a small separate monthly credit ($20 / $100 / $200 by plan), then metered API rates. **They paused it before that date** — those surfaces still bill subscription today, and Anthropic says it will give advance notice before any revised version. Nothing changed; no credits were issued.

The split isn't live, but it was announced once on short notice and could return — so dario is built for it either way. Every request is rebuilt into interactive Claude Code shape before it leaves your machine (and, with `--stealth`, the response-correlated timing an interactive session has), so your traffic sits in the subscription pool whether a split is paused or live. The [daily canary](#staying-current-dario-tracks-a-moving-target) is the tripwire: it surfaces a revived split within a day instead of on a surprise invoice. Verify on your own machine right now — `dario doctor --usage` fires one request and prints the rate-limit headers; `representative-claim` should read `five_hour` or `seven_day` (both subscription buckets). Full timeline: [`docs/why-now-2026-06.md`](./docs/why-now-2026-06.md).

---

## Capabilities

- **Multi-account pool.** Several Claude seats behind one endpoint, routed by per-model headroom with sticky-session cache locality and in-flight 429 failover. → [Multi-account pool](#multi-account-pool)
- **Byte-faithful passthrough for real Claude Code.** A genuine CC request already *is* the CC shape, so dario forwards it verbatim — system prompt, tools, thinking, key order untouched — keeping only its billing tag, identity, and cache breakpoints. Covers CC's whole family: the main loop, its Task/Agent sub-agents, and the permission classifier. Non-CC clients get the full template rebuild that keeps them routing. Background: [#678](https://github.com/askalf/dario/issues/678).
- **Headless admin API (`DARIO_ADMIN=1`).** Provision and manage pool accounts entirely over HTTP — start with zero accounts, `POST /admin/login/start`, paste the code back, routable the moment the `200` lands (live hot-reload, no restart). Token-gated even on loopback, audit-logged, rate-limited. Built for Docker / k8s / Pi. → [`docs/admin-api.md`](./docs/admin-api.md)
- **More than one instance, same accounts.** Anthropic's refresh tokens are single-use, so two replicas refreshing the same account leaves one holding a dead token. An optional refresh lock (Redis or Cloudflare backend, same contract, fails open) makes the loser adopt the winner's fresh credentials instead. Safe credential sharing — *not* full HA: rate-limit accounting and sticky routing stay per-instance. → [`docs/multi-instance.md`](./docs/multi-instance.md)
- **Runs any agent.** A 64-entry schema-verified `TOOL_MAP` pre-maps Cline, Roo, Kilo, Cursor, Windsurf, Continue, Copilot, OpenHands, OpenClaw, Hermes, and [hands](https://github.com/askalf/hands) tool names to CC's native set — no flag, no validator errors. MCP tools (`mcp__server__tool`) forward verbatim. [Compatibility matrix](./docs/integrations/compat-matrix.md) · [agent-compat.md](./docs/integrations/agent-compat.md).
- **Behavioral stealth (`--stealth`).** Adds *when* a request arrives to *what* it looks like — response-length-correlated think time and session-start latency. → [`docs/wire-fidelity.md`](./docs/wire-fidelity.md)
- **VPN / egress routing.** Route dario's upstream traffic through a VPN without putting the whole host on one. → [`docs/vpn-routing.md`](./docs/vpn-routing.md)
- **Recover output (`--system-prompt=partial`).** Strips CC's tone/verbosity constraints for 1.2–2.8× more output on open-ended work, without changing which pool you bill to. [#183](https://github.com/askalf/dario/discussions/183) · [`docs/system-prompt.md`](./docs/system-prompt.md)
- **Client-shape overrides.** `--honor-client-thinking` passes a client's own `thinking` block through unchanged; `--preserve-output-format` carries a client's `output_config.format` JSON schema through so structured-output SDKs (e.g. the Vercel AI SDK's `generateObject`) get schema-constrained output. Both off by default.
- **Reachable from inside CC / any MCP client.** `dario subagent install` registers a CC sub-agent for in-session diagnostics; `dario mcp` exposes dario as a read-only MCP server. → [`docs/sub-agent.md`](./docs/sub-agent.md) · [`docs/mcp-server.md`](./docs/mcp-server.md)

---

## Trust & transparency

| Signal | Status |
|---|---|
| Source | **~29k** lines of TypeScript across **59** files — auditable in a weekend (v5 removed shim; the pool is the one code path) |
| Dependencies | **0 runtime.** Verify: `npm ls --production` |
| Provenance | Every release [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions + Sigstore |
| Scanning | [CodeQL](https://github.com/askalf/dario/actions/workflows/codeql.yml) on every push and weekly |
| Tests | **132 test files**, 125 run in parallel by `test/all.test.mjs` (e2e / compat / stealth opt out and have their own entry points) — green on every release |
| Credentials | Your own subscription tokens, never logged, redacted from errors, `0600` on disk in `0700` dirs |
| Network | Binds `127.0.0.1` by default; upstream only to configured backends over HTTPS; hardcoded SSRF allow-list |
| Telemetry | **None.** No analytics, no tracking, nothing phones home |

```bash
npm audit signatures
npm view @askalf/dario dist.integrity
cd $(npm root -g)/@askalf/dario && npm ls --production
```

---

## Honest about what this is

dario uses your own subscription credentials, authenticates you as you, and impersonates nobody. What it changes is the **client** — it rebuilds each request into the exact shape Claude Code emits (captured live from your installed binary) so your plan routes the same no matter which tool actually sent it. Be clear-eyed on both sides of that: it's a transparency tool, in that it documents request behavior Anthropic doesn't publish for subscribers — and it's also, plainly, running through your subscription traffic that Anthropic's own tools bill differently. Both are true. dario is unofficial and unaffiliated ([DISCLAIMER.md](./DISCLAIMER.md)); decide with both in view.

---

## Will my account get suspended?

The most common question about dario, and it deserves a straight answer: **I can't promise you won't be actioned, and I'd be skeptical of anyone who does.** Only Anthropic decides how it enforces its terms. What I can do is lay out exactly how dario works, so you can weigh the risk yourself instead of taking anyone's word for it.

**What dario does:**

- **Runs entirely on your machine.** Your subscription token never touches my servers or anyone else's — requests go straight from your computer to Anthropic.
- **Authenticates as you, with your own Claude login** — the same OAuth credential Claude Code itself uses. It impersonates nobody and shares nothing.
- **Doesn't modify your account, billing, or subscription settings.**
- **Sends requests in the shape the official client sends them** — rebuilt from your own installed binary, not spoofed from a hardcoded fake.
- **Reports nothing, anywhere.** No telemetry, no analytics, nothing phones home — [verifiable in the source](#trust--transparency), which is the point of keeping it auditable in an afternoon.

**What dario does that Claude Code doesn't:** it lets tools *other than* Claude Code use that subscription. That's the whole point of it, and it's also the part that sits outside what Anthropic's own client does. Whether that falls within your plan's terms is Anthropic's call, not mine — read [their terms](https://www.anthropic.com/legal/consumer-terms), read [DISCLAIMER.md](./DISCLAIMER.md), and decide deliberately.

**On policy risk specifically:** Anthropic's position on third-party clients has moved before and can move again. dario is built to surface that fast rather than paper over it — see [The billing split](#the-billing-split--a-contingency-dario-is-built-for) for the contingency already in place and the daily canary watching for it.

Ongoing discussion, including other users' experiences: [#724](https://github.com/askalf/dario/discussions/724).

---

## Who it's for

**Best fit:** developers juggling multiple LLM tools and per-tool API keys · Claude Pro/Max subscribers who want their plan usable everywhere, not just in Claude Code · teams running local/hosted OpenAI-compat servers who want one stable local endpoint · Agent SDK users who want subscription routing with zero code change (`baseURL: 'http://localhost:3456'`) · power users wanting multi-account pooling + 429 failover.

**Not a fit:** you need vendor-managed production SLAs (use the provider APIs) · you want a hosted multi-tenant team platform with dashboards / SSO (dario is a single-owner local proxy) · you want a chat UI (use claude.ai).

---

## Commands

`dario` (TUI) · `login` · `proxy` · `doctor` · `add {altman,amodei}` · `accounts {list,add,remove}` · `backend {list,add,remove}` · `codex {list,add,remove}` · `mcp` · `subagent {install,status,remove}` · `usage` · `config` · `upgrade` · `status` · `refresh` · `resume` · `logout` · `help`

Per-flag reference: [`docs/commands.md`](./docs/commands.md) · env vars grouped by task, for Docker / k8s / systemd: [`docs/configuration.md`](./docs/configuration.md) · SDK examples + per-tool setup: [`docs/usage.md`](./docs/usage.md)

---

## FAQ

**Does this violate Anthropic's terms?**
Mechanically, dario uses your existing Claude Code OAuth tokens — it authenticates you as you, with your subscription, through Anthropic's official endpoints. Whether any particular use complies with current terms is between you and Anthropic; consult their terms and your agreement. Independent, unofficial, third-party — see [DISCLAIMER.md](DISCLAIMER.md). On the suspension question specifically: [Will my account get suspended?](#will-my-account-get-suspended)

**Do I need Claude Code installed?**
Recommended, not required. With CC, `dario login` picks up credentials automatically and the template extractor reads your binary on every startup. Without it, dario runs its own OAuth flow and falls back to the bundled (scrubbed) template snapshot.

**Do I need Bun?**
Optional, recommended — Bun's TLS ClientHello matches CC's runtime. Without it dario works fine; `dario doctor` flags the mismatch and `--strict-tls` hard-fails until resolved.

**Can I use dario without a Claude subscription?**
Yes. Skip `dario login`, run `dario backend add openai --key=…`, and you have a local OpenAI-compat router with no Claude involvement.

**`representative-claim: seven_day` in my headers — am I downgraded?**
No. `five_hour` and `seven_day` are both subscription billing — different accounting buckets, same mode. `overage` is the one that flips you to per-token. [#1](https://github.com/askalf/dario/discussions/1).

**Will the billing split break my setup?**
It was announced, then paused before it took effect — today nothing changed and your traffic still bills subscription. If it returns (Anthropic promised advance notice), dario already rewrites every request to interactive-CC shape, and the daily canary surfaces the change within a day. See [The billing split](#the-billing-split--a-contingency-dario-is-built-for).

Full FAQ: [`docs/faq.md`](./docs/faq.md)

---

## Technical deep dives

- [#183 — Modifying CC's system prompt doesn't change billing; stripping its constraints recovers 1.2–2.8× output](https://github.com/askalf/dario/discussions/183)
- [#68 — dario vs LiteLLM / OpenRouter / Kong AI Gateway (when each wins)](https://github.com/askalf/dario/discussions/68)
- [#14 — Template Replay: why we replay the shape instead of matching signals](https://github.com/askalf/dario/discussions/14)
- [#13 — Claude Code's request shape, documented](https://github.com/askalf/dario/discussions/13)
- [#1 — Rate-limit header analysis](https://github.com/askalf/dario/discussions/1)

---

## Contributing

PRs welcome. Small TypeScript codebase, zero runtime deps. Architecture + file-by-file map in [`CONTRIBUTING.md`](CONTRIBUTING.md).

```bash
git clone https://github.com/askalf/dario && cd dario
npm install
npm run dev    # tsx, no build step
npm test       # 125 suites in parallel via test/all.test.mjs
npm run e2e    # live proxy + OAuth (needs a working Claude backend)
```

Drift and audit runners, none of them part of `npm test`:

```bash
npm run drift:wire    # compare a live CC capture against the baked template
npm run drift:sdk     # Agent-SDK / Stainless pin drift
npm run audit:tui     # drives the real TUI through a fake TTY at 12 geometries
npm run check:overage # overage-classifier check against live headers
npm run stress        # concurrency / queue behaviour under load
npm run cch:calibrate # re-derive the billing-tag cch seed for a new CC build
```

Two easy ways to help beyond code: **star the repo** (the clearest signal this is useful), and **file drift** — open an issue when a rate-limit header flips or a tool that worked yesterday breaks today, and it gets documented in public alongside the fix. Follow [@ask_alf](https://x.com/ask_alf) for drift bulletins as they land.

### Contributors

| Who | Contributions |
|---|---|
| [@GodsBoy](https://github.com/GodsBoy) | Proxy auth, token redaction, error sanitization ([#2](https://github.com/askalf/dario/pull/2)) |
| [@belangertrading](https://github.com/belangertrading) | Billing-classification investigation ([#4](https://github.com/askalf/dario/issues/4), [#6](https://github.com/askalf/dario/issues/6), [#7](https://github.com/askalf/dario/issues/7), [#12](https://github.com/askalf/dario/issues/12), [#23](https://github.com/askalf/dario/issues/23)) |
| [@iNicholasBE](https://github.com/iNicholasBE) | macOS keychain credential detection ([#30](https://github.com/askalf/dario/pull/30)) |
| [@boeingchoco](https://github.com/boeingchoco) | Reverse tool-param translation ([#29](https://github.com/askalf/dario/issues/29)), SSE framing regression catch, hybrid-tool motivation ([#33](https://github.com/askalf/dario/issues/33), [#36](https://github.com/askalf/dario/issues/36)) |
| [@tetsuco](https://github.com/tetsuco) | Scrubber path corruption ([#35](https://github.com/askalf/dario/issues/35)), OpenClaw reverse-mapping collisions ([#37](https://github.com/askalf/dario/issues/37)), 20x-tier report ([#42](https://github.com/askalf/dario/issues/42)) |
| [@mikelovatt](https://github.com/mikelovatt) | Silent subscription-drain surfaced via friendly billing buckets ([#34](https://github.com/askalf/dario/issues/34)) |
| [@ringge](https://github.com/ringge) | `--no-auto-detect` for text-tool auto-preserve ([#40](https://github.com/askalf/dario/issues/40)) |
| [@earlvanze](https://github.com/earlvanze) | OpenClaw tool mappings ([#19](https://github.com/askalf/dario/pull/19)), OAuth manual override ([#47](https://github.com/askalf/dario/pull/47)), HTTPS warning ([#53](https://github.com/askalf/dario/pull/53)) |

---

## Disclaimers

**dario is an independent, unofficial, third-party project.** Not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or any vendor referenced here. Provided as-is, no warranty. You are solely responsible for compliance with your subscription's terms, the security of your credentials, and the content you send through the proxy. Not for safety-critical, regulated, or production environments without your own review. Full text: [DISCLAIMER.md](DISCLAIMER.md).

## License

MIT — see [LICENSE](LICENSE) and [DISCLAIMER.md](DISCLAIMER.md).

## Own Your Stack

dario is the routing layer of **[Own Your Stack](https://github.com/askalf)** — open tools for owning your AI infrastructure instead of renting it by the token. One subscription. Your box. Your terms.

- **[dario](https://github.com/askalf/dario)** — own your routing _(you are here)_
- **[hybrid](https://github.com/askalf/hybrid)** — own your inference
- **[deepdive](https://github.com/askalf/deepdive)** — own your research
- **[hands](https://github.com/askalf/hands)** — own your computer-use
- **[browser-bridge](https://github.com/askalf/browser-bridge)** — own your browser
- **[redstamp](https://github.com/askalf/redstamp)** — own your agent security
- **[truecopy](https://github.com/askalf/truecopy)** — own your agent skills
- **[strongroom](https://github.com/askalf/strongroom)** — own your agent secrets
- **[cordon](https://github.com/askalf/cordon)** — own your prompts
- **[fieldpass](https://github.com/askalf/fieldpass)** — own your agent browser
- **[plumbline](https://github.com/askalf/plumbline)** — own your agent oversight
- **[amnesia](https://github.com/askalf/amnesia)** — own your search
- **[askalf](https://askalf.org)** — own your operation: the AI operation that runs Sprayberry Labs

---

## Built by Thomas Sprayberry

dario is part of **Own Your Stack** — the open toolkit behind **[Sprayberry Labs](https://sprayberrylabs.com)**, the software studio with one human on staff — run by [askalf](https://askalf.org), the AI operation these tools are part of.

Built in the open, scars included. Follow the build → **[@ask_alf](https://x.com/ask_alf)** · **[sprayberrylabs.com/own-your-stack](https://sprayberrylabs.com/own-your-stack)**

---
Part of **[Own Your Stack](https://github.com/askalf)** — own your AI infrastructure instead of renting it. Built by Thomas Sprayberry.
