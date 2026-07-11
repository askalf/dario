# Migrating from dario v4.x to v5.0

v5 is a **breaking simplification**, not a feature release. It removes a deprecated transport and collapses two credential code paths into one. The single-command UX for solo users is unchanged: `dario login` + `dario proxy` still just works.

This milestone lands in sub-PRs behind [#701](https://github.com/askalf/dario/issues/701). This section documents each change as it ships.

## Shim mode is removed

`dario shim` is gone. It was deprecated in v4.2 (with removal scheduled for v5.x) because it only normalized 3 of the 8 wire-shape axes Anthropic's billing classifier inspects, and on the 1-block system prompts that `claude -p` and the Agent SDK both send it silently fell back to total passthrough — the client's raw body reached `api.anthropic.com` unchanged. Proxy mode rebuilds every request to Claude Code's full canonical shape and is strictly better for every non-CC client.

**What to do:** replace any `dario shim -- <cmd>` invocation with proxy mode.

```diff
-dario shim -- aider --model claude/claude-opus-4-7
+# Terminal 1
+dario proxy
+# Terminal 2
+ANTHROPIC_BASE_URL=http://localhost:3456 ANTHROPIC_API_KEY=dario \
+  aider --model claude/claude-opus-4-7
```

`dario shim` still resolves as a command — it now prints this pointer and exits 1 instead of running, so a script that hasn't migrated fails loud rather than silently.

**If you used `dario shim --priority=<level>`** on a Windows RDP host to keep heavy `claude` sessions from starving the network IO threads: that scheduling-class knob was a property of the child dario spawned. Set the priority via the OS instead — `start /belownormal /b claude`, `(Get-Process claude).PriorityClass = 'BelowNormal'`, or Process Lasso. See the RDP entry in [`docs/faq.md`](./docs/faq.md).

**Removed env var:** `DARIO_SHIM_NO_DEPRECATION_WARNING` no longer does anything (there's no banner to suppress).

## What didn't change (v5)

- Proxy mode, the TUI, the multi-account pool, OAuth, backends, and every other subcommand behave exactly as in v4.
- Solo `dario login` + `dario proxy` is unchanged.

---

# Migrating from dario v3.x to v4.0

v4 introduces an interactive TUI as the default surface for `dario`. The proxy server is unchanged; what changes is how you launch it and how you discover / tune settings.

## TL;DR

**One breaking change.** Two changes you'll likely notice:

| Concern | v3.x | v4.0 |
|---|---|---|
| Bare `dario` | starts proxy server | opens TUI |
| Start the proxy explicitly | `dario` | `dario proxy` |
| See current state | `dario status` / `dario doctor` | `dario` (TUI's Status tab) |
| Edit a setting | hand-edit shell script / env vars | `dario` → Config tab → Enter / `s` |
| Watch token burn | `dario usage` (one-shot) | `dario` → Analytics tab (live, 2s refresh) |
| See requests as they happen | `--verbose` proxy log | `dario` → Hits tab |

**If you have a script or systemd unit that runs `dario`**, change it to `dario proxy`.

## The breaking change in one paragraph

In v3.x, `dario` with no arguments started the proxy server. In v4, `dario` with no arguments opens the interactive TUI. The proxy server is unchanged — `dario proxy` does exactly what bare `dario` did in v3. If your shell history says `dario &` to start a background proxy, you now want `dario proxy &`.

Everything else is opt-in additive.

## How to migrate, step by step

### 1. Update any startup script

```diff
-# my-startup.sh
-dario &
+# my-startup.sh
+dario proxy &
```

Same for systemd / launchd / Docker entrypoints — anywhere you spawn `dario` non-interactively, point at `dario proxy` explicitly.

### 2. Try the TUI

```sh
dario
```

The TUI opens. Tabs cycle with **Tab** (or jump by hotkey: `s` Status, `c` Config, `A` Analytics, `h` Hits, `a` Accounts, `b` Backends). **q** quits. **r** refreshes the active tab.

If the TUI shows "proxy unreachable" — that's expected when no proxy is running. Start one in another terminal:

```sh
dario proxy
```

Then come back to the TUI and the Analytics / Hits / Status tabs populate live.

### 3. (Optional) Persist settings in `~/.dario/config.json`

v4 introduces a config file the TUI's Config tab can write. Schema:

```json
{
  "version": 1,
  "port": 3456,
  "host": "127.0.0.1",
  "stealth": true,
  "drainOnClose": false,
  "pacing":      { "minMs": 500,  "jitterMs": 300 },
  "thinkTime":   { "baseMs": 800, "perTokenMs": 4, "jitterMs": 1500, "maxMs": 25000 },
  "sessionStart":{ "minMs": 1200, "jitterMs": 3000 }
}
```

Precedence: `CLI flag > env var > config file > built-in default`. The file is purely additive — everything in v3.x continues to work unchanged.

The TUI is the easiest editor; alternatively you can write this file by hand or via your own tool.

### 4. (Optional) Use `--no-tui` for CI scripts

If a CI script greps the output of bare `dario` for help text, the v4 default opens a TUI that won't render usefully in a non-TTY pipe (it exits 1 with `"TUI requires an interactive terminal"`). The clean migration is `dario help` or `dario --help`. As a temporary escape hatch:

```sh
dario --no-tui    # falls back to help
```

## What didn't change

- The proxy server's HTTP behavior is identical to v3.38.6. Same endpoints, same wire shapes, same OAuth flow, same rate-limit semantics. v4 is purely a UX layer + analytics-streaming addition on top.
- All v3 CLI subcommands continue to work: `dario login`, `dario status`, `dario doctor`, `dario accounts`, `dario backend`, `dario usage`, `dario config`, `dario shim`, `dario subagent`, `dario mcp`, `dario upgrade`. Same flags, same env vars.
- Existing `--flag` and `DARIO_*` env vars take precedence over the new config file. Nothing in your environment auto-changes meaning.
- The bundled CC template, OAuth flow, account pool, OpenAI-compat backends — all unchanged.

## New things to know about

- **`dario` (no args)** opens the TUI. **`dario proxy`** starts the server.
- **`~/.dario/config.json`** is read at proxy startup if present.
- **`GET /analytics/stream`** on the running proxy is a Server-Sent Events feed of every request as it lands. Drives the TUI's Hits tab; also usable directly: `curl -N http://localhost:3456/analytics/stream`.
- **Analytics is always-on** now. Pre-v4 the `/analytics` endpoint was gated to pool mode; in v4 single-account users get the full summary too.

## Reporting issues

- TUI bugs: tag with `v4-tui` on dario#new
- Migration friction: same — we'd rather hear about it than have it sit silently broken on your machine
