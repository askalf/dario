# dario + OpenClaw — battletested setup

End-to-end walkthrough for running OpenClaw through dario so it routes against your Claude Pro / Max subscription instead of paying per-token API rates. Covers install → config → first run → verification → the gotchas that bite first-time users — including the `openclaw.inbound_meta.v1` classifier filter that dario's default mode silently protects against.

This is opinionated. There are several ways to wire OpenClaw to dario; this is the one we run in production and trust to not surprise us. Where we omit options it's because they're worse, not because they don't exist.

## What you'll have at the end

- OpenClaw running locally, talking to dario at `localhost:3456`
- All Claude API calls routed through your Pro / Max subscription via the Claude Code wire shape
- OpenClaw's tool schema (`exec`, `process`, `web_search`, `web_fetch`, `browser`, `message`) auto-translated to CC's canonical set on the outbound path and rebuilt back on the inbound path — **no flag required**
- Your `openclaw.inbound_meta.v1` namespace stripped at the proxy boundary so Anthropic's billing classifier doesn't flip you to extra-usage
- `dario doctor --usage` showing the OpenClaw traffic in your 5-hour bucket with `claim=five_hour (subscription)`

Total install + config: 5–10 minutes if dario is already installed.

## Prerequisites

| Thing | Version | Why |
|---|---|---|
| **OpenClaw** | 2026.2.17+ recommended | Older versions read auth differently — see auth-profiles gotcha below |
| **dario** | v3.31.2+ (latest preferred — `npm i -g @askalf/dario@latest`) | Auth-mismatch reject log, structural-fallback tool detection, classifier-fingerprint protection |
| **A Claude OAuth login** | run `dario login` once | The whole point — a Pro / Max subscription on a Claude account |
| **Bun** (recommended) | 1.1+ | dario auto-relaunches under Bun for TLS-fingerprint fidelity. Skip if you're fine with a runtime banner; install via [bun.sh](https://bun.sh) for the full subscription wire shape. |

Verify dario before starting OpenClaw — saves you from chasing OpenClaw errors that are actually dario auth issues:

```bash
dario doctor          # all green = ready
dario status          # OAuth healthy, expires in N hours
```

If `dario status` shows expired or missing OAuth, run `dario login` and retry. Don't continue past this step until both are clean.

## Install OpenClaw

Follow the install instructions in [OpenClaw's own README](https://github.com/openclaw/openclaw) — installation steps move with their releases and we'd rather link the canonical source than copy-paste a snapshot that goes stale.

Verify after install:

```bash
openclaw --version
```

The rest of this guide assumes a working `openclaw` CLI on your `PATH`.

## Configure OpenClaw → dario

OpenClaw reads its Anthropic configuration from three places, in priority order (2026.2.17+):

1. `~/.openclaw/agents/main/agent/auth-profiles.json` — wins if the `anthropic:default` entry exists
2. `openclaw.json` — `apiKey` field
3. `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` env vars — fallback

**This priority order is the single most common source of "why doesn't dario see my requests" tickets** ([dario#97](https://github.com/askalf/dario/issues/97)). Read the next section carefully.

### Step 1 — Set the env vars

Put this in your shell profile (`~/.bashrc`, `~/.zshrc`, fish `config.fish`, or PowerShell `$PROFILE`):

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
```

Two things to know:

- `ANTHROPIC_BASE_URL=http://localhost:3456` — points OpenClaw at dario instead of `api.anthropic.com`. dario speaks the Anthropic protocol on this port.
- `ANTHROPIC_API_KEY=dario` — this string is a literal placeholder. dario doesn't validate it (the real auth lives in dario's stored OAuth token). If you're running dario with `DARIO_API_KEY` set (LAN/multi-host mode), use that value here instead.

### Step 2 — Clear or overwrite the auth-profiles.json entry

If you've ever set up OpenClaw with a real Anthropic API key, the env vars above won't take effect — `auth-profiles.json` wins. Pick one of two fixes:

**Option A: delete the Anthropic entry from auth-profiles.json (preferred — confirmed working by [@tetsuco in dario#97](https://github.com/askalf/dario/issues/97))**

Open `~/.openclaw/agents/main/agent/auth-profiles.json` in any editor, remove the `"anthropic:default"` entry (or the whole file if Anthropic is the only profile in there), save. OpenClaw falls back to the env vars on next run.

**Option B: overwrite the auth-profiles.json entry with `dario`**

```bash
openclaw models auth paste-token --provider anthropic
# When prompted, paste the literal string: dario
```

This replaces whatever was in the file with `dario`. Keep a backup if you use the original key elsewhere.

> **Loopback escape hatch.** If you're running dario at `--host=127.0.0.1` (the default), you don't need `DARIO_API_KEY` set at all and the auth-profiles content matters less — dario only enforces auth on non-loopback binds. So if you can stay on loopback, do; the auth-profiles dance is only needed for LAN reach setups (Tailscale, multi-host).

### Step 3 — Verify the config takes effect

```bash
echo "$ANTHROPIC_BASE_URL"
# expected: http://localhost:3456
```

If that's empty, restart your shell or `source` your profile.

### Battletested model choices

OpenClaw exposes its model selection through its own config. We default to:

| Model | When to use | Notes |
|---|---|---|
| `claude-sonnet-4-6` | **Default for everything.** | Best quality/speed for agent loops. What we run 95% of the time. |
| `claude-opus-4-7` | Hard reasoning tasks, refactors, novel architecture | ~3× slower per turn, ~3× more tokens. Subscription absorbs the cost; your wall-clock pays. Worth it for one-shot heavy lifts, overkill for routine. |
| `claude-haiku-4-5` | Fast scripts, quick lookups, smoke tests | Cheap on tokens, weak on multi-step reasoning. Don't run a long autonomous OpenClaw session on Haiku. |

Set the model in OpenClaw's config (the field name varies by OpenClaw version — check `openclaw config --help`). Use the canonical Anthropic model ID (no provider prefix) — OpenClaw is already on the Anthropic protocol.

## First run

Start dario in one terminal:

```bash
dario proxy --verbose
```

Leave it running. You'll watch real-time request logs here.

In a second terminal, run an OpenClaw task:

```bash
openclaw "Add a function to utils.py that takes a list of strings and returns them sorted by length, longest first. Include a docstring and a basic test."
```

(Exact invocation may differ by OpenClaw version — check `openclaw --help`. The above is the conceptual shape; substitute the right flags for your install.)

Watch the dario terminal — you should see one log line per request, looking like:

```
[dario] #1 POST /v1/messages (model: claude-sonnet-4-6) → 200 (1843 ms)
[dario] #2 POST /v1/messages (model: claude-sonnet-4-6) → 200 (2104 ms)
...
```

If you see `→ 200` lines and OpenClaw is making progress, you're good. dario's `client: 'unknown-non-cc'` structural fallback is silently auto-translating OpenClaw's `exec` / `process` / `web_search` / `web_fetch` / `browser` / `message` tools to CC's canonical set on the outbound path and rebuilding the OpenClaw shape on the inbound path — no flag, no config.

## Verifying subscription billing (the important part)

This is what separates "OpenClaw talking to dario" from "OpenClaw actually using your Claude subscription." Two checks:

### Check 1: dario doctor --usage

```bash
dario doctor --usage
```

You should see your 5-hour bucket showing non-zero usage with `claim=five_hour (subscription)`:

```
[ OK ]  Usage 5h (all)          12.3% used  •  status=allowed  •  claim=five_hour (subscription)
```

If `claim=five_hour (subscription)` shows up, you're billing against subscription, not API. Done.

If `claim=api` shows up, something flipped you to per-token billing. The most common cause for OpenClaw users is the next section.

### Check 2: Anthropic dashboard

Log into [console.anthropic.com](https://console.anthropic.com) → Usage. **Your API spend should be flat** (no new charges since you started OpenClaw). If it's climbing, something is bypassing dario.

## How dario protects you from the classifier filter

Anthropic's billing classifier fingerprints the string `openclaw.inbound_meta.v1` and routes any request containing it to extra-usage billing — not subscription. This was reproduced in [dario discussion #178](https://github.com/askalf/dario/discussions/178) following Theo Browne's original finding.

The filter triggers on the `openclaw.inbound_meta.v1` namespace appearing in the request body — which is easy to hit accidentally. If you've ever made a commit message or branch name containing that string in any of your repos, Claude Code's environment block (which CC adds to its prompt) will surface those names back to the model in the system prompt, and the classifier flips your request.

**dario's default template-replay mode protects you from this automatically.** Every outbound request gets rebuilt from dario's captured-fresh CC system prompt — your local git context (commit messages, branch names, modified-file lists) is discarded at the proxy boundary. The `openclaw.inbound_meta.v1` string never leaves your machine.

You don't need to do anything to get this protection — it's the default. The protection is validated by `scripts/test-dario-protects-openclaw.mjs` against real Anthropic upstream traffic.

> **If you want to verify it on your own machine:** create a temp git repo with `{"schema": "openclaw.inbound_meta.v1"}` as a commit message, run OpenClaw against dario from inside that repo, and check `dario doctor --usage` — you should still see `claim=five_hour`. Without dario, the same setup would 400 or flip to api-billing.

## Common gotchas

### `401 Unauthorized` from dario, even though `ANTHROPIC_API_KEY=dario` is set

This is the auth-profiles.json priority issue ([dario#97](https://github.com/askalf/dario/issues/97)). OpenClaw is reading a stale Anthropic key from `~/.openclaw/agents/main/agent/auth-profiles.json` instead of your env var. Run `dario proxy -v` to confirm — you'll see `Authorization present but value mismatch (header: x-api-key)` in the reject log. Fix with one of the three options in Step 2 above.

### `Connection refused` to localhost:3456

dario isn't running, or it's bound to a different port:

```bash
curl -s http://localhost:3456/health
# expected: {"status":"ok",...}
```

If that fails, start dario (`dario proxy --verbose`). If it's running on a custom port, match it: `ANTHROPIC_BASE_URL=http://localhost:<port>`.

### `claim=api` showing up in dario doctor --usage

Something is sneaking the `openclaw.inbound_meta.v1` string past dario's template replay. The most common cause is running with `dario proxy --passthrough` (thin proxy, no template injection) — passthrough mode does an OAuth swap only and does NOT scrub the system prompt, so any classifier triggers in your local env survive. Drop the `--passthrough` flag and the default template-replay mode will protect you.

If you actually need passthrough mode for some other reason, you'll need to clean your local git state — rename branches with `openclaw` in their names, rewrite commit messages with that string, and remove any files in your working tree that contain the classifier-fingerprint namespace.

### Long sessions failing with rate limits

If you run multiple parallel OpenClaw sessions on a single Claude account, you'll hit the 5-hour rate limit fast. Two fixes:

1. **Add a second account to dario's pool** (`dario accounts add work` after running `dario login` on a second account). Pool mode routes each request to whichever account has the most headroom and uses session stickiness so multi-turn chats stay on one account. See [`docs/multi-account-pool.md`](./multi-account-pool.md).
2. **Stagger the runs** — finish one before starting the next. Cheaper, no extra subscription needed.

### Tools come back empty / wrong shape

Symptom: OpenClaw's tool calls round-trip with stripped fields, or your runtime complains about a required field being absent only when routed through dario.

If you see this, run dario with `--preserve-tools`:

```bash
dario proxy --preserve-tools
```

This skips the CC tool remap entirely and forwards OpenClaw's tool definitions through to the model unchanged. You lose the CC wire shape (and may lose subscription billing), but you keep all custom tool fields. Reserve for cases where the auto-detection can't reconstruct your schema cleanly.

## What this guide doesn't cover

- **OpenClaw's own internal config flags.** OpenClaw has a rich CLI with options for sandbox, project root, agent loop tuning, etc. We don't shadow them here; check `openclaw --help`. The dario integration is at the LLM layer; agent code doesn't need to change.
- **OpenClaw derivatives** (forks like `openclaw-billing-proxy`, `nanoclaw`, etc.). These typically work the same way — point them at `localhost:3456` and dario's structural-fallback tool detection (the 3+ tools, ≥80% not in TOOL_MAP rule) catches them automatically. If a specific fork doesn't work, open an issue with the request body shape and we'll add explicit detection.

## Quick reference card

```bash
# One-time setup
# (install OpenClaw per its README)
npm install -g @askalf/dario
dario login

# Per-session
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
# (clear ~/.openclaw/agents/main/agent/auth-profiles.json first if you have a stale Anthropic key)
dario proxy --verbose &
openclaw "your task here"

# Verify subscription billing
dario doctor --usage   # claim=five_hour (subscription) ✓
```

## Related guides

- [`openhands-walkthrough.md`](./openhands-walkthrough.md) — sister walkthrough for OpenHands
- [`agent-compat.md`](./agent-compat.md) — short setup snippets for every other agent dario supports
- [`multi-account-pool.md`](./multi-account-pool.md) — adding 2+ Claude accounts to extend rate limits
- [`commands.md`](./commands.md) — full dario CLI reference
- [`faq.md`](./faq.md) — common dario questions, including the OpenClaw auth-profiles 401 entry
- [`research/system-prompt.md`](./research/system-prompt.md) — empirical work on what the billing classifier reads (and doesn't)
