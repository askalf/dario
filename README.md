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

<p align="center"><em>Zero runtime dependencies · <a href="https://www.npmjs.com/package/@askalf/dario">SLSA-attested</a> every release · nothing phones home · ~13k lines you can read in a weekend · independent, unofficial, third-party (<a href="DISCLAIMER.md">DISCLAIMER.md</a>)</em></p>

---

You're already paying $20, $100, or $200 a month for Claude. Then Cursor wants an API key. Aider wants an API key. Cline, Continue, Zed, your scripts — every one of them bills you **again**, per token, while the subscription you already bought sits idle in Claude Code.

**dario is one local endpoint that routes all of them through the Claude subscription you already pay for.** Point any Anthropic- or OpenAI-compatible tool at `http://localhost:3456` and you're done. No per-tool config, no second bill.

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
┌─ dario v4.0.0 ───────────────[ q quit · ? help · Tab next panel ]┐
│  Status   Config   ▎Analytics▎   Hits   Accounts   Backends      │
├──────────────────────────────────────────────────────────────────┤
│  Analytics — last 60 min                                         │
│                                                                  │
│  Requests:        247  (4.1/min)                                 │
│  Tokens in:    142,830                                           │
│  Tokens out:    38,200                                           │
│                                                                  │
│  Per-model:                                                      │
│   opus-4-7    ████████████████████░  72%                         │
│   sonnet-4-6  █████░░░░░░░░░░░░░░░░  22%                         │
│                                                                  │
│  Rate-limit:                                                     │
│   5h ████░░░░░░░░░░░░░░░░░░░░░░  18%                             │
│   7d ██░░░░░░░░░░░░░░░░░░░░░░░░   8%                             │
└──────────────────────────────────────────────────────────────────┘
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

On **2026-06-15**, Anthropic splits Claude billing in two. Agentic traffic — Agent SDK, `claude -p` headless — stops counting against your subscription and gets a small fixed monthly credit instead:

| Plan | New Agent-SDK / `claude -p` credit | After it's gone |
|---|---|---|
| Pro | $20/mo | per-token API pricing |
| Max 5x | $100/mo | per-token API pricing |
| Max 20x | $200/mo | per-token API pricing |

A sustained Cline or Aider session burns $100 of API-rate tokens in an evening. **Any proxy that forwards requests in their original `claude -p` / Agent-SDK shape — which is most of them — dumps your agentic traffic into that small credit bucket, then onto metered pricing.**

dario doesn't. Every outbound request is rebuilt into **interactive Claude Code wire-shape** before it leaves your machine — headers, body key order, TLS stack, session-id lifecycle, and (v3.38, `--stealth`) the temporal axis: response-correlated think-time and session-start latency. Anthropic's billing classifier sees an interactive Claude Code session. Your traffic stays in the subscription pool you already pay for.

| Your setup | After 2026-06-15 |
|---|---|
| Any tool → Anthropic API direct | per-token API |
| Any tool → proxy that forwards requests as-is | **$20–200/mo credit, then per-token** |
| **Any tool → dario** | **subscription pool — unchanged** |
| Claude Code, interactive | subscription pool — unchanged |

Same install, same `localhost:3456`, no config change for the cliff. Verify on your own machine: `dario doctor --usage` fires one request and surfaces the rate-limit headers — `representative-claim` should read `five_hour` or `seven_day` (subscription buckets). Full breakdown + post-cliff verification: [`docs/why-now-2026-06.md`](./docs/why-now-2026-06.md).

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

# 3. Start the local proxy
dario proxy

# 4. Point any Anthropic-compat tool at it
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

Something off? `dario doctor` prints one paste-ready health report.

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

- **Multi-account pool.** Drop 2+ Claude accounts in `~/.dario/accounts/` and pool mode auto-activates: every request routes to the account with the most headroom, multi-turn sessions pin to one account so the prompt cache survives, in-flight 429s fail over to a peer before your client sees an error. `dario accounts add work` / `dario accounts add personal`. → [`docs/multi-account-pool.md`](./docs/multi-account-pool.md)
- **Behavioral stealth (`--stealth`).** Static wire fidelity covers *what* the request looks like; `--stealth` adds *when* it arrives — response-length-correlated think time and 1.2–4.2s session-start latency, the inter-arrival pattern real interactive sessions have and agent loops don't. → [`docs/wire-fidelity.md`](./docs/wire-fidelity.md)
- **Runs any non-Claude-Code agent.** A 66-entry schema-verified `TOOL_MAP` pre-maps Cline, Roo, Kilo, Cursor, Windsurf, Continue, Copilot, OpenHands, OpenClaw, Hermes, [hands](https://github.com/askalf/hands) tool names to CC's native set. No flag, no validator errors. → [`docs/agent-compat.md`](./docs/agent-compat.md)
- **Shim mode.** Take the proxy off the wire entirely — `dario shim -- claude --print "hi"` patches `globalThis.fetch` in-process. No HTTP hop, no port, no `BASE_URL`. → [`docs/shim.md`](./docs/shim.md)
- **Recover output capability.** `dario proxy --system-prompt=partial` strips CC's tone/verbosity/no-comments constraints for ~1.2–2.8× output on open-ended work — empirically without flipping billing (the classifier doesn't read that slot; RLHF safety is in the weights, not the prompt). → [`docs/system-prompt.md`](./docs/system-prompt.md)
- **Reachable from inside CC / any MCP client.** `dario subagent install` registers a CC sub-agent for in-session diagnostics; `dario mcp` exposes dario as a read-only MCP server. → [`docs/sub-agent.md`](./docs/sub-agent.md) · [`docs/mcp-server.md`](./docs/mcp-server.md)

---

## Trust & transparency

| Signal | Status |
|---|---|
| Source | ~13,170 lines of TypeScript, 28 files — auditable in a weekend |
| Dependencies | **0 runtime.** Verify: `npm ls --production` |
| Provenance | Every release [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions + sigstore |
| Scanning | [CodeQL](https://github.com/askalf/dario/actions/workflows/codeql.yml) on every push and weekly |
| Tests | ~1,535 assertions across 57 suites — green on every release |
| Credentials | Never logged, redacted from errors, `0600` on disk; MCP server redacts at the tool boundary |
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

`dario login` · `proxy` · `doctor` · `accounts {list,add,remove}` · `backend {list,add,remove}` · `shim` · `mcp` · `subagent {install,status,remove}` · `usage` · `config` · `upgrade` · `status` · `refresh` · `logout` · `help`

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
Yes. Skip `dario login`, `dario backend add openai --key=…`, and you have a local OpenAI-compat router with no Claude involvement.

**`representative-claim: seven_day` in my rate-limit headers — am I downgraded?**
No. `five_hour` and `seven_day` are both subscription billing — different accounting buckets, same mode. `overage` is the one that flips you to per-token. [Discussion #1](https://github.com/askalf/dario/discussions/1).

**Will the 2026-06-15 split break my dario setup?**
No — see [The deadline](#the-deadline-2026-06-15) above. dario rewrites every request to interactive-CC shape before it reaches `api.anthropic.com`; the classifier sees interactive CC, not `claude -p`/Agent SDK, regardless of the local tool.

Full FAQ: [`docs/faq.md`](./docs/faq.md)

---

## Technical deep dives

- [#183 — CC's 27kB system prompt: modifying it doesn't change billing; stripping its constraints recovers 1.2–2.8× output](https://github.com/askalf/dario/discussions/183)
- [#178 — Anthropic's billing classifier fingerprints `openclaw.inbound_meta.v1`](https://github.com/askalf/dario/discussions/178)
- [#68 — dario vs LiteLLM / OpenRouter / Kong AI Gateway (when each wins)](https://github.com/askalf/dario/discussions/68)
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
npm test       # ~1,535 assertions, 57 suites
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

> **dario is the open-source wedge of [askalf](https://askalf.org)** — the AI workforce platform we're building. Dario solves the Claude subscription problem so the rest of the workforce runs on flat-rate billing. Star the repo or follow [@ask_alf](https://x.com/ask_alf) for platform updates.

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
| [redisflex](https://github.com/askalf/redisflex) | One Redis API, two modes (ioredis ↔ in-process) |
