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

<p align="center"><em>Zero runtime dependencies · <a href="https://www.npmjs.com/package/@askalf/dario">SLSA-attested</a> every release · nothing phones home · ~18.8k lines you can read in a weekend · independent, unofficial, third-party (<a href="DISCLAIMER.md">DISCLAIMER.md</a>)</em></p>

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

Type `dario` with no args (in another terminal) to open a full-screen control panel — live request stream, per-model burn-rate, rate-limit utilization, billing-bucket breakdown, and an in-place config editor that writes to `~/.dario/config.json`. It turns subscription accounting from "log files" into "watch it happen." Pure ANSI, zero new runtime deps. Migrating from v3? See [MIGRATION.md](MIGRATION.md).

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
│   opus-4-8      ████████████████████░  72%  (178 req)               │
│   sonnet-4-6    █████░░░░░░░░░░░░░░░░  22%  ( 54 req)               │
│   haiku-4-5     █░░░░░░░░░░░░░░░░░░░░   6%  ( 15 req)               │
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

Switching providers is a model-name change, not a reconfigure. Add a backend once and the same `localhost:3456` speaks OpenAI, Groq, OpenRouter, or a local Ollama too.

---

## The deadline: 2026-06-15

On **2026-06-15**, Anthropic splits Claude billing in two. Agentic traffic — Agent SDK, `claude -p` headless — stops counting against your subscription pool and gets a separate small monthly credit. [Announced 2026-05-13](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) via Claude's Help Center and a [@ClaudeDevs X post](https://x.com/ClaudeDevs/status/2054610152817619388) — no anthropic.com blog post, no email to most subscribers, no mention in CC release notes.

| Plan | New Agent-SDK / `claude -p` credit | When it runs out |
|---|---|---|
| Pro | $20/mo | extra-usage at API rates **only if enabled**; otherwise suspended until renewal |
| Max 5x | $100/mo | same |
| Max 20x | $200/mo | same |

A sustained Cline or Aider session burns $100 of API-rate tokens in an evening. **Any proxy that forwards requests in their original `claude -p` / Agent-SDK shape — which is most of them — dumps your agentic traffic into that small credit bucket, then onto metered pricing.**

dario doesn't. Every outbound request is rebuilt into **interactive Claude Code wire-shape** before it leaves your machine — headers, body key order, TLS stack, session-id lifecycle, and (`--stealth`) the temporal axis: response-correlated think-time and session-start latency. Anthropic's billing classifier sees an interactive Claude Code session. Your traffic stays in the subscription pool you already pay for.

| Your setup | After 2026-06-15 |
|---|---|
| Any tool → Anthropic API direct | per-token API |
| Any tool → proxy that forwards requests as-is | **$20–200/mo credit, then per-token (or suspended)** |
| **Any tool → dario** | **subscription pool — unchanged** |
| Claude Code, interactive | subscription pool — unchanged |

Same install, same `localhost:3456`, no config change for the cliff. Verify on your own machine: `dario doctor --usage` fires one request and surfaces the rate-limit headers — `representative-claim` should read `five_hour` or `seven_day` (subscription buckets). Full breakdown: [`docs/why-now-2026-06.md`](./docs/why-now-2026-06.md).

---

## The principle dario operates on

Two layers, separated:

1. **Tiered pricing is fine.** Anthropic can charge differently for first-party use vs. third-party use. Every SaaS does this.
2. **Hiding the tier from the customer is not.** When the public docs say "1M context available on Sonnet/Opus" but the auth layer rejects every attempt to access it on the OAuth path most subscribers use — when the billing classifier silently flips your request to overage without saying which signal triggered it — that's information asymmetry weaponized into product design.

Both vendors sell the same two products: a flat-rate subscription and a metered API. OpenAI keeps them physically separate — ChatGPT Plus is chat-only with no API surface; the API is a different product with its own key; you pick one. Anthropic separates them too, but its **subscription** is reached through the *same API-shaped interface* Claude Code uses, and which bucket a request bills to — subscription vs. metered overage — is decided by an **undocumented classifier** reading signals in the request, not by you choosing a product.

dario makes that classifier's inputs explicit. Your identity and auth are real and untouched: it uses your own subscription credentials, impersonates no user, breaks no login. What it changes is the **client** fingerprint — it rebuilds each request into the exact wire shape Claude Code emits (captured live from your installed binary) so the classifier routes it to the subscription pool no matter which tool actually sent it.

Be clear-eyed about what that is. It's a transparency tool in one real sense — it documents and exposes a classifier Anthropic keeps hidden. It's also, plainly, routing through your subscription traffic that Anthropic's gate is built to meter. Both are true. dario is unofficial and unaffiliated ([DISCLAIMER.md](./DISCLAIMER.md)) — decide with both in view.

---

## How it works, and how it stays working

dario doesn't *guess* Claude Code's request shape — it captures it live from your installed `claude` binary on every startup, drift-detects against each upstream CC release, and replays it byte-for-byte. That's why the billing classifier can't tell the difference. Deep dive: [`docs/wire-fidelity.md`](./docs/wire-fidelity.md).

**What the classifier reads.** [Discussion #13](https://github.com/askalf/dario/discussions/13) documents eight binary signals identified via MITM capture + binary RE + controlled A/B testing with a real Max 5x subscriber. It's rule-based, not ML — transitions are sharp; same input flips to the same output 100% of the time across 6 A/B trials:

| Signal | Claude Code value | Non-CC value |
|---|---|---|
| `output_config.effort` | CC-scale level — CC default `xhigh`; dario sends `max` (both subscription-verified) | omitted / off-scale → reclassified |
| `max_tokens` | `64000` | other → reclassified |
| `thinking` shape | `{type: "adaptive"}` *(per-model)* | `{enabled, budget_tokens: N}` → reclassified |
| System prompt block count | exactly 3 | other → reclassified |
| Tool names | `Bash`, `Read`, `Write`, `Edit`, … | non-CC names → reclassified |
| Per-request billing tag | rolling SHA-256 | missing/static → reclassified |
| JSON field order | specific stable order | different → reclassified |
| Non-CC body fields (`temperature`, `top_p`, `service_tier`) | absent | present → reclassified |

[Discussion #178](https://github.com/askalf/dario/discussions/178) reproduces a ninth fingerprint operating on commit metadata: the classifier fires on the literal namespaced string `openclaw.inbound_meta.v1` in recent git commits. dario's template replay protects you because that git context never reaches `api.anthropic.com` — only dario's captured CC template does.

**Why this needs constant maintenance.** The 2026-06-15 split is announced; the wire-shape changes that arrive between releases are not. CC v2.1.142 ([changelog](https://code.claude.com/docs/en/changelog), 2026-05-14) itemized a Fast-mode tweak and some fixes — and said **nothing** about three wire-shape changes in the same release:

| Silent change in v2.1.142 | Effect on subscribers | dario shipped |
|---|---|---|
| `context-1m-2025-08-07` dropped from the default beta set + rejected on OAuth auth | Subscription users lose >200K context on Sonnet/Opus | v3.38.3–4 (2026-05-14/15) |
| `thinking: {type:"adaptive"}` gated per-model server-side | Sonnet/Opus 4-5 through any proxy 400s every request | [v3.38.5](https://github.com/askalf/dario/pull/273) — 2026-05-15 |
| `TodoWrite`/`TodoRead` replaced by the `Task*` family, no migration note | Clients hardcoding `todo_*` send unrecognized tools | [v3.38.6](https://github.com/askalf/dario/pull/274) — 13 min later |

And it gets subtler: v4.2.1 (2026-05-17) shipped receipts for **same CC binary, different wire output 24 hours apart** — Anthropic ships changes through CC's *remote configuration*, not just npm releases. So dario runs **three classes of drift detection**, all auto-detecting and auto-PR'ing:

- **Class A — npm-release drift.** [`cc-drift-watch.yml`](./.github/workflows/cc-drift-watch.yml) (hourly, github-hosted) catches each new CC npm release; [`cc-drift-auto-release.yml`](./.github/workflows/cc-drift-auto-release.yml) auto-drafts, merges, and ships within minutes.
- **Class B — same-binary remote-config drift** *(v4.2.2)*. [`cc-drift-template-watch.yml`](./.github/workflows/cc-drift-template-watch.yml) (every 30 min, self-hosted runner with an authenticated CC install) captures live and **opens an auto-rebake PR** with a unified-line diff inline. The only way to catch this class — github-hosted has no Pro/Max session to capture from.
- **Class C — classifier-rule drift** *(v4.6.0)*. [`cc-billing-classifier-canary.yml`](./.github/workflows/cc-billing-classifier-canary.yml) sends one live request daily and asserts the `representative-claim` header still maps to a subscription bucket — catches Anthropic changing the *rules* while the wire shape is unchanged.
- **Guards on the guards.** A [PR-time compat gate](./.github/workflows/compat-test-self-hosted.yml) *(v4.3.0)* runs the full compat suite against a live proxy before any wire-shape PR merges; a [liveness alarm](./.github/workflows/cc-drift-watcher-liveness.yml) *(v4.4.2)* fires if the Class-B watcher goes quiet for 8h. Setup + walkthrough: [`docs/drift-monitor.md`](./docs/drift-monitor.md).

**Anthropic doesn't publish a wire-level changelog for subscribers. dario is one.**

---

## What it routes

You point every tool at one URL. dario reads each request, decides which backend owns it, forwards in that backend's native protocol.

| Client speaks | Model | Routes to | What happens |
|---|---|---|---|
| Anthropic Messages | `claude-*` / `opus` / `sonnet` / `haiku` | Claude backend | OAuth swap + CC template replay → `api.anthropic.com` |
| Anthropic Messages | `gpt-*`, `llama-*`, … | OpenAI-compat backend | Anthropic→OpenAI translation, forwarded |
| OpenAI Chat | `gpt-*` / `o1-*` / `o3-*` | OpenAI-compat backend | Auth swap, body forwarded byte-for-byte |
| OpenAI Chat | `claude-*` | Claude backend | OpenAI→Anthropic translation, then Claude path |
| Either | `<provider>:<model>` | Forced by prefix | Explicit override |

The tool doesn't know. The backend doesn't know. dario is the seam.

---

## Overage guard

A subscriber should never see a single `representative-claim: overage` response during normal operation. One means something is wrong — wire-shape drift, a classifier change, an account misconfig — and continuing to forward requests in the same shape bleeds real money (accounts with extra-usage enabled) or returns a wall of rejections (accounts without it). The first hit is the signal; the second through hundredth are damage.

So the moment any upstream response carries `representative-claim: overage`, dario **halts the proxy**. Every subsequent request returns `503` with an Anthropic-shaped error body the client surfaces verbatim, until you run `dario resume`, press `R` on the TUI, or the cooldown clears (default 30 min). The halt is visible across the TUI's Status, Hits, and Analytics tabs, fires a best-effort native OS notification, and emits named SSE events.

```
┌─ dario ─────────────────────────────[ q quit · Tab next · ? help ]──┐
│  ▎Status▎  Config   Analytics   Hits   Accounts   Backends         │
├─────────────────────────────────────────────────────────────────────┤
│  Overage-guard                                                      │
│  ⚠ HALTED   overage detected 12s ago                                │
│    Request:        claude-opus-4-8  account=work                    │
│    Cause:          representative-claim = overage                   │
│    Auto-resume in  29m 48s                                          │
│    Manual resume   press R here, or `dario resume` from any shell   │
└─────────────────────────────────────────────────────────────────────┘
```

Tune via `~/.dario/config.json` → `overageGuard`, or CLI flags: `--overage-behavior=warn` (visibility-only), `--no-overage-guard` (off), `--overage-cooldown=<ms>`. Verified end-to-end by [`test/overage-guard-e2e-live.mjs`](./test/overage-guard-e2e-live.mjs) — a real in-process proxy driven through the five-stage halt cycle over real HTTP. Background: [#288](https://github.com/askalf/dario/issues/288).

---

## Capabilities

- **Multi-account pool.** Drop 2+ Claude accounts in `~/.dario/accounts/` and pool mode auto-activates: every request routes to the account with the most headroom, multi-turn sessions pin to one account so the prompt cache survives, in-flight 429s fail over to a peer before your client sees an error. → [`docs/multi-account-pool.md`](./docs/multi-account-pool.md)
- **Behavioral stealth (`--stealth`).** Static wire fidelity covers *what* the request looks like; `--stealth` adds *when* it arrives — response-length-correlated think time and 1.2–4.2s session-start latency, the inter-arrival pattern real interactive sessions have and agent loops don't. → [`docs/wire-fidelity.md`](./docs/wire-fidelity.md)
- **Runs any non-Claude-Code agent.** A 64-entry schema-verified `TOOL_MAP` pre-maps Cline, Roo, Kilo, Cursor, Windsurf, Continue, Copilot, OpenHands, OpenClaw, Hermes, [hands](https://github.com/askalf/hands) tool names to CC's native set. No flag, no validator errors. → [`docs/integrations/agent-compat.md`](./docs/integrations/agent-compat.md)
- **Recover output capability.** `dario proxy --system-prompt=partial` strips CC's tone/verbosity/no-comments constraints for 1.2–2.8× more output on open-ended work — empirically without flipping billing (the classifier doesn't read that slot). [Discussion #183](https://github.com/askalf/dario/discussions/183) has the per-prompt receipts. → [`docs/system-prompt.md`](./docs/system-prompt.md)
- **Honor client thinking (`--honor-client-thinking`).** By default dario rebuilds the outbound request with CC's interactive thinking shape regardless of what the client sent. Pass this flag (or `DARIO_HONOR_CLIENT_THINKING=1`) to pass a non-CC client's own `thinking` block through unchanged. Off by default; the rebuild-to-CC path is what keeps the subscription pool routing.
- **Reachable from inside CC / any MCP client.** `dario subagent install` registers a CC sub-agent for in-session diagnostics; `dario mcp` exposes dario as a read-only MCP server. → [`docs/sub-agent.md`](./docs/sub-agent.md) · [`docs/mcp-server.md`](./docs/mcp-server.md)
- **Shim mode** *(deprecated v4.2, removal scheduled v5.x)*. The original "no HTTP hop" path empirically matched only 3 of the 8 classifier axes and fell back to passthrough for the 1-block system prompts `claude -p` and the Agent SDK both send. Use **proxy mode** for any non-CC client — it's the only mode that rebuilds every request to CC's full canonical shape.

---

## Trust & transparency

| Signal | Status |
|---|---|
| Source | **~18.8k** lines of TypeScript across **44** files — auditable in a weekend |
| Dependencies | **0 runtime.** Verify: `npm ls --production` |
| Provenance | Every release [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions + Sigstore |
| Scanning | [CodeQL](https://github.com/askalf/dario/actions/workflows/codeql.yml) on every push and weekly |
| Tests | **84 test files**, **77 in the default `npm test` suite** (`test/all.test.mjs`) — green on every release |
| Drift response | hourly [`cc-drift-watch.yml`](./.github/workflows/cc-drift-watch.yml) + auto-publish on merge — median CC-release → dario-release under one hour |
| Credentials | Never logged, redacted from errors, `0600` on disk in `0700` dirs; MCP server redacts at the tool boundary |
| Network | Binds `127.0.0.1` by default; upstream only to configured backends over HTTPS; hardcoded SSRF allowlist |
| Telemetry | **None.** No analytics, no tracking, no data collection |

```bash
npm audit signatures
npm view @askalf/dario dist.integrity
cd $(npm root -g)/@askalf/dario && npm ls --production
```

---

## Project status — stable surface, automated defense

dario's surface is feature-complete and stable: the proxy, the TUI, the multi-account pool, the overage guard, the 2026-06-15 cliff protection. What *isn't* stable is the thing it defends against. Anthropic ships wire-shape and classifier changes with no subscriber changelog, on no schedule — so the part of dario that runs unattended is the part that keeps your subscription routing the day they do, and it runs every day.

That defense is live: [three drift watchers](#how-it-works-and-how-it-stays-working) (npm-release hourly, remote-config every 30 min, classifier-rule daily), a PR-time compat gate that runs the full suite against a live proxy before any wire-shape change merges, a liveness alarm if a watcher goes quiet, a daily NPM_TOKEN health check, and an auto-release pipeline that median-ships a fix under an hour after a CC release. When Anthropic moves, the watchers catch it within a release cycle, the bot opens the PR, the maintainer reviews and merges — the receipt log above is that machinery doing its job. Residual manual cases — OAuth rotation, runner re-registration, ghcr backfill — live in the [recovery runbook](./docs/recovery.md).

New *product* work happens on the [askalf platform](https://askalf.org), a self-hosted AI workforce built on dario. dario itself doesn't need new features — it has one job, and keeping the truth about a moving target current is a job that never stops.

---

## Who it's for

**Best fit:** developers juggling multiple LLM tools and per-tool API keys · Claude Pro/Max subscribers who want their plan usable everywhere, not just in Claude Code · teams running local/hosted OpenAI-compat servers who want one stable local endpoint · Agent SDK users who want OAuth-subscription routing with zero code change (`baseURL: 'http://localhost:3456'`) · power users wanting multi-account pooling + 429 failover.

**Not a fit:** you need vendor-managed production SLAs (use the provider APIs) · you want a hosted, multi-tenant team platform with dashboard / SSO / audit logs (that's the [askalf platform](https://askalf.org), shipping soon) · you want a chat UI (use claude.ai).

---

## Commands

`dario` (TUI) · `login` · `proxy` · `doctor` · `accounts {list,add,remove}` · `backend {list,add,remove}` · `shim` · `mcp` · `subagent {install,status,remove}` · `usage` · `config` · `upgrade` · `status` · `refresh` · `resume` · `logout` · `help`

Full flag/env reference: [`docs/commands.md`](./docs/commands.md) · SDK examples + per-tool setup: [`docs/usage.md`](./docs/usage.md)

---

## FAQ

**Does this violate Anthropic's terms?**
Mechanically, dario uses your existing Claude Code OAuth tokens — it authenticates you as you, with your subscription, through Anthropic's official endpoints. Whether any particular use complies with current terms is between you and Anthropic; consult their terms and your agreement. Independent, unofficial, third-party — see [DISCLAIMER.md](DISCLAIMER.md).

**Do I need Claude Code installed?**
Recommended, not required. With CC, `dario login` picks up credentials automatically and the live template extractor reads your binary on every startup. Without it, dario runs its own OAuth flow and falls back to the bundled (scrubbed) template snapshot.

**Do I need Bun?**
Optional, recommended — Bun's TLS ClientHello matches CC's runtime. Without it dario works fine; `dario doctor` flags the mismatch and `--strict-tls` hard-fails until resolved.

**Can I use dario without a Claude subscription?**
Yes. Skip `dario login`, run `dario backend add openai --key=…`, and you have a local OpenAI-compat router with no Claude involvement.

**`representative-claim: seven_day` in my headers — am I downgraded?**
No. `five_hour` and `seven_day` are both subscription billing — different accounting buckets, same mode. `overage` is the one that flips you to per-token. [Discussion #1](https://github.com/askalf/dario/discussions/1).

**Will the 2026-06-15 split break my setup? / What if Anthropic ships another silent change?**
No, and it's caught automatically — see [The deadline](#the-deadline-2026-06-15) and [How it stays working](#how-it-works-and-how-it-stays-working). dario rewrites every request to interactive-CC shape before it reaches `api.anthropic.com`, and the three-class drift watcher picks up new changes (npm-release hourly, remote-config every 30 min, classifier-rule daily). v3.38.5 + v3.38.6 — 13 minutes apart, same day as v2.1.142's silent drops — are the prior art.

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
npm test       # 77 test files via test/all.test.mjs, green on every release
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

- **Star the repo.** The most legible public signal that this matters.
- **Install + run.** Every active install is one more subscriber routing their already-paid-for plan through their own infrastructure.
- **File drift.** Open an issue when your rate-limit header flips, when a tool that worked yesterday breaks today, when a CC release lands without a wire-level note. It gets documented in public alongside the fix.
- **Share the install line.** The next Cursor/Aider/Cline user quietly paying their second bill.

Follow [@ask_alf](https://x.com/ask_alf) for drift bulletins as they happen.

---

## Disclaimers

**dario is an independent, unofficial, third-party project.** Not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or any vendor referenced here. Provided as-is, no warranty. You are solely responsible for compliance with your subscription's terms, the security of your credentials, and the content you send through the proxy. Not for safety-critical, regulated, or production environments without your own review. Full text: [DISCLAIMER.md](DISCLAIMER.md).

## License

MIT — see [LICENSE](LICENSE) and [DISCLAIMER.md](DISCLAIMER.md).

## Also by askalf

| Project | What it does |
|---|---|
| [askalf platform](https://askalf.org) | Self-hosted AI workforce — agents that run real business + life work. Uses dario as its LLM substrate. *Shipping soon.* |
| [hands](https://github.com/askalf/hands) | Cross-platform computer-use agent — your LLM on your mouse, keyboard, and screen. Routes through dario or any Anthropic-compat. |
| [deepdive](https://github.com/askalf/deepdive) | Local research agent. One command, cited answer. Plan → search → headless fetch → extract → synthesize. |
| [agent](https://github.com/askalf/agent) | Connect any device to an askalf fleet — runs the shell or Claude Code tasks the fleet dispatches. |
| [browser-bridge](https://github.com/askalf/browser-bridge) | Stealth headless Chromium in a container, CDP on 9222. Playwright / Puppeteer / MCP-compatible. |
| [claude-sync](https://github.com/askalf/claude-sync) | Sync Claude Code sessions across machines via a portable `.ccsync` file. |
| [pgflex](https://github.com/askalf/pgflex) | One Postgres API, two modes — real PostgreSQL for production, PGlite (WASM) for dev. |
| [redisflex](https://github.com/askalf/redisflex) | One Redis API, two modes — ioredis for production, in-process for dev. Includes a BullMQ-shaped in-memory queue. |


---

## Built by Sprayberry Labs

This is one of the open-source building blocks from **[Sprayberry Labs](https://sprayberrylabs.com)** — an independent studio (Atlanta, GA) that ships bespoke software and **fixed-price code & security audits**, delivered with the AI workforce these tools are part of.

**Got a codebase that needs an expert read?** → **[Scan a repo — free mini-audit](https://sprayberrylabs.com)**, or see the **$1,500 fixed-price Audit** and build Sprints. · [sprayberrylabs.com](https://sprayberrylabs.com) · hello@sprayberrylabs.com
