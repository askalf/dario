<p align="center">
  <h1 align="center">dario</h1>
  <p align="center"><strong>Your Claude Pro/Max subscription works in exactly one place: Claude Code.<br>dario makes it work everywhere — at subscription pricing, not per-token API bills.</strong></p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/v/@askalf/dario?color=blue" alt="npm version"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/ci.yml"><img src="https://github.com/askalf/dario/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/codeql.yml"><img src="https://github.com/askalf/dario/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="https://github.com/askalf/dario/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@askalf/dario" alt="License"></a>
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/dm/@askalf/dario" alt="Downloads"></a>
  <a href="https://x.com/ask_alf"><img src="https://img.shields.io/badge/follow-@ask_alf-1da1f2?style=flat-square" alt="Follow on X"></a>
</p>

<p align="center"><em>Zero runtime dependencies · <a href="https://www.npmjs.com/package/@askalf/dario">SLSA-attested</a> every release · nothing phones home · ~17.5k lines you can read in a weekend · independent, unofficial, third-party (<a href="DISCLAIMER.md">DISCLAIMER.md</a>)</em></p>

---

You're already paying $20, $100, or $200 a month for Claude. Then Cursor wants an API key. Aider wants an API key. Cline, Continue, Zed, your scripts — every one of them bills you **again**, per token, while the subscription you already bought sits idle in Claude Code.

**dario is one local endpoint that routes all of them through the Claude subscription you already pay for.** Point any Anthropic- or OpenAI-compatible tool at `http://localhost:3456` and you're done. No per-tool config, no second bill.

And — increasingly — dario is the only layer that keeps your subscription doing what it did yesterday. **Anthropic ships restrictions to subscribers through wire-shape changes that don't appear in any user-facing changelog.** dario detects those changes within the hour, ships fixes within minutes, and rebuilds your tool's request into the shape Claude Code's billing classifier expects. Receipts below.

```bash
npm install -g @askalf/dario
dario login          # uses your existing Claude Code credentials
dario proxy          # start the server (separate terminal or background)
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
```

That's the whole setup. Every tool that honors those env vars now runs on your subscription.

**New in v4:** type `dario` (no args) in another terminal to open the interactive TUI — live request stream, per-model burn-rate, rate-limit utilization, and a config editor that writes to `~/.dario/config.json`. Migrating from v3? See [MIGRATION.md](MIGRATION.md).

```
┌─ dario v4 ──────────────────────────[ q quit · Tab next · ? help ]──┐
│  Status   Config   ▎Analytics▎   Hits   Accounts   Backends         │
├─────────────────────────────────────────────────────────────────────┤
│  ANALYTICS — last 60 min                                            │
│                                                                     │
│  Requests:       247  (4.1/min)        Tokens in:    142,830        │
│  Tokens out:      38,200               Subscription %:  98%         │
│  Avg latency:    1,234 ms                                           │
│                                                                     │
│  Per-model:                                                         │
│   opus-4-7      ████████████████████░  72%  (178 req)               │
│   sonnet-4-6    █████░░░░░░░░░░░░░░░░  22%  ( 54 req)               │
│   haiku-4-5     █░░░░░░░░░░░░░░░░░░░░   6%  ( 15 req)               │
│                                                                     │
│  Rate-limit:                                                        │
│   5h  ████░░░░░░░░░░░░░░░░░░░░░░░░  18%                             │
│   7d  ██░░░░░░░░░░░░░░░░░░░░░░░░░░   8%                             │
└─────────────────────────────────────────────────────────────────────┘
```

```
┌─ dario v4 ──────────────────────────[ q quit · Tab next · ? help ]──┐
│  Status   Config   Analytics   ▎Hits▎   Accounts   Backends         │
├─────────────────────────────────────────────────────────────────────┤
│  HITS — live · 3,142 buffered                                       │
│                                                                     │
│   time      model           in     out    lat     st                │
│ ▎18:42:01  opus-4-7         842    216    1.2s   200                │
│   18:42:03  sonnet-4-6      1.2k   480    0.8s   200                │
│   18:42:05  haiku-4-5       120    24     0.3s   200                │
│   18:42:07  opus-4-7        2.4k   900    3.1s   200                │
│ ─────────────────────────────────────────────────────────────────── │
│  Selected: 18:42:01  req_011Cb52VKMBsB6z6w28NvMn                    │
│    Account:         default                                         │
│    Model:           claude-opus-4-7                                 │
│    Billing bucket:  subscription                                    │
│    Tokens:          in 842 / out 216 / cache-read 6.2k              │
│    Util at request: 5h 18%  ·  7d 8%                                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The money

| Setup | Monthly cost — heavy user |
|---|---|
| Cursor + Anthropic API direct | **$80–$300** |
| Multi-tool heavy use (Cursor + Aider + Cline + Continue), per-token | **$200–$600+** |
| **Any of the above + dario** | **$20–$200 flat** — your existing Pro/Max plan, nothing extra |

Switching providers is a model-name change, not a reconfigure: `claude-opus-4-7`, `gpt-4o`, `llama-3.3-70b`, anything on OpenRouter/Groq/Ollama. Add a backend once (`dario backend add openai --key=…`) and the same `localhost:3456` speaks OpenAI too.

---

## The deadline: 2026-06-15

On **2026-06-15**, Anthropic splits Claude billing in two. Agentic traffic — Agent SDK, `claude -p` headless — stops counting against your subscription pool and gets a separate small monthly credit. [Announced 2026-05-13](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) via Claude's Help Center and a [@ClaudeDevs X post](https://x.com/ClaudeDevs/status/2054610152817619388) — no anthropic.com blog post, no email to most subscribers, no mention in CC release notes.

| Plan | New Agent-SDK / `claude -p` credit | When it runs out |
|---|---|---|
| Pro | $20/mo | extra-usage at API rates **only if enabled**; otherwise suspended until renewal |
| Max 5x | $100/mo | same |
| Max 20x | $200/mo | same |

A sustained Cline or Aider session burns $100 of API-rate tokens in an evening. **Any proxy that forwards requests in their original `claude -p` / Agent-SDK shape — which is most of them — dumps your agentic traffic into that small credit bucket, then onto metered pricing.**

dario doesn't. Every outbound request is rebuilt into **interactive Claude Code wire-shape** before it leaves your machine — headers, body key order, TLS stack, session-id lifecycle, and (v3.38+, `--stealth`) the temporal axis: response-correlated think-time and session-start latency. Anthropic's billing classifier sees an interactive Claude Code session. Your traffic stays in the subscription pool you already pay for.

| Your setup | After 2026-06-15 |
|---|---|
| Any tool → Anthropic API direct | per-token API |
| Any tool → proxy that forwards requests as-is | **$20–200/mo credit, then per-token (or suspended)** |
| **Any tool → dario** | **subscription pool — unchanged** |
| Claude Code, interactive | subscription pool — unchanged |

Same install, same `localhost:3456`, no config change for the cliff. Verify on your own machine: `dario doctor --usage` fires one request and surfaces the rate-limit headers — `representative-claim` should read `five_hour` or `seven_day` (subscription buckets). Full breakdown: [`docs/why-now-2026-06.md`](./docs/why-now-2026-06.md).

---

## What Anthropic shipped this month. What dario shipped same-day.

The 2026-06-15 split is announced. The wire-shape changes that arrive between releases are not. This is the cadence:

**Claude Code v2.1.142 ([changelog](https://code.claude.com/docs/en/changelog), 2026-05-14)** — itemizes a Fast-mode default change, MCP timeout fixes, plugin path fixes, terminal display tweaks, a stale model-name removal. Says **nothing** about these three wire-shape changes that landed in the same release:

| What changed in v2.1.142 (silent) | Effect on subscribers | dario detected | dario shipped |
|---|---|---|---|
| `context-1m-2025-08-07` dropped from default `anthropic-beta` header set, and the beta is categorically rejected on OAuth subscription auth | Subscription users lose >200K context on Sonnet/Opus. Anthropic docs at [platform.claude.com/docs/en/build-with-claude/context-windows](https://platform.claude.com/docs/en/build-with-claude/context-windows) still list 1M context as available for these models with no OAuth caveat. | hourly drift watcher | v3.38.3 (re-bake) + v3.38.4 (compat range) — 2026-05-14/15 |
| `thinking: {type: "adaptive"}` gated per-model server-side — only Opus/Sonnet 4-6+ accept; older 4-5 models 400 with `"adaptive thinking is not supported on this model"` | Anyone targeting Sonnet 4-5 or Opus 4-5 through any proxy 400s every request until they remove the field | live-probe matrix (this session) | **v3.38.5** — published 2026-05-15T21:20:22Z ([PR #273](https://github.com/askalf/dario/pull/273)) |
| `TodoWrite` / `TodoRead` removed from the tool catalog; replaced by the `Task*` family (TaskCreate, TaskGet, TaskList, TaskOutput, TaskStop, TaskUpdate) — no migration note | Any client that hardcoded the `todo_*` names now sends tools the server doesn't recognize | template re-bake | **v3.38.6** — published 2026-05-15T21:33:44Z ([PR #274](https://github.com/askalf/dario/pull/274)) |

**Three undisclosed wire-shape changes in one CC release. Three dario releases the same evening, 13 minutes apart.** The interactive Claude Code TUI is what makes this visible to you in real time — Hits tab shows the request shape going out, the rate-limit bucket coming back, and dario's auto-retry decision in between. v4.0.0 went live 2026-05-16T11:46:01Z; the drift cadence is the same as it's been since v3.22.

[`.github/workflows/cc-drift-watch.yml`](./.github/workflows/cc-drift-watch.yml) (cron `0 * * * *`) checks each new CC npm release for differences in the captured wire shape and auto-drafts a fix PR. [`.github/workflows/cc-drift-auto-release.yml`](./.github/workflows/cc-drift-auto-release.yml) merges and ships within minutes. **Anthropic doesn't publish a wire-level changelog for subscribers. dario is one.**

---

## What the billing classifier actually does

[Discussion #13](https://github.com/askalf/dario/discussions/13) documents eight binary signals identified via MITM capture + binary RE + controlled A/B testing with a real Max 5x subscriber. The classifier is rule-based, not ML — transitions are sharp; same input flips to the same output 100% of the time across 6 A/B trials:

| Signal | Claude Code value | Non-CC value |
|---|---|---|
| `output_config.effort` | `medium` (CC default) | other → reclassified |
| `max_tokens` | `64000` | other → reclassified |
| `thinking` shape | `{type: "adaptive"}` *(per-model — see drift table above)* | `{enabled, budget_tokens: N}` → reclassified |
| System prompt block count | exactly 3 | other → reclassified |
| Tool names | `Bash`, `Read`, `Write`, `Edit`, … (CC's set) | non-CC names → reclassified |
| Per-request billing tag | rolling SHA-256 | missing/static → reclassified |
| JSON field order | specific stable order | different → reclassified |
| Non-CC body fields (`temperature`, `top_p`, `service_tier`) | absent | present → reclassified |

[Discussion #178](https://github.com/askalf/dario/discussions/178) reproduces an additional fingerprint that operates on commit metadata: Anthropic's classifier fires on the literal namespaced string `openclaw.inbound_meta.v1` in recent git commits — the kind of identifier that would only appear in code integrating with a specific competitor's API. Verified 22 hours after [Theo posted on X](https://x.com/theo/status/2049645973350363168) with four diagnostic test variants. Same JSON shape with a different namespace name doesn't trigger. dario's template replay protects users from this filter because the git context never reaches `api.anthropic.com` — only dario's captured CC template does.

Reclassification flips the request from `five_hour` (your subscription) to `overage` (per-token). On accounts without overage credit enabled, the request hard-fails with `400: "You're out of extra usage."` — a message that's, charitably, hard to debug if you didn't know your traffic was being reclassified in the first place.

---

## Does it actually work?

Four LLMs reviewed the codebase cold, same prompt ([`reviews/PROMPT.md`](./reviews/PROMPT.md)), each signed a verdict:

> "Not vibe-coded; it reads like production-grade infrastructure that happens to be open-source." — **Grok 4** ([full](./reviews/grok-4-2026-04-21.md))
>
> "The implementation isn't just a simple header swap; it is a sophisticated request-level deepfake." — **Gemini 2.0 Pro** ([full](./reviews/gemini-2-pro-2026-04-21.md))
>
> "Not 'best-effort mimicry'; it's capture-and-replay of a real client." — **GPT-5.3** ([full](./reviews/gpt-5.3-2026-04-21.md))
>
> "The fingerprint-replay claim is backed by the code." — **Claude Opus 4.7** ([full](./reviews/claude-opus-4-7-2026-04-21.md))

The mechanism: dario doesn't *guess* Claude Code's request shape — it captures it live from your installed `claude` binary on every startup, drift-detects against each upstream CC release, and replays it byte-for-byte. That's why the billing classifier can't tell the difference. Deep dive: [`docs/wire-fidelity.md`](./docs/wire-fidelity.md).

---

## 30 seconds, in full

```bash
# 1. Install
npm install -g @askalf/dario

# 2. Log in to your Claude subscription (Pro, Max 5x, or Max 20x)
dario login                 # or `dario login --manual` for SSH / headless

# 3. Start the local proxy in one terminal
dario proxy

# 4. (Optional, recommended) Open the interactive TUI in another terminal
dario                       # tabs: Status / Config / Analytics / Hits / Accounts / Backends

# 5. Point any Anthropic-compat tool at the proxy
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
```

Works with: Claude Code, Cursor, Aider, Cline, Roo Code, Continue.dev, Zed, Windsurf, OpenHands, OpenClaw, Hermes, Codex CLI, the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), your own scripts.

Add other providers and reuse the same proxy:

```bash
dario backend add openai     --key=sk-proj-...
dario backend add groq       --key=gsk_...    --base-url=https://api.groq.com/openai/v1
dario backend add openrouter --key=sk-or-...  --base-url=https://openrouter.ai/api/v1
dario backend add local      --key=anything   --base-url=http://127.0.0.1:11434/v1

export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Force a specific backend with a model prefix: `openai:gpt-4o`, `claude:opus`, `groq:llama-3.3-70b`, `local:qwen-coder`.

Prefer Docker? `ghcr.io/askalf/dario:latest` — multi-arch (`amd64`+`arm64`), published every release. Guide: [`docs/docker.md`](./docs/docker.md).

Something off? `dario doctor` prints one paste-ready health report. Or open the TUI's Status tab.

---

## What it actually does

You point every tool at one URL. Dario reads each request, decides which backend owns it, forwards in that backend's native protocol.

| Client speaks | Model | Routes to | What happens |
|---|---|---|---|
| Anthropic Messages | `claude-*` / `opus` / `sonnet` / `haiku` | Claude backend | OAuth swap + CC template replay → `api.anthropic.com` |
| Anthropic Messages | `gpt-*`, `llama-*`, … | OpenAI-compat backend | Anthropic→OpenAI translation, forwarded |
| OpenAI Chat | `gpt-*` / `o1-*` / `o3-*` | OpenAI-compat backend | Auth swap, body forwarded byte-for-byte |
| OpenAI Chat | `claude-*` | Claude backend | OpenAI→Anthropic translation, then Claude path |
| Either | `<provider>:<model>` | Forced by prefix | Explicit override |

The tool doesn't know. The backend doesn't know. Dario is the seam.

---

## Capabilities

- **Interactive TUI (v4).** `dario` with no args opens a full-screen control panel: live request stream, per-model burn-rate, rate-limit utilization bars, billing bucket breakdown, in-place config editor that writes to `~/.dario/config.json`. The visible interface that turns subscription accounting from "log files" into "watch it happen."
- **Hourly drift detection.** [`cc-drift-watch.yml`](./.github/workflows/cc-drift-watch.yml) checks each new CC npm release for changes in the captured wire shape (system prompt content, tool catalog, header set, body field order, beta flags), auto-drafts a fix PR, auto-merges on CI green. Median time from CC release → dario release is under one hour. The receipt: this week's three v3.38.x releases shipped within hours of CC v2.1.142.
- **Multi-account pool.** Drop 2+ Claude accounts in `~/.dario/accounts/` and pool mode auto-activates: every request routes to the account with the most headroom, multi-turn sessions pin to one account so the prompt cache survives, in-flight 429s fail over to a peer before your client sees an error. `dario accounts add work` / `dario accounts add personal`. → [`docs/multi-account-pool.md`](./docs/multi-account-pool.md)
- **Behavioral stealth (`--stealth`).** Static wire fidelity covers *what* the request looks like; `--stealth` adds *when* it arrives — response-length-correlated think time and 1.2–4.2s session-start latency, the inter-arrival pattern real interactive sessions have and agent loops don't. → [`docs/wire-fidelity.md`](./docs/wire-fidelity.md)
- **Runs any non-Claude-Code agent.** A 64-entry schema-verified `TOOL_MAP` pre-maps Cline, Roo, Kilo, Cursor, Windsurf, Continue, Copilot, OpenHands, OpenClaw, Hermes, [hands](https://github.com/askalf/hands) tool names to CC's native set. No flag, no validator errors. → [`docs/agent-compat.md`](./docs/agent-compat.md)
- **Shim mode.** Take the proxy off the wire entirely — `dario shim -- claude --print "hi"` patches `globalThis.fetch` in-process. No HTTP hop, no port, no `BASE_URL`. → [`docs/shim.md`](./docs/shim.md)
- **Recover output capability.** `dario proxy --system-prompt=partial` strips CC's tone/verbosity/no-comments constraints for 1.2–2.8× more output on open-ended work — empirically without flipping billing (the classifier doesn't read that slot). [Discussion #183](https://github.com/askalf/dario/discussions/183) has the per-prompt receipts. → [`docs/system-prompt.md`](./docs/system-prompt.md)
- **Reachable from inside CC / any MCP client.** `dario subagent install` registers a CC sub-agent for in-session diagnostics; `dario mcp` exposes dario as a read-only MCP server. → [`docs/sub-agent.md`](./docs/sub-agent.md) · [`docs/mcp-server.md`](./docs/mcp-server.md)

---

## Trust & transparency

| Signal | Status |
|---|---|
| Source | **17,507** lines of TypeScript across **42** files — auditable in a weekend |
| Dependencies | **0 runtime.** Verify: `npm ls --production` |
| Provenance | Every release [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions + Sigstore (v4.0.0 published 2026-05-16T11:46:01Z; Rekor logIndex `1553210791`) |
| Scanning | [CodeQL](https://github.com/askalf/dario/actions/workflows/codeql.yml) on every push and weekly |
| Tests | **2,080** assertions across 77 test files (71 in default `npm test` suite) — green on every release |
| Drift response | [`cc-drift-watch.yml`](./.github/workflows/cc-drift-watch.yml) hourly cron, [`cc-drift-auto-release.yml`](./.github/workflows/cc-drift-auto-release.yml) auto-publish on merge — median CC-release → dario-release under one hour |
| Credentials | Never logged, redacted from errors, `0600` on disk in `0700` dirs; MCP server redacts at the tool boundary |
| Network | Binds `127.0.0.1` by default; upstream only to configured backends over HTTPS; hardcoded SSRF allowlist |
| Telemetry | **None.** No analytics, no tracking, no data collection |

```bash
npm audit signatures
npm view @askalf/dario dist.integrity
cd $(npm root -g)/@askalf/dario && npm ls --production
```

---

## Who it's for

**Best fit:** developers juggling multiple LLM tools and per-tool API keys · Claude Pro/Max subscribers who want their plan usable everywhere, not just in Claude Code · teams running local/hosted OpenAI-compat servers who want one stable local endpoint · Agent SDK users who want OAuth-subscription routing with zero code change (`baseURL: 'http://localhost:3456'`) · power users wanting multi-account pooling + 429 failover on their own machine.

**Not a fit:** you need vendor-managed production SLAs (use the provider APIs) · you need a hosted multi-tenant platform with a dashboard and team auth (that's the [askalf platform](https://askalf.org)) · you want a chat UI (use claude.ai).

---

## Commands

`dario` (TUI) · `login` · `proxy` · `doctor` · `accounts {list,add,remove}` · `backend {list,add,remove}` · `shim` · `mcp` · `subagent {install,status,remove}` · `usage` · `config` · `upgrade` · `status` · `refresh` · `logout` · `help`

Full flag/env reference: [`docs/commands.md`](./docs/commands.md) · SDK examples + per-tool setup: [`docs/usage.md`](./docs/usage.md)

---

## FAQ

**Does this violate Anthropic's terms?**
Mechanically, dario uses your existing Claude Code OAuth tokens — it authenticates you as you, with your subscription, through Anthropic's official endpoints. Whether any particular use complies with current terms is between you and Anthropic; consult their terms and your agreement. Independent, unofficial, third-party — see [DISCLAIMER.md](DISCLAIMER.md).

**What does the v4 TUI actually do?**
Open `dario` with no args. Six tabs: **Status** shows proxy health + OAuth expiry + config source; **Config** edits `~/.dario/config.json` in place (bool toggles inline, numbers/strings open a prompt, `s` saves); **Analytics** polls `/analytics` every 2s and renders per-model bars + rate-limit utilization + billing buckets; **Hits** subscribes to `/analytics/stream` SSE for the live request feed with per-record detail drilldown; **Accounts** lists the pool; **Backends** lists OpenAI-compat backends. Pure ANSI, zero new runtime deps. Migration from v3: [MIGRATION.md](MIGRATION.md).

**Do I need Claude Code installed?**
Recommended, not required. With CC, `dario login` picks up credentials automatically and the live template extractor reads your binary on every startup. Without it, dario runs its own OAuth flow and falls back to the bundled (scrubbed) template snapshot.

**Do I need Bun?**
Optional, recommended — Bun's TLS ClientHello matches CC's runtime. Without it dario works fine; `dario doctor` flags the mismatch and `--strict-tls` hard-fails until resolved.

**Can I use dario without a Claude subscription?**
Yes. Skip `dario login`, `dario backend add openai --key=…`, and you have a local OpenAI-compat router with no Claude involvement.

**`representative-claim: seven_day` in my rate-limit headers — am I downgraded?**
No. `five_hour` and `seven_day` are both subscription billing — different accounting buckets, same mode. `overage` is the one that flips you to per-token. [Discussion #1](https://github.com/askalf/dario/discussions/1).

**Will the 2026-06-15 split break my dario setup?**
No — see [The deadline](#the-deadline-2026-06-15) above. dario rewrites every request to interactive-CC shape before it reaches `api.anthropic.com`; the classifier sees interactive CC, not `claude -p`/Agent SDK, regardless of the local tool.

**What if Anthropic ships another silent change tomorrow?**
The hourly drift watcher picks it up, auto-drafts a fix PR, and ships if CI passes. This week's v3.38.5 and v3.38.6 — both released within 13 minutes of each other, both same-day fixes for v2.1.142's silent drops — are the receipts. The TUI's Hits tab shows you the request shape in real time, so you'll see drift the moment it happens on your machine.

Full FAQ: [`docs/faq.md`](./docs/faq.md)

---

## Technical deep dives

- [#183 — CC's system prompt: modifying it doesn't change billing; stripping its constraints recovers 1.2–2.8× output](https://github.com/askalf/dario/discussions/183)
- [#178 — Reproduced: Anthropic's billing classifier fingerprints `openclaw.inbound_meta.v1`](https://github.com/askalf/dario/discussions/178)
- [#68 — dario vs LiteLLM / OpenRouter / Kong AI Gateway (when each wins)](https://github.com/askalf/dario/discussions/68)
- [#39 — Your Claude Max usage is burning in minutes — the four fixes that work](https://github.com/askalf/dario/discussions/39)
- [#14 — Template Replay: why we stopped matching signals](https://github.com/askalf/dario/discussions/14)
- [#13 — Claude Code's "defaults" are detection signals, not optimizations](https://github.com/askalf/dario/discussions/13)
- [#1 — Rate-limit header analysis](https://github.com/askalf/dario/discussions/1)

---

## Contributing

PRs welcome. Small TypeScript codebase, zero runtime deps. Architecture + file-by-file map in [`CONTRIBUTING.md`](CONTRIBUTING.md).

```bash
git clone https://github.com/askalf/dario && cd dario
npm install
npm run dev    # tsx, no build step
npm test       # 2,080 assertions, 71 suites
npm run e2e    # live proxy + OAuth (needs a working Claude backend)
```

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

## Be part of the receipt log

Anthropic doesn't publish a wire-level changelog for subscribers. The dario repo is the closest thing that exists. Every silent change Anthropic ships, the drift watcher catches; every fix dario ships, the public record gets longer. That accumulating record is what makes the asymmetry visible to the next subscriber who can't explain why their burn rate spiked.

How to contribute to that record:

- **Star the repo.** GitHub stars are the most legible public signal that this matters. If you've felt the burn-rate spike, the rejection from extra-usage you didn't sign up for, the 1M context yanked from your plan with no notice — a star is the cheapest receipt to file.
- **Install + run.** Every active install is one more subscriber routing their already-paid-for plan through their own infrastructure instead of through whatever the next silent change does.
- **Run a pool.** Two accounts in `~/.dario/accounts/`, headroom-aware routing, 429 failover. Subscriptions are designed for one user; pool mode makes them resilient.
- **File drift.** Open an issue when your rate-limit header flips, when a tool you used yesterday breaks today, when a CC release lands without a wire-level note. We document it in public alongside the fix.
- **Share the install line.** Slack channel, group chat, the next Cursor/Aider/Cline user who's quietly paying their second bill. Pricing-aware proxying is a baseline subscriber capability, not a privilege.

Follow [@ask_alf](https://x.com/ask_alf) for drift bulletins as they happen.

---

## Disclaimers

**dario is an independent, unofficial, third-party project.** Not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or any vendor referenced here. Provided as-is, no warranty. You are solely responsible for compliance with your subscription's terms, the security of your credentials, and the content you send through the proxy. Not for safety-critical, regulated, or production environments without your own review. Full text: [DISCLAIMER.md](DISCLAIMER.md).

## License

MIT — see [LICENSE](LICENSE) and [DISCLAIMER.md](DISCLAIMER.md).

## Also by askalf

| Project | What it does |
|---|---|
| [arnie](https://github.com/askalf/arnie) | Portable IT troubleshooting companion — networking, AD, package managers, log triage |
| [browser-bridge](https://github.com/askalf/browser-bridge) | Stealth headless Chromium in a container, CDP on 9222 |
| [claude-bridge](https://github.com/askalf/claude-bridge) | Bridge Claude Code sessions to Discord |
| [deepdive](https://github.com/askalf/deepdive) | Local research agent — plan → search → fetch → synthesize, cited answers |
| [git-providers](https://github.com/askalf/git-providers) | Unified GitHub + GitLab + Bitbucket Cloud clients behind one interface |
| [hands](https://github.com/askalf/hands) | Cross-platform computer-use agent — mouse, keyboard, screen |
| [install-kit](https://github.com/askalf/install-kit) | curl-pipe-bash template for self-hosted Docker apps |
| [pgflex](https://github.com/askalf/pgflex) | One Postgres API, two modes (real PG ↔ PGlite WASM) |
