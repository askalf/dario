# dario + hands — battletested setup

End-to-end walkthrough for running [hands](https://github.com/askalf/hands) — a local computer-use agent that drives your OS through its native shell — through dario so the model spend bills against your Claude Pro / Max subscription instead of per-token overage on the computer-use beta. Covers install → mode selection → first run → verification → the gotchas that bite first-time users.

This is the **first-party** walkthrough. hands is one of dario's sister projects under [askalf](https://github.com/askalf), so unlike the OpenHands / OpenClaw guides where dario is *integrating* with someone else's tool, this is the canonical end-to-end stack we run ourselves. Most of the integration work has already been done on both ends: dario v3.33.0 auto-detects hands via system-prompt identity match and preserves the computer-use beta tools (`computer`, `bash`, `str_replace_based_edit_tool`) without you needing any flag.

## Why hands + dario

Hosted "AI controls your computer" products charge $20–50/mo on top of any LLM costs. The math is unfavorable on at least four axes:

| Axis | Hosted product | hands + dario |
|---|---|---|
| **Per-task cost** | Bundled into the $20–50/mo tier | **$0** — bills against the Claude Max plan you already pay for |
| **Where your screenshots go** | Vendor's servers | Your machine. The only outbound is to your chosen LLM endpoint |
| **What drives your OS** | A screenshot loop simulating clicks | Your actual shell — PowerShell on Windows, `open` + AppleScript on macOS, `xdotool` / `ydotool` on Linux. Faster, cheaper, more reliable |
| **Audit trail** | Vendor's logs (good luck exporting) | `~/.hands/audit.jsonl` — every tool call, locally, line-delimited JSON. `--dry-run` to plan without acting |

The walkthrough below puts that stack together in 5 minutes.

## Two modes — pick the right one

hands ships with two authentication paths. Same agent loop, same tools — the difference is **where** the model runs and **what it costs.**

| Mode | What it uses | Per-task cost via dario | Audit log | Best for |
|---|---|---|---|---|
| **Claude Login** *(default)* | The `claude` CLI as a child process | $0 (the CLI already uses your subscription) | None — `claude` runs the tools internally | Daily use, lowest setup |
| **SDK mode** | Anthropic SDK directly | **$0** when routed through dario | ✅ `~/.hands/audit.jsonl` | Programmatic access, dry-run planning, security review |

If you already pay for Claude Max and want zero friction, **Claude Login mode** is fine — dario isn't strictly required because the `claude` binary handles subscription billing on its own. dario becomes useful when you want SDK mode's audit log, `--dry-run` planning, or to run hands programmatically from your own scripts — those don't work on Claude Login.

This walkthrough covers both. SDK + dario gets the spotlight because that's where dario actually adds value.

## Prerequisites

| Thing | Version | Why |
|---|---|---|
| **Node.js** | 20+ | hands and dario both target Node 20 minimum |
| **hands** | latest from npm — `npm i -g @askalf/hands` | The agent itself |
| **dario** | v3.33.0+ (latest preferred — `npm i -g @askalf/dario@latest`) | v3.33.0 added the system-prompt identity match that auto-preserves hands' computer-use tools |
| **A Claude OAuth login** | run `dario login` once | A Pro / Max subscription on a Claude account |
| **`claude` CLI** | latest | Required for Claude Login mode; `hands init` will install for you if missing |
| **Bun** (recommended) | 1.1+ | dario auto-relaunches under Bun for TLS-fingerprint fidelity. Skip if you're fine with a runtime banner; install via [bun.sh](https://bun.sh) for the full subscription wire shape. |

Verify dario before starting:

```bash
dario doctor          # all green = ready
dario status          # OAuth healthy, expires in N hours
```

## Install + init

One npm install, one interactive command:

```bash
npm install -g @askalf/hands
hands init
```

`hands init` walks every choice a new user has to make — auth mode, optional voice (whisper.cpp), `claude` CLI install if missing, dario routing tip. It's safe to re-run; pick a different mode any time.

## Mode 1 — Claude Login (default, simplest)

This is the path `hands init` recommends. Pick "Claude Login" when prompted. Done.

```bash
hands run "open notepad and type hello world"
```

What happens under the hood:

1. hands spawns the `claude` CLI as a child process
2. `claude` uses your Claude Code subscription (the same OAuth login you have for CC)
3. The agent loop runs inside `claude`, dispatching computer-use tools via hands' shell wrappers
4. You see the result in your terminal

dario isn't on the path here because `claude` handles subscription billing directly. That's by design — Claude Login mode is the "I want it to just work" path.

If you're using Claude Login mode, **you can stop reading this walkthrough now** — you're done. The rest of this guide covers SDK mode.

## Mode 2 — SDK + dario (audit-logged, programmatic, dry-run)

Pick this mode when you want one of:

- **`--dry-run`** — see exactly what the agent would do before letting it act
- **`~/.hands/audit.jsonl`** — every tool call timestamped, with args, durations, outcomes. Useful for security review or post-incident forensics.
- **Programmatic agent runs** from your own Node scripts (importing hands as a library)
- **A specific Claude account** different from the one your `claude` CLI is logged into (via `dario accounts add`)

Setup is two env vars and one running dario instance:

```bash
# In whatever shell starts hands:
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario          # or your DARIO_API_KEY if set
```

Add those to your shell profile (`~/.bashrc`, `~/.zshrc`, fish config, PowerShell `$PROFILE`) so they're set for every session.

Then in one terminal:

```bash
dario proxy --verbose
```

In another:

```bash
hands auth        # pick "API Key" — when prompted for the key, paste: dario
hands run "open notepad and type hello world"
```

That's it. The Anthropic SDK reads the env vars by default, so no hands-side config is needed beyond `hands auth` once.

### What dario does for hands automatically

You don't need any flag. Dario v3.33.0+ recognizes hands via a system-prompt identity match and:

- **Preserves** the Anthropic computer-use beta tools (`computer`, `bash`, `str_replace_based_edit_tool`) instead of remapping them to CC's canonical set. The computer-use beta tools have schema fields CC's tools don't carry; trying to translate them would corrupt the calls.
- **Strips** orchestration tags from the prompt to keep the wire shape on the subscription path.
- **Forwards** the `anthropic-beta: computer-use-*` header so the upstream model knows to enable the beta.
- Everything else (template replay, OAuth swap, sticky session) runs identically to a Claude Code request.

You'll see this in `dario proxy --verbose` as a log line like:

```
[dario] #1 POST /v1/messages (model: claude-sonnet-4-6, client: hands, preserve_tools: true, beta: computer-use-2025-01-24) → 200 (1842 ms)
```

## Voice (optional)

If you opted into voice during `hands init`, you'll have whisper.cpp installed locally. Then:

```bash
hands run "open chrome and go to amazon.com" --voice
```

Press Enter to start recording, Enter again to stop. Whisper transcribes locally (no audio leaves your machine), and the transcribed task feeds into the agent loop the same as a typed prompt.

## Verifying subscription billing

Two checks, one at the dario layer and one at Anthropic's:

### Check 1: dario doctor --usage

```bash
dario doctor --usage
```

You should see your 5-hour bucket showing non-zero usage with `claim=five_hour (subscription)`:

```
[ OK ]  Usage 5h (all)          14.2% used  •  status=allowed  •  claim=five_hour (subscription)
```

If `claim=five_hour (subscription)` shows up, you're billing against the Claude Max plan, not API. Done.

If `claim=api` shows up, something flipped you to per-token billing — usually because you started hands in Claude Login mode (where `claude` doesn't go through dario at all) but then ran SDK mode without setting the env vars. `hands doctor` reports the effective base URL hands sees; cross-check it.

### Check 2: hands' audit log

```bash
tail -f ~/.hands/audit.jsonl
```

Every tool call is one JSON-ND record. If you ran `hands run "open notepad"` and the audit log is silent, you're on Claude Login mode (which bypasses hands' tool dispatcher). Switch with `hands auth` to API Key mode if you want the audit trail.

### Check 3: Anthropic dashboard

Log into [console.anthropic.com](https://console.anthropic.com) → Usage. **Your API spend should be flat** (no new charges since you started hands). If it's climbing, the env vars didn't take effect — restart your shell and re-export.

## Battletested patterns

After running hands+dario in production for months, here are the patterns we lean on:

### Plan first, act second

Always run a `--dry-run` before letting hands actually touch anything irreversible:

```bash
hands run --dry-run "delete every file in ~/Downloads older than 30 days"
```

`--dry-run` forces SDK mode (which is the only mode where hands sees individual tool calls before they execute), prints the planned action sequence, and exits without doing anything. If the plan looks right, run it without `--dry-run`.

### Pin the model for cost-sensitive runs

Long autonomous loops on Sonnet are usually right. For exploratory single-shot tasks where you just want a quick answer, Haiku is dramatically cheaper *in API mode* — but on subscription via dario, the bucket is the same. Pin Sonnet for everything unless you have a specific reason; the model-choice tradeoff is real on direct API but neutralized through dario.

### Multi-account pool for parallel runs

If you run two or more hands sessions in parallel — say, one task on the desktop and another headless on a server — you'll exhaust a single Claude account's 5-hour bucket. Add a second account to dario's pool and pool mode load-balances:

```bash
dario login                  # log in to a second Claude account
dario accounts add work
```

See [`docs/multi-account-pool.md`](./multi-account-pool.md). Session stickiness ensures multi-turn hands conversations stay on one account.

### Audit-log review before deploying agents into shared environments

Before letting hands SDK-mode loose on a shared machine (CI agent, family computer, etc.), run a representative task with `--dry-run` and read `~/.hands/audit.jsonl` end-to-end. The audit log is exactly the visibility you'd want before signing off on agentic access to a shared OS — and it's local, not vendor-side.

## Common gotchas

### `claude` CLI not found, hands won't start in Claude Login mode

```bash
hands init    # offers to install claude CLI for you, then re-runs hands setup
```

Or install Claude Code yourself per [Anthropic's docs](https://docs.anthropic.com/en/docs/claude-code).

### `Connection refused` to localhost:3456 in SDK mode

dario isn't running:

```bash
curl -s http://localhost:3456/health
# expected: {"status":"ok",...}
```

If that fails, start dario (`dario proxy --verbose`) before invoking hands.

### Claim flips to api in SDK mode

Three causes, in order of likelihood:

1. **You're not actually on dario.** Run `hands doctor` — if `Effective base URL` doesn't show `localhost:3456`, the env vars didn't take effect. Restart your shell.
2. **Your dario template is stale.** Run `dario doctor` and check the template-age line. If it's >48 hours old, the captured CC system prompt may not match what Anthropic's classifier currently expects. `dario doctor --bun-bootstrap` to force a fresh capture.
3. **You're running hands SDK mode against a different account than the one paying for Max.** Run `dario status` and confirm the OAuth account is the subscription account.

### "computer use" beta header dropped

If dario isn't preserving the `anthropic-beta: computer-use-*` header, you're probably on a dario version older than v3.33.0. Upgrade — the system-prompt identity match and beta-preserve behavior both landed in that release.

```bash
npm install -g @askalf/dario@latest
```

### Voice mode says "whisper.cpp not found"

```bash
hands init     # offers to download whisper.cpp for you
```

Or install it yourself: clone [ggerganov/whisper.cpp](https://github.com/ggerganov/whisper.cpp), `make`, and put the binary on your `PATH`.

### Hands hangs on a screenshot in SDK mode

Computer-use beta requests with multiple screenshots can be slow on first response. Bump retry config in your shell:

```bash
export ANTHROPIC_REQUEST_TIMEOUT_MS=120000
```

dario's outbound timeout is 5 min by default, so this is purely about hands' own client-side timeout.

## What this guide doesn't cover

- **hands as a library** (importing into your own Node scripts). The dario integration works the same way — env vars route the underlying SDK to `localhost:3456`. See hands' README for the programmatic API surface.
- **Custom agents extending hands' core.** Subclassing the agent loop is supported but out of scope here. The dario integration is at the LLM layer; agent code doesn't need to change.

## Quick reference card

```bash
# One-time setup
npm install -g @askalf/dario @askalf/hands
dario login
hands init

# Per-session — Claude Login mode (default, no dario needed)
hands run "your task here"

# Per-session — SDK + dario mode (audit-logged, programmatic, --dry-run)
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
dario proxy --verbose &
hands run "your task here"

# Verify subscription billing
dario doctor --usage              # claim=five_hour (subscription) ✓
hands doctor                      # effective base URL shows localhost:3456
tail -f ~/.hands/audit.jsonl      # tool calls flowing in real time (SDK mode only)
```

## Related guides

- [`openhands-walkthrough.md`](./openhands-walkthrough.md) — sister walkthrough for the OpenHands software-engineer agent
- [`openclaw-walkthrough.md`](./openclaw-walkthrough.md) — sister walkthrough for OpenClaw
- [`agent-compat.md`](./agent-compat.md) — short setup snippets for every other agent dario supports
- [`multi-account-pool.md`](./multi-account-pool.md) — adding 2+ Claude accounts to extend rate limits for parallel hands runs
- [`commands.md`](./commands.md) — full dario CLI reference
- [hands repo](https://github.com/askalf/hands) — full hands documentation, security model, and architecture deep-dive
