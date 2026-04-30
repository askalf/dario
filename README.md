<p align="center">
  <h1 align="center">dario</h1>
  <p align="center"><strong>Use your Claude Pro/Max subscription with Cursor, Aider, Cline, Zed, the Claude Agent SDK — any tool that speaks Anthropic or OpenAI.</strong></p>
  <p align="center">A local LLM router. One endpoint, every provider. Your Claude subscription — Pro ($20), Max 5x ($100), or Max 20x ($200) — stops sitting idle in Claude Code while you pay per-token everywhere else. Speaks both the Anthropic Messages API and the OpenAI Chat Completions API at <code>http://localhost:3456</code>.</p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/v/@askalf/dario?color=blue" alt="npm version"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/ci.yml"><img src="https://github.com/askalf/dario/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/codeql.yml"><img src="https://github.com/askalf/dario/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="https://github.com/askalf/dario/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@askalf/dario" alt="License"></a>
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/dm/@askalf/dario" alt="Downloads"></a>
</p>

<p align="center">
  <a href="https://x.com/ask_alf"><img src="https://img.shields.io/badge/follow-@ask_alf-1da1f2?style=flat-square" alt="Follow on X"></a>
  <a href="https://askalf.org"><img src="https://img.shields.io/badge/askalf.org-platform-00ff88?style=flat-square" alt="askalf"></a>
</p>

<p align="center"><em>Zero runtime dependencies. <a href="https://www.npmjs.com/package/@askalf/dario">SLSA-attested</a> on every release. Nothing phones home. Independent, unofficial, third-party — see <a href="DISCLAIMER.md">DISCLAIMER.md</a>.</em></p>

> **dario is the open-source wedge of [askalf](https://askalf.org)** — the AI workforce platform we're building. Dario solves the Claude subscription problem so the rest of the workforce can run on flat-rate billing. Star this repo or follow [@ask_alf](https://x.com/ask_alf) for platform updates.

---

## 30 seconds

```bash
# 1. Install
npm install -g @askalf/dario

# 2. Log in to your Claude subscription (Pro, Max 5x, or Max 20x)
dario login                      # or `dario login --manual` for SSH / headless setups

# 3. Start the local Claude API proxy
dario proxy

# 4. Point any Anthropic-compat tool at it
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
```

Done. Every tool that honors those env vars — Claude Code, Cursor, Aider, Cline, Roo Code, Continue.dev, Zed, Windsurf, OpenHands, OpenClaw, Hermes, the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), your own scripts — now routes through your **Claude subscription** (Pro / Max 5x / Max 20x) instead of per-token API pricing. Dario sends the same request shape Claude Code itself sends, which is the shape the subscription-billing path recognizes.

For OpenAI / Groq / OpenRouter / Ollama / LiteLLM / vLLM, add one backend line and reuse the same proxy:

```bash
dario backend add openai     --key=sk-proj-...
dario backend add groq       --key=gsk_...    --base-url=https://api.groq.com/openai/v1
dario backend add openrouter --key=sk-or-...  --base-url=https://openrouter.ai/api/v1
dario backend add local      --key=anything   --base-url=http://127.0.0.1:11434/v1

export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

Switching providers is a **model-name change** in your tool — `claude-opus-4-7`, `gpt-4o`, `llama-3.3-70b`, any OpenRouter / Groq / local model — not a reconfigure. Force a specific backend with a prefix: `openai:gpt-4o`, `claude:opus`, `groq:llama-3.3-70b`, `local:qwen-coder`.

Something not right? `dario doctor` prints a single paste-ready health report. Paste that when you file an issue.

---

## What it actually does

You point every tool at one URL. Dario reads each request, decides which backend owns it, and forwards in that backend's native protocol.

| Client speaks | Model in request | dario routes to | What happens |
|---|---|---|---|
| Anthropic Messages API | `claude-*` / `opus` / `sonnet` / `haiku` | Claude backend | OAuth swap + (optional) CC template replay → `api.anthropic.com` |
| Anthropic Messages API | `gpt-*`, `llama-*`, etc. | OpenAI-compat backend | Anthropic → OpenAI translation, forwarded to configured backend |
| OpenAI Chat Completions | `gpt-*` / `o1-*` / `o3-*` | OpenAI-compat backend | Passthrough: auth swap, body forwarded byte-for-byte |
| OpenAI Chat Completions | `claude-*` | Claude backend | OpenAI → Anthropic translation, then the Claude backend path |
| Either protocol | `<provider>:<model>` | Forced by prefix | Explicit override for ambiguous names |

The tool doesn't know. The backend doesn't know. Dario is the seam.

Beyond routing, the Claude backend is a **full Claude Code wire-level template** — every observable axis (bytes, headers, body key order, TLS stack, inter-request timing, session-id lifecycle, stream-consumption shape) is captured from your installed CC binary and mirrored on outbound requests so the upstream subscription-billing path is the one the request follows. See [`docs/wire-fidelity.md`](./docs/wire-fidelity.md).

---

## Cost comparison

Claude subscription tiers: **Pro** ($20/mo) · **Max 5x** ($100/mo) · **Max 20x** ($200/mo). Dario routes through whichever you have — pick by your usage volume, not by what dario needs.

| Setup | Monthly cost (heavy single-tool user) |
|---|---|
| Cursor + Anthropic API direct | $80–$300 |
| Cursor + ChatGPT Plus | $20 + per-token overage |
| **Cursor + Claude Pro/Max + dario** | **$20 (Cursor) + $20–200 (your Claude tier) flat — every Claude call routes through your subscription** |
| Multi-tool heavy use (Cursor + Aider + Cline + Continue) without dario | $200–$600+ |
| **Same multi-tool use with dario** | **$20–200 flat — one Pro/Max subscription routes all of them** |

Already have **Pro + Max** stacked? Pool mode (`dario accounts add work` / `dario accounts add personal`) routes across both, with session stickiness keeping multi-turn agents pinned to one account so the prompt cache survives. Tiers mix freely — dario only cares about headroom, not which plan an account is on.

---

## Why you'll install this

- **One URL for every provider.** Cursor, Aider, Continue, Zed, OpenHands, Claude Code, your own scripts — every tool you own has its own per-provider config. Dario collapses that into a single `localhost:3456` that speaks both Anthropic and OpenAI protocols and routes by model name.
- **Your Claude subscription stops sitting idle.** Cursor, Aider, Zed, Continue all want API keys and bill per-token while your Pro / Max 5x / Max 20x plan only gets used in Claude Code. Dario routes them through your plan via Claude Code's exact wire shape.
- **You hit rate limits on long agent runs.** Add a second / third Claude subscription with `dario accounts add work` and pool mode routes each request to whichever account has the most headroom. Session stickiness pins multi-turn conversations; in-flight 429 failover retries on a different account before your client sees the error. See [`docs/multi-account-pool.md`](./docs/multi-account-pool.md).
- **You run a coding agent that isn't Claude Code.** Cline, Roo Code, Cursor, Windsurf, Continue.dev, GitHub Copilot, OpenHands, OpenClaw, Hermes, hands — dario's universal `TOOL_MAP` (~66 schema-verified entries) pre-maps their tool names to Claude Code's native set. No flag, no validator errors. See [`docs/agent-compat.md`](./docs/agent-compat.md).
- **You want the proxy off the wire entirely.** Shim mode is an in-process `globalThis.fetch` patch — no HTTP hop, no port to bind, no `BASE_URL`. `dario shim -- claude --print "hi"` and CC thinks it's talking directly to `api.anthropic.com`. See [`docs/shim.md`](./docs/shim.md).
- **You want dario reachable from inside Claude Code or any MCP client.** `dario subagent install` registers a CC sub-agent for in-session diagnostics ([`docs/sub-agent.md`](./docs/sub-agent.md)). `dario mcp` turns dario into a read-only MCP server ([`docs/mcp-server.md`](./docs/mcp-server.md)).
- **You want to actually audit it.** ~10,750 lines of TypeScript across ~24 files. Zero runtime dependencies. Credentials at `~/.dario/` with `0600` permissions. `127.0.0.1`-only by default. Every release [SLSA-attested](https://www.npmjs.com/package/@askalf/dario). Nothing phones home. Small enough to read in a weekend.

---

## Independently reviewed (4 LLMs)

Same prompt to all four ([`reviews/PROMPT.md`](./reviews/PROMPT.md)). Each reviewer signed a verdict line. Push-back triaged in [`review-feedback`](https://github.com/askalf/dario/issues?q=label%3Areview-feedback).

| Reviewer | Verdict | Full review |
|---|---|---|
| **Grok 4** | "Adopt if the use-case fits." | [→](./reviews/grok-4-2026-04-21.md) |
| **Claude Opus 4.7** | "The fingerprint-replay claim is backed by the code." | [→](./reviews/claude-opus-4-7-2026-04-21.md) |
| **Gemini 2.0 Pro** | "Technically elite, zero-dependency proxy." | [→](./reviews/gemini-2-pro-2026-04-21.md) |
| **GPT-5.3** | "Disciplined, intentional engineering. Not vibe-coded." | [→](./reviews/gpt-5.3-2026-04-21.md) |

Highlights:

> "This is not vibe-coded; it reads like production-grade infrastructure that happens to be open-source." — Grok 4
>
> "Comments consistently cite the issue number that motivated the code — which is what scar-tissue code looks like in a project that has actual users." — Claude Opus 4.7
>
> "The implementation isn't just a simple header swap; it is a sophisticated request-level deepfake." — Gemini 2.0 Pro
>
> "Not 'best-effort mimicry'; it's capture-and-replay of a real client." — GPT-5.3

---

## Who this is for

**Best fit:**

- Developers using multiple LLMs across multiple tools tired of juggling base URLs, keys, and per-tool provider configs.
- Claude Pro / Max subscribers who want their subscription usable from every tool on their machine, not just Claude Code.
- Teams running local or hosted OpenAI-compat servers (LiteLLM, vLLM, Ollama, Groq, OpenRouter, self-hosted) who want one stable local endpoint every tool can reuse.
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) users who want OAuth-subscription routing under the SDK. Point `baseURL: 'http://localhost:3456'` and dario translates API-key calls into your Claude subscription auth — agent code stays identical.
- Power users on multi-agent workloads who want multi-account pooling, session stickiness, and in-flight 429 failover on their own machine, against their own subscriptions.

**Not a fit:**

- You need vendor-managed production SLAs on every request. Use the provider APIs directly.
- You need a hosted, multi-tenant, managed routing platform with a dashboard, team auth, and support contracts. Dario is a local, single-user tool — the [askalf platform](https://askalf.org) is the right surface for the team / fleet case.
- You want a chat UI. Use claude.ai or chatgpt.com.

---

## Backends

Dario's routing is organized around **backends**. Each is a swappable adapter — add one, your tools reach it through `localhost:3456` in whichever API shape they already speak. Run zero, one, or all concurrently.

### 1. OpenAI-compat backend

Any provider that speaks the OpenAI Chat Completions API.

```bash
dario backend add openai     --key=sk-proj-...
dario backend add groq       --key=gsk_...   --base-url=https://api.groq.com/openai/v1
dario backend add openrouter --key=sk-or-... --base-url=https://openrouter.ai/api/v1
dario backend add local      --key=anything  --base-url=http://127.0.0.1:4000/v1
```

Credentials live at `~/.dario/backends/<name>.json` with mode `0600`. Body forwarded as-is, only the `Authorization` header is swapped, streaming forwarded byte-for-byte. Force a specific backend with a [provider prefix](./docs/usage.md#provider-prefix) on the model field.

### 2. Claude subscription backend

OAuth-backed Claude Pro / Max 5x / Max 20x, billed against your plan instead of the API. Activated by `dario login` (or `dario login --manual` for SSH / container setups, v3.20). Any tier with Claude Code access works — see [`docs/faq.md`](./docs/faq.md).

Every outbound Claude request is rebuilt to match a request Claude Code itself would make — system prompt, tool definitions, identity headers, billing tag, beta flags, header insertion order, static header values, `anthropic-beta` flag set, top-level request-body key order — using a live-extracted template from your actually-installed CC binary that self-heals on every upstream CC release.

Key mechanisms in brief: live template extraction from your installed `claude` binary, drift detection with forced refresh on mismatch, OAuth config auto-detection (so dario picks up Anthropic-side rotations on the next run), atomic cache writes, framework scrubbing (third-party identity markers stripped from system prompt), Bun auto-relaunch (so the TLS ClientHello matches CC's runtime). `dario proxy --passthrough` does an OAuth swap and nothing else — use it when the upstream tool already builds a Claude-Code-shaped request.

What this addresses: per-request fidelity. What it can't address alone: cumulative per-OAuth-session aggregates. The v3.22 – v3.28 wire-fidelity track closed six of those axes (body order, TLS, pacing, stream-drain, session-id lifecycle, MCP/sub-agent surface — see [`docs/wire-fidelity.md`](./docs/wire-fidelity.md)); for anything left, [pool mode](./docs/multi-account-pool.md) distributes load across multiple subscriptions.

---

## Multi-account pool mode

Pool mode activates automatically when `~/.dario/accounts/` contains 2+ accounts. Each request picks the account with the highest headroom; multi-turn agent sessions pin to one account so the Anthropic prompt cache survives; in-flight 429s retry on a different account before the client sees an error.

```bash
dario accounts add work
dario accounts add personal
dario proxy
```

Full details, headroom math, sticky-key implementation, inspection endpoints: [`docs/multi-account-pool.md`](./docs/multi-account-pool.md).

---

## Shim mode (experimental)

Take the proxy off the wire entirely. `dario shim -- <child cmd>` patches `globalThis.fetch` inside the child via `NODE_OPTIONS=--require`. No localhost HTTP hop. No port to bind. No `BASE_URL`.

```bash
dario shim -- claude --print "hello"
```

When to use it, when to stay on the proxy, hardening detail: [`docs/shim.md`](./docs/shim.md).

---

## Agent compatibility

Dario's `TOOL_MAP` (~66 schema-verified entries) covers every major coding agent — Cline, Roo Code, Kilo Code, Cursor, Windsurf, Continue.dev, GitHub Copilot, OpenHands, OpenClaw, Hermes, [hands](https://github.com/askalf/hands). Tool calls translate to CC's native set on the outbound path (subscription wire shape preserved) and rebuild to your agent's exact expected shape on the inbound path.

Text-tool clients (Cline / Kilo / Roo) and identity-detected agents (`hands`, `arnie`, Hermes) auto-flip into preserve-tools mode via system-prompt identity markers. A structural fallback catches in-house non-CC agents (3+ tools, ≥80% unmapped) and flips them too.

Per-tool setup (Cursor, Continue, Aider, Cline, Zed, OpenHands), the `--preserve-tools` / `--hybrid-tools` decision matrix, and the full agent table all live in [`docs/agent-compat.md`](./docs/agent-compat.md).

### Custom tool schemas

If your agent's tool names aren't pre-mapped and its tools carry fields CC's schema doesn't have, you have two escape hatches:

- **`--preserve-tools`** — forward your schema verbatim, lose the CC wire shape (and likely the subscription-billing wire shape with it).
- **`--hybrid-tools`** — keep the CC wire shape, fill request-context fields (`sessionId`, `requestId`, `channelId`, `userId`, `timestamp`) from headers on the reverse path. The compromise that keeps both.

Full when-to-use-which decision matrix and request-context field set: [`docs/agent-compat.md#custom-tool-schemas`](./docs/agent-compat.md#custom-tool-schemas).

---

## Trust and transparency

| Signal | Status |
|---|---|
| **Source code** | ~10,750 lines of TypeScript across ~24 files — small enough to audit in a weekend |
| **Dependencies** | 0 runtime dependencies. Verify: `npm ls --production` |
| **npm provenance** | Every release is [SLSA-attested](https://www.npmjs.com/package/@askalf/dario) via GitHub Actions with sigstore provenance attached to the transparency log |
| **Security scanning** | [CodeQL](https://github.com/askalf/dario/actions/workflows/codeql.yml) on every push and weekly |
| **Test footprint** | ~1,185 assertions across 32 test suites. Full `npm test` green on every release |
| **Credential handling** | Tokens and API keys never logged, redacted from errors, stored with `0600` permissions. MCP server (v3.27) redacts keys at the tool boundary too — not even a `sk-…` prefix leaks. |
| **OAuth flow** | PKCE, no client secret. `--manual` flow for headless setups (v3.20). |
| **Network scope** | Binds to `127.0.0.1` by default. `--host` allows LAN/mesh with `DARIO_API_KEY` gating. Upstream traffic goes only to configured backend target URLs over HTTPS. |
| **SSRF protection** | `/v1/messages` hits `api.anthropic.com` only; `/v1/chat/completions` hits the configured backend `baseUrl` only — hardcoded allowlist |
| **Telemetry** | None. Zero analytics, tracking, or data collection. The MCP server and CC sub-agent are read-only by design. |
| **Audit trail** | [CHANGELOG.md](CHANGELOG.md) documents every release with file-level rationale |

Verify the npm tarball matches this repo:

```bash
npm audit signatures
npm view @askalf/dario dist.integrity
cd $(npm root -g)/@askalf/dario && npm ls --production
```

---

## Commands

`dario login`, `dario proxy`, `dario doctor`, `dario accounts {list,add,remove}`, `dario backend {list,add,remove}`, `dario shim`, `dario mcp`, `dario subagent {install,status,remove}`, `dario usage`, `dario config`, `dario upgrade`, `dario status`, `dario refresh`, `dario logout`, `dario help`.

Full flag/env reference + endpoint list: [`docs/commands.md`](./docs/commands.md).

SDK examples (Python / TypeScript / curl) + per-tool setup: [`docs/usage.md`](./docs/usage.md).

---

## FAQ

The most-asked questions. Full FAQ in [`docs/faq.md`](./docs/faq.md).

**Does this violate Anthropic's terms of service?**
Mechanically: dario uses your existing Claude Code credentials with the same OAuth tokens CC uses. It authenticates you as you, with your subscription, through Anthropic's official endpoints. Whether any particular use complies with their current terms is between you and Anthropic — consult their terms and your subscription agreement. Independent, unofficial, third-party — see [DISCLAIMER.md](DISCLAIMER.md).

**Do I need Claude Code installed?**
Recommended, not strictly required. With CC installed, `dario login` picks up your credentials automatically and the live template extractor reads your CC binary on every startup. Without CC, dario runs its own OAuth flow and falls back to the bundled (scrubbed) template snapshot.

**Do I need Bun?**
Optional, strongly recommended for Claude-backend requests so the TLS ClientHello matches CC's runtime. Without Bun it works fine — `dario doctor` surfaces the mismatch as of v3.23 and `--strict-tls` refuses to start until resolved.

**Can I use dario without a Claude subscription?**
Yes. Skip `dario login`, `dario backend add openai --key=...` and you have a local OpenAI-compat router with no Claude involvement.

**Something's wrong. Where do I start?**
`dario doctor`. One command, paste-ready report. If you're inside CC, `dario subagent install` once and ask CC to "use the dario sub-agent to run doctor."

**I'm seeing `representative-claim: seven_day` in my rate-limit headers — am I being downgraded?**
**No.** Both `five_hour` and `seven_day` are subscription billing — different accounting buckets inside the same subscription mode. `overage` is the one that flips you to per-token. See [Discussion #32](https://github.com/askalf/dario/discussions/32) for the full breakdown.

---

## Technical deep dives

- [#178 — Anthropic's billing classifier fingerprints `openclaw.inbound_meta.v1`](https://github.com/askalf/dario/discussions/178) — reproducing Theo Browne's finding with controlled variants
- [#172 — Re-testing #13: the system prompt is not a fingerprint signal](https://github.com/askalf/dario/discussions/172)
- [#68 — dario vs LiteLLM / OpenRouter / Kong AI Gateway (when each one wins)](https://github.com/askalf/dario/discussions/68)
- [#14 — Template Replay: why we stopped matching signals](https://github.com/askalf/dario/discussions/14)
- [#13 — Claude Code's "defaults" are detection signals, not optimizations](https://github.com/askalf/dario/discussions/13)
- [#39 — Why your Claude Max usage is burning in minutes](https://github.com/askalf/dario/discussions/39)
- [#9 — Why Opus feels worse through other proxies and how to fix it](https://github.com/askalf/dario/discussions/9)
- [#8 — Billing tag algorithm and fingerprint analysis](https://github.com/askalf/dario/discussions/8)
- [#1 — Rate limit header analysis](https://github.com/askalf/dario/discussions/1)

The CHANGELOG documents every v3.22 – v3.28 wire-fidelity release with file-level rationale; each one is worth reading as a standalone post on the axis it closes.

---

## Contributing

PRs welcome. Small TypeScript codebase — ~10,750 lines, 24 files, zero runtime dependencies. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the architecture overview and the file-by-file map.

```bash
git clone https://github.com/askalf/dario
cd dario
npm install
npm run dev   # runs with tsx, no build step
npm test      # ~1,185 assertions across 32 suites
npm run e2e   # live proxy + OAuth (requires a working Claude backend)
```

---

## Contributors

| Who | Contributions |
|---|---|
| [@GodsBoy](https://github.com/GodsBoy) | Proxy authentication, token redaction, error sanitization ([#2](https://github.com/askalf/dario/pull/2)) |
| [@belangertrading](https://github.com/belangertrading) | Billing classification investigation ([#4](https://github.com/askalf/dario/issues/4)), cache_control fingerprinting ([#6](https://github.com/askalf/dario/issues/6)), billing reclassification root cause ([#7](https://github.com/askalf/dario/issues/7)), OAuth client_id discovery ([#12](https://github.com/askalf/dario/issues/12)), multi-agent session-level billing analysis ([#23](https://github.com/askalf/dario/issues/23)) |
| [@iNicholasBE](https://github.com/iNicholasBE) | macOS keychain credential detection ([#30](https://github.com/askalf/dario/pull/30)) |
| [@boeingchoco](https://github.com/boeingchoco) | Reverse-direction tool parameter translation ([#29](https://github.com/askalf/dario/issues/29)), SSE event-group framing regression catch (v3.7.1), provider-comparison diagnostic, motivating case for hybrid tool mode ([#33](https://github.com/askalf/dario/issues/33), v3.9.0), OpenClaw tool-mapping root cause ([#36](https://github.com/askalf/dario/issues/36)) |
| [@tetsuco](https://github.com/tetsuco) | Framework-name path corruption in scrubber ([#35](https://github.com/askalf/dario/issues/35)), OpenClaw Bash/Glob reverse-mapping collisions ([#37](https://github.com/askalf/dario/issues/37)), 20x-tier capture-artifact + OAuth-scope rejection report ([#42](https://github.com/askalf/dario/issues/42)) |
| [@mikelovatt](https://github.com/mikelovatt) | Silent subscription-percent drain surfaced via friendly billing buckets ([#34](https://github.com/askalf/dario/issues/34)) |
| [@ringge](https://github.com/ringge) | Fingerprint-fidelity concern motivating `--no-auto-detect` for text-tool-client auto-preserve ([#40](https://github.com/askalf/dario/issues/40), v3.20.1) |
| [@earlvanze](https://github.com/earlvanze) | OpenClaw tool mappings + missing CC tools ([#19](https://github.com/askalf/dario/pull/19)), OAuth manual-override escape hatch ([#47](https://github.com/askalf/dario/pull/47)), HTTPS warning for non-secure overrides ([#53](https://github.com/askalf/dario/pull/53)) |

---

## Disclaimers

**dario is an independent, unofficial, third-party project.** Not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or any other vendor referenced in the code or documentation. Provided as-is with no warranty. You are solely responsible for compliance with your subscription's terms of service, the security of your credentials, and the content you send through the proxy. Not intended for safety-critical, regulated, or production-grade environments without your own independent review. See [DISCLAIMER.md](DISCLAIMER.md) for full text.

---

## License

MIT — see [LICENSE](LICENSE) and [DISCLAIMER.md](DISCLAIMER.md).
