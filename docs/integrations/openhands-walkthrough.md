# dario + OpenHands — battletested setup

End-to-end walkthrough for running [OpenHands](https://github.com/All-Hands-AI/OpenHands) (the open-source software-engineer agent, formerly OpenDevin) through dario so it routes against your Claude Pro / Max subscription instead of paying per-token API rates. Covers install → config → first run → verification → the gotchas that bite first-time users.

This is opinionated. There are several ways to wire OpenHands to dario; this is the one we run in production and trust to not surprise us. Where we omit options it's because they're worse, not because they don't exist.

## What you'll have at the end

- OpenHands running locally, talking to dario at `localhost:3456`
- All Claude API calls routed through your Pro / Max subscription via the Claude Code wire shape
- Multi-turn agent loops running on subscription billing, not per-token
- `dario doctor --usage` showing the OpenHands traffic in your 5-hour bucket
- A working `--task` invocation you can drop into a script

Total install + config: 10–15 minutes if Python and dario are already installed.

## Prerequisites

| Thing | Version | Why |
|---|---|---|
| **Python** | 3.12+ | OpenHands' minimum |
| **Poetry** or **pipx** | recent | OpenHands' install flow |
| **dario** | v3.30+ (latest preferred — `npm i -g @askalf/dario@latest`) | OpenAI-compat endpoint plus the provider-prefix routing this guide leans on |
| **A Claude OAuth login** | run `dario login` once | The whole point — a Pro / Max subscription on a Claude account |
| **Bun** (recommended) | 1.1+ | dario auto-relaunches under Bun for TLS-fingerprint fidelity. Skip if you're fine with a runtime banner; install via [bun.sh](https://bun.sh) for the full subscription wire shape. |

Verify dario before starting OpenHands install — saves you from chasing OpenHands errors that are actually dario auth issues:

```bash
dario doctor          # all green = ready
dario status          # OAuth healthy, expires in N hours
```

If `dario status` shows expired or missing OAuth, run `dario login` and retry. Don't continue past this step until both are clean.

## Install OpenHands

The official path uses `pipx` for a clean install that doesn't fight your system Python:

```bash
pipx install openhands-ai
```

If you don't have pipx: `python -m pip install --user pipx && pipx ensurepath`, then start a new shell.

Verify:

```bash
openhands --version
```

If you'd rather run from a clone (faster iteration on agent code, harder to keep updated):

```bash
git clone https://github.com/All-Hands-AI/OpenHands.git
cd OpenHands
poetry install
```

Both paths give you the `openhands` CLI. The rest of this guide assumes the pipx path.

## Configure OpenHands → dario

OpenHands reads config from environment variables and an optional `config.toml`. We use environment variables for everything because they're easier to swap when testing different Claude models or pool accounts.

### The minimum working config

Put this in your shell profile (`~/.bashrc`, `~/.zshrc`, `~/.config/fish/config.fish`, or PowerShell `$PROFILE`):

```bash
export LLM_BASE_URL=http://localhost:3456
export LLM_API_KEY=dario
export LLM_MODEL=anthropic/claude-sonnet-4-6
```

Three things to know about each line:

- `LLM_BASE_URL=http://localhost:3456` — points OpenHands at dario instead of `api.anthropic.com`. dario speaks both Anthropic and OpenAI protocols on this port; OpenHands picks Anthropic because of the model name in the next line.
- `LLM_API_KEY=dario` — this string is a literal placeholder. dario doesn't validate it; the real auth lives in dario's stored OAuth token. Putting a dummy value here is intentional. If you're running dario with `DARIO_API_KEY` set (LAN/multi-host mode), use that value here instead.
- `LLM_MODEL=anthropic/claude-sonnet-4-6` — the `anthropic/` prefix tells LiteLLM (OpenHands' inner routing layer) "use the Anthropic protocol" — that's what makes OpenHands hit dario's `/v1/messages` endpoint instead of `/v1/chat/completions`. Without the prefix, LiteLLM defaults to OpenAI shape and dario will translate it but you lose subscription-billing fidelity. **Always use the `anthropic/` prefix.**

### Battletested model choices

| Model | When to use | Notes |
|---|---|---|
| `anthropic/claude-sonnet-4-6` | **Default for everything.** | Best quality/speed for agent loops. What we run 95% of the time. |
| `anthropic/claude-opus-4-7` | Hard reasoning tasks, refactors, novel architecture | ~3× slower per turn, ~3× more tokens. Subscription absorbs the cost; your wall-clock pays. Worth it for one-shot heavy lifts, overkill for routine. |
| `anthropic/claude-haiku-4-5` | Fast scripts, quick lookups, smoke tests | Cheap on tokens, weak on multi-step reasoning. Don't run a multi-hour agent loop on Haiku. |

We do **not** recommend mixing models inside a single OpenHands run via the `LLM_DRAFT_MODEL` setting — the runtime overhead of switching wire shapes mid-conversation costs more than the smaller-model savings.

### Optional but useful

```bash
# Maximum tokens per response (default is conservative)
export LLM_MAX_OUTPUT_TOKENS=8192

# Cap input context to stay safely under Anthropic's per-model ceiling.
# Sonnet 4.6 supports 200k natively; OpenHands defaults to 128k. Leave at default
# unless you've seen 'context too long' errors during long sessions.
# export LLM_MAX_INPUT_TOKENS=128000

# Temperature — keep low for code agents.
export LLM_TEMPERATURE=0.0
```

### Verifying the config loads

```bash
echo "$LLM_BASE_URL $LLM_MODEL"
# expected: http://localhost:3456 anthropic/claude-sonnet-4-6
```

If those don't print, the env vars didn't load — restart your shell or `source` your profile.

## First run

Start dario in one terminal:

```bash
dario proxy --verbose
```

Leave it running. You'll watch real-time request logs here.

In a second terminal, run an OpenHands task:

```bash
openhands --task "Add a function to utils.py that takes a list of strings and returns them sorted by length, longest first. Include a docstring and a basic test."
```

OpenHands will:

1. Spin up its workspace
2. Ask Claude (via dario) what to do
3. Execute file edits, run tests, and iterate

Watch the dario terminal — you should see one log line per request, looking like:

```
[dario] #1 POST /v1/messages (model: claude-sonnet-4-6) → 200 (1843 ms)
[dario] #2 POST /v1/messages (model: claude-sonnet-4-6) → 200 (2104 ms)
...
```

If you see `→ 200` lines and OpenHands is making progress, you're good.

## Verifying subscription billing (the important part)

This is what separates "OpenHands talking to dario" from "OpenHands actually using your Claude subscription." Two checks:

### Check 1: dario doctor --usage

```bash
dario doctor --usage
```

You should see your 5-hour bucket showing non-zero usage with `claim=five_hour (subscription)`:

```
[ OK ]  Usage 5h (all)          12.3% used  •  status=allowed  •  claim=five_hour (subscription)
```

If `claim=five_hour (subscription)` shows up, you're billing against subscription, not API. Done.

If `claim=api` shows up, something flipped you to per-token billing — usually the model name is wrong (missing `anthropic/` prefix) or you set `DARIO_API_KEY` and OpenHands didn't pass it correctly.

### Check 2: Anthropic dashboard

Log into [console.anthropic.com](https://console.anthropic.com) → Usage. **Your API spend should be flat** (no new charges since you started OpenHands). If it's climbing, something is bypassing dario.

## Common gotchas

### `Error: model not found: anthropic/claude-sonnet-4-6`

LiteLLM's local model registry is out of date. Two options:

- Upgrade OpenHands: `pipx upgrade openhands-ai`
- OR set the model without the `anthropic/` prefix and let dario's `claude-*` regex catch it: `LLM_MODEL=claude-sonnet-4-6`. This loses some LiteLLM routing intelligence but works. You may also use dario's provider-prefix syntax: `LLM_MODEL=claude:claude-sonnet-4-6`.

### `Connection refused` to localhost:3456

dario isn't running, or it's bound to a different port:

```bash
curl -s http://localhost:3456/health
# expected: {"status":"ok",...}
```

If that fails, start dario (`dario proxy --verbose`). If it's running but on a custom port, match it: `LLM_BASE_URL=http://localhost:<port>`.

### OpenHands hangs at "thinking..." for >60 seconds, then times out

dario's outbound timeout to Anthropic is 5 min by default; if OpenHands gives up sooner, set its retry config:

```bash
export LLM_NUM_RETRIES=3
export LLM_RETRY_MIN_WAIT=2
export LLM_RETRY_MAX_WAIT=60
```

This makes OpenHands more patient. Anthropic occasionally serves slow first-token latency on subscription traffic; the retry layer absorbs it cleanly.

### Long sessions fail with `context_length_exceeded`

OpenHands' context manager doesn't always trim aggressively enough. If a session runs hot, set:

```bash
export LLM_MAX_INPUT_TOKENS=180000   # Sonnet 4.6 native ceiling minus headroom
```

For very long autonomous runs, switch the agent to `--config-file` mode and enable OpenHands' context-condensation feature explicitly. The TOML config has more knobs than the env vars expose.

### Multiple OpenHands sessions starve a single Claude account

If you run two or more parallel OpenHands sessions, you'll hit the 5-hour rate limit fast. Two fixes:

1. **Add a second account to dario's pool** (`dario accounts add work` after running `dario login` on a second account). Pool mode routes each request to whichever account has the most headroom and uses session stickiness so multi-turn chats stay on one account. See [`docs/multi-account-pool.md`](./multi-account-pool.md).
2. **Stagger the runs** — finish one before starting the next. Cheaper, no extra subscription needed.

### "Claim flipped to api during a session"

Anthropic's billing classifier occasionally rejects subscription traffic if the request body fingerprint drifts. dario captures CC's exact wire shape weekly and pins it; if you see this happen, run `dario doctor` first — it'll show whether your CC version is current. If `template: live capture, CC vX.Y.Z (Nh old)` is more than 48 hours old, do `dario doctor --bun-bootstrap` to force a fresh capture.

## What this guide doesn't cover

- **OpenHands web UI** (`openhands serve`). Same env vars work; the walkthrough above is TUI/CLI-focused because that's where battletesting time has gone. The web UI works but we don't run it routinely.
- **Custom OpenHands agents.** Subclassing `Agent` to write your own controller is supported but out of scope here. The dario integration is at the LLM layer; agent code doesn't need to change.
- **Sandbox configuration.** OpenHands runs commands in Docker by default. dario doesn't care which sandbox you use; pick whichever your security model requires.

## Quick reference card

```bash
# One-time setup
pipx install openhands-ai
npm install -g @askalf/dario
dario login

# Per-session
export LLM_BASE_URL=http://localhost:3456
export LLM_API_KEY=dario
export LLM_MODEL=anthropic/claude-sonnet-4-6
dario proxy --verbose &
openhands --task "your task here"

# Verify subscription billing
dario doctor --usage   # claim=five_hour (subscription) ✓
```

## Related guides

- [`agent-compat.md`](./agent-compat.md) — short setup snippets for every other agent dario supports (Cursor, Continue, Aider, Cline, Zed, GitHub Copilot, etc.)
- [`multi-account-pool.md`](./multi-account-pool.md) — adding 2+ Claude accounts to extend rate limits
- [`commands.md`](./commands.md) — full dario CLI reference
- [`faq.md`](./faq.md) — common dario questions independent of which agent you're running
