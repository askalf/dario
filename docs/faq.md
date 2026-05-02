# FAQ

**Does this violate Anthropic's terms of service?**
Mechanically: dario's Claude backend uses your existing Claude Code credentials with the same OAuth tokens CC uses. It authenticates you as you, with your subscription, through Anthropic's official API endpoints. Whether any particular use complies with Anthropic's current terms of service is between you and Anthropic — consult their terms and your own subscription agreement. This project is an independent, unofficial, third-party tool and does not provide legal advice. See [DISCLAIMER.md](../DISCLAIMER.md).

**What subscription plans work on the Claude backend?**
Any plan whose account currently has Claude Code access — Max has it unconditionally; Pro has it as of this writing but that's an upstream decision that has moved once already (see next entry). If `claude /login` on your account works and `claude -p "hi"` returns a response on subscription billing, dario's Claude backend will work too. If Anthropic removes Claude Code from your plan tier, dario's Claude backend stops working on that account — there is nothing dario can do at the client side to change that. Swap to a plan with Claude Code access, or use an OpenAI-compat backend instead.

**Is it true Anthropic removed Claude Code from Pro plans?**
On 2026-04-21 Anthropic temporarily removed Claude Code from new Pro signups, per [wheresyoured.at](https://www.wheresyoured.at/news-anthropic-removes-pro-cc/). Existing Pro users reportedly kept access; Anthropic's Head of Growth characterized it as "a small test of 2% of new prosumer signups," and the change was reversed at an unknown time. If you are a Pro user and dario's Claude backend stops billing against your subscription without warning, this is the class of thing to check — run `claude -p "hi"` directly and see whether Anthropic itself routes you to subscription billing. If they don't, dario can't either. The practical mitigation on dario's side is [multi-account pool mode](./multi-account-pool.md) — having a backup account on a plan Anthropic hasn't moved the goalposts on, so a single plan-tier change doesn't take all your traffic down at once.

**Does it work with Team / Enterprise?**
Yes — tested and confirmed working as long as your plan includes Claude Code access.

**Do I need Claude Code installed?**
Recommended for the Claude backend, not strictly required. With CC installed, `dario login` picks up your credentials automatically, and the live template extractor reads your CC binary on every startup so the template stays current. Without CC, dario runs its own OAuth flow and falls back to the bundled template snapshot (scrubbed of host context at bake time as of v3.21). Drift detection warns you if your installed CC doesn't match the captured template, so upgrade windows don't silently ship stale templates.

**Do I need Bun?**
Optional, strongly recommended for Claude-backend requests. Dario auto-relaunches under Bun when available so the TLS ClientHello matches CC's runtime. Without Bun, dario runs on Node.js and works fine — the TLS ClientHello is the only observable difference. As of v3.23, `dario doctor` surfaces the mismatch explicitly and `--strict-tls` refuses to start proxy mode until it's resolved. The shim transport sidesteps this entirely (it runs inside CC's own process, so its TLS stack *is* CC's).

**Can I use dario without a Claude subscription?**
Yes. Skip `dario login`, just run `dario backend add openai --key=...` (or any OpenAI-compat URL) and `dario proxy`. Claude-backend requests will return an authentication error; OpenAI-compat requests will work normally. Dario becomes a local OpenAI-compat router with no Claude involvement.

**Can I route non-OpenAI providers through dario?**
Yes — anything that speaks the OpenAI Chat Completions API. Groq, OpenRouter, LiteLLM, vLLM, Ollama's openai-compat mode, your own vLLM server, any hosted inference endpoint that exposes `/v1/chat/completions`. Just `dario backend add <name> --key=... --base-url=...`.

**Something's wrong. Where do I start?**
`dario doctor`. One command, one aggregated report — dario version, Node, platform, runtime/TLS classification, CC binary compat, template source + age + drift, OAuth status, pool state, backends, sub-agent install state, home dir. Exit code 1 if any check fails. Paste the output when you file an issue. (If you're inside Claude Code, `dario subagent install` once and then ask CC to "use the dario sub-agent to run doctor" — same output, no context switch.)

**OpenClaw returns 401 after I set `DARIO_API_KEY` (or upgrade past v3.30.6).**
If you run `dario proxy --host=0.0.0.0` (non-loopback), dario requires `DARIO_API_KEY` to be set so it's not an open subscription relay. OpenClaw 2026.2.17+ prefers `~/.openclaw/agents/main/agent/auth-profiles.json` over `openclaw.json`'s `apiKey` field or the `ANTHROPIC_API_KEY` env var — so if you have a stale Anthropic token in `auth-profiles.json` from an earlier setup, OpenClaw sends *that* token instead of `dario`, and dario rejects the request with `Authorization present but value mismatch` (visible under `dario proxy -v`, added in v3.31.2).

Three fixes, in order of simplicity:

1. **Use loopback.** `dario proxy --host=127.0.0.1` — auth only enforced on non-loopback binds, no `DARIO_API_KEY` required, no OpenClaw changes. Best if you don't actually need LAN reach to dario.
2. **Delete the Anthropic auth profile.** Remove the `"anthropic:default"` entry from `~/.openclaw/agents/main/agent/auth-profiles.json`. OpenClaw then falls back through the config chain and picks up `ANTHROPIC_API_KEY=dario` from the env. Confirmed working by [@tetsuco in #97](https://github.com/askalf/dario/issues/97).
3. **Overwrite the auth profile.** `openclaw models auth paste-token --provider anthropic` and paste `dario`. Replaces whatever key was in there — keep a backup if you use it elsewhere.

Diagnose with `dario proxy -v` — the reject log (v3.31.2+) reports header-name only (never the value, since it may be a real credential you mistyped) and tells you which of the three configs is actually being hit.

**My RDP / RemotePC session randomly drops while claude is working. Logs say `error 121` / `0x80070079` / "ERROR_SEM_TIMEOUT". Network is otherwise fine — other devices don't drop, gateway pings are clean.**
Cause: heavy claude tool work bursts CPU on a small machine, the kernel network IO threads can't get scheduled, the RDP socket write times out, your session drops. The drops are real but the network path is not — they're caused by CPU starvation above the NIC layer, which is why every adapter (Ethernet, Wi-Fi, USB Wi-Fi) drops the same way. Confirmed pattern when running claude on a 4-core / 4-thread CPU you're RDP'd into.

Three fixes, in order of progressively-stronger:

1. **Run claude through `dario shim --priority=below-normal -- claude` (v3.37+).** Lets the kernel preempt claude when it needs to send a packet. Same throughput when nothing else needs CPU. Recommended default.
2. **Escalate to `--priority=low`.** More aggressive — claude only runs when nothing else is ready. ~5-10% slower agent loops in practice.
3. **Reserve a CPU core for the OS.** On Windows, `(Get-Process claude).ProcessorAffinity = 0x07` reserves logical CPU 3 (mask covers cores 0-2). Set after spawn or via Process Lasso for permanence. On a 4-core/4-thread machine, this guarantees the kernel always has a free core for network IO no matter what claude does.

If drops continue past all three: the underlying cause is hardware capacity. The same workload on a modern 8C/16T machine will not exhibit this. Move the heavy claude session off the RDP host, or upgrade the host.

**What happens when Anthropic rotates the OAuth config?**
Dario auto-detects OAuth config from the installed Claude Code binary. When CC ships a new version with rotated values, dario picks them up on the next run. Cache at `~/.dario/cc-oauth-cache-v6.json`, keyed by the CC binary fingerprint. The cache path version bumps each time the canonical OAuth config shape changes so stale caches regenerate automatically on upgrade — v3 → v4 in v3.19.4 (scope-list flip CC v2.1.104 → v2.1.107), v4 → v5 in v3.31.3 (authorize URL `claude.com/cai/` → `claude.ai/` host normalization), v5 → v6 in v3.31.4 (6-scope restore after CC v2.1.116).

If Anthropic rotates the values before the detector is updated, you can temporarily override any field with env vars (`DARIO_OAUTH_CLIENT_ID`, `DARIO_OAUTH_AUTHORIZE_URL`, `DARIO_OAUTH_TOKEN_URL`, `DARIO_OAUTH_SCOPES`) or by writing `~/.dario/oauth-config.override.json`:

```json
{
  "clientId": "...",
  "authorizeUrl": "https://claude.com/cai/oauth/authorize",
  "tokenUrl": "https://platform.claude.com/v1/oauth/token",
  "scopes": "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
}
```

Env vars win over the file. Set `DARIO_OAUTH_DISABLE_OVERRIDE=1` to force pure auto-detection.

**What happens when Anthropic changes the CC request template?**
Dario extracts the live request template from your installed Claude Code binary on startup — the system prompt, tool schemas, user-agent, beta flags, header insertion order, static header values, and top-level request-body key order — and uses those to replay requests instead of a version pinned into dario itself. When CC ships a new version with a tweaked template, the next `dario proxy` run picks it up automatically. Drift detection forces a refresh when the installed CC version changes under dario, and the nightly `cc-drift-watch` workflow catches upstream rotations (client_id, URLs, tool set, version) the day they ship on npm.

**Why does `dario accounts list` show an account called `login` I never added?**
That's your existing `dario login` credentials, back-filled into the pool automatically on your first `dario accounts add <alias>`. Pool mode activates at 2+ accounts in `~/.dario/accounts/`, and the single-account `credentials.json` store lives outside that directory — so without the back-fill, one `accounts add` would leave you at 1 pool entry and your login account orphaned. The `login` alias is reserved for this path. Safe to `dario accounts remove login` if you don't want it pooled; the original `credentials.json` is untouched by the back-fill, so single-account mode resumes reading it after removal drops you below the 2+ threshold. See [Multi-account pool mode](./multi-account-pool.md) for the full picture.

**First time setup on a fresh Claude account.**
If dario is the first thing you run against a brand-new Claude account, prime the account with a few real Claude Code commands first:
```bash
claude --print "hello"
claude --print "hello"
```
This establishes a session baseline. Without priming, brand-new accounts occasionally see billing classification issues on first use.

**I'm hitting rate limits on the Claude backend. What do I do?**
Claude subscriptions have rolling 5-hour and 7-day usage windows. Check utilization with Claude Code's `/usage` command or the [statusline](https://code.claude.com/docs/en/statusline). For multi-agent workloads, add more accounts and let pool mode distribute the load: `dario accounts add <alias>`. Session stickiness keeps long conversations pinned to one account so the prompt cache isn't destroyed by rotation.

**I'm seeing `representative-claim: seven_day` in my rate-limit headers instead of `five_hour`. Am I being downgraded to API billing?**

**No.** You're still on subscription billing. Both `five_hour` and `seven_day` are the same subscription billing mode — two different accounting buckets inside it.

| Claim | What it means |
|---|---|
| `five_hour` | You're well inside your 5-hour window; billing against the short-term bucket. |
| `seven_day` | You've exhausted (or come close to exhausting) the 5-hour window for this rolling cycle, so Anthropic is charging this request against the 7-day bucket. **Still subscription billing. Still your plan.** Not API pricing, not overage. |
| `overage` | Both subscription windows are effectively exhausted. *This* is where per-token Extra Usage charges kick in — if you've enabled Extra Usage on the account. If not, you get 429'd instead. |

Seeing `seven_day` is a healthy state. Your Max plan is doing exactly what it's supposed to do: letting you keep working past short bursts of heavy use by absorbing them into the larger 7-day bucket. When your 5-hour window rolls forward enough, the claim on new requests will go back to `five_hour` on its own. If the 7-day bucket is painful, add more Claude subscriptions to the pool — each account has its own independent 5h/7d windows, and pool mode routes each request to the account with the most headroom.

Standalone writeup: [Discussion #1 — full rate-limit-header breakdown](https://github.com/askalf/dario/discussions/1).

**My multi-agent workload is getting reclassified to overage even though dario mirrors the CC wire shape per request. Why?**
Reclassification at high agent volume is not a per-request problem. The upstream billing logic takes cumulative per-OAuth-session aggregates into account — token throughput, conversation depth, streaming duration, inter-arrival timing, thinking-block volume. Dario's Claude backend can make each individual request match Claude Code and still hit this wall on a long-running agent session. Thorough diagnostic work was contributed by [@belangertrading](https://github.com/belangertrading) in [#23](https://github.com/askalf/dario/issues/23). The practical answer at the dario layer is **pool mode** — distribute load across multiple subscriptions so no single account accumulates signal along any single dimension. See [Multi-account pool mode](./multi-account-pool.md). The v3.22 – v3.28 wire-fidelity track (pacing, stream-drain, session-id lifecycle) also narrows the cumulative signal on a single account — see [Wire-fidelity axes](./wire-fidelity.md).

**My proxy is on Node, not Bun. What's the actual risk?**
Node uses OpenSSL, Bun uses BoringSSL — the TLS ClientHello differs enough to yield a distinct JA3/JA4 hash. The upstream service can see the hash. Whether any routing decisions depend on it today is not published; making the axis visible is the v3.23 contribution. If certainty matters to you, install Bun (dario auto-relaunches under it) or run `dario proxy --strict-tls` to fail loud. If it doesn't, the warning is ignorable — dario still works, the TLS ClientHello is just the one observable axis left.

**Why "dario"?**
It's a name, not an acronym. Don't overthink it.
