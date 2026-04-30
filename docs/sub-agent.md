# Claude Code sub-agent hook (v3.26)

`dario subagent install` writes `~/.claude/agents/dario.md` so Claude Code has a named handle for running dario diagnostics and template-refresh inside an ongoing CC session. No more `Ctrl+Z → dario doctor → fg` when you hit a `[WARN]` row mid-conversation.

```bash
dario subagent install    # writes ~/.claude/agents/dario.md
dario subagent status     # {not-installed, installed+current, installed+stale} + hint
dario subagent remove     # idempotent
```

**Tool-scoped.** The sub-agent is restricted to `Bash, Read` and its prompt forbids destructive operations (credential mutation, account pool changes, backend config changes) without explicit user confirmation. `dario proxy` is also off-limits from inside the sub-agent — it would block the parent CC session. CC can ask dario to *report*, not to *change state*. (The MCP server has the same read-only boundary for the same reason.)

A version marker (`<!-- dario-sub-agent-version: X -->`) embedded in the markdown lets `dario doctor` distinguish installed-and-current from installed-and-stale; the "Sub-agent" row appears between Backends and Home with an inline refresh command when stale.
