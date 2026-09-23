# Commands

| Command | What it does |
|---|---|
| `dario` | The TUI: status, config editor, analytics, hits, accounts, backends |
| `dario login [--manual]` | Log in to your Claude plan. Picks up Claude Code's credentials or runs its own OAuth flow; `--manual` for SSH / containers |
| `dario proxy` | Start the local endpoint on `:3456` |
| `dario doctor [--usage] [--probe] [--obedience] [--auth-check] [--bun-bootstrap] [--json]` | One aggregated health report: runtime/TLS, template and drift, OAuth, pool, refresh-grant age, failover readiness, backends |
| `dario add altman` / `dario add amodei` | Attach a ChatGPT plan / a Claude account, by whose it is |
| `dario accounts list` / `add` / `remove` / `check <alias>` | Pool management; `check` sends one pinned request per model through the running proxy (admin API on) |
| `dario keys create <name>` / `list` / `revoke` / `rotate` | One credential per developer on a shared dario: attributed by key, optional preferred seat and model allowlist, hashes on disk ([keys.md](keys.md)) |
| `dario backend list` / `add` / `remove` | OpenAI-compatible API-key backends |
| `dario codex list` / `add` / `remove` | ChatGPT accounts (the long form of `dario add altman`) |
| `dario usage` · `dario compare` · `dario config` · `dario status` | Lifetime API-equivalent spend + burn rate for the last hour (`--card` writes the share card, `--by-key` splits it per key) · read the shadow-compare log · effective config, redacted · token health |
| `dario resume` · `dario refresh` · `dario logout` · `dario upgrade` | Clear an overage halt · force a token refresh · delete credentials · safe self-update |
| `dario mcp` · `dario subagent install` / `remove` / `status` | Reach dario from inside any MCP client, or from inside a Claude Code session, read-only |

| Endpoint | Description |
|---|---|
| `POST /v1/messages` · `POST /v1/chat/completions` | The two wire shapes, any plan behind either |
| `GET /v1/models` | Live model list: the Claude catalog plus whatever your ChatGPT plan lists |
| `GET /health` · `GET /livez` | Serviceability (503 when not) · liveness. `/health?probe=1` sends one real request |
| `GET /status` · `GET /accounts` · `GET /analytics` | OAuth detail · per-seat utilization and grant age · per-account / per-model stats and burn rate |
| `POST /v1/messages/count_tokens` · `POST /v1/complete` | Token counting and the legacy Text Completions shape |
| `GET /analytics/stream` · `GET /analytics/ledger` · `GET /codex` | Live analytics over SSE · the ledger's per-day table · ChatGPT-seat status and utilisation (used %, window, reset, headroom), read without spending or exposing a token |
| `/admin/*` | Provisioning, `GET /admin/accounts`, `/admin/keys`, `POST /admin/resume`; only with `DARIO_ADMIN=1` ([admin API](admin-api.md)) |

Flags: [commands.md](commands.md), plus `dario --help` for the ones it doesn't list yet (`--effort`, `--max-tokens`, `--model-alias`, `--fast-model`, session rotation, concurrency caps, the pacing knobs behind `--stealth`) · env vars grouped by task, for Docker / k8s / systemd: [configuration.md](configuration.md) · SDK examples: [usage.md](usage.md).

<details>
<summary><strong>More knobs</strong> — stealth timing, system-prompt modes, client-shape overrides, VPN egress, MCP</summary>

- **Behavioral stealth (`--stealth`).** Adds *when* a request arrives to *what* it looks like: response-length-correlated think time and session-start latency. [wire-fidelity.md](wire-fidelity.md)
- **Recover output (`--system-prompt=partial`).** Strips Claude Code's tone and verbosity constraints for 1.2–2.8× more output on open-ended work, without changing which pool you bill to. [#183](https://github.com/askalf/dario/discussions/183) · [system-prompt.md](system-prompt.md)
- **Client-shape overrides.** `--honor-client-thinking` passes a client's own `thinking` block through; `--preserve-output-format` carries a client's `output_config.format` JSON schema through so structured-output SDKs get schema-constrained output. Both off by default.
- **Runs any agent.** A 64-entry schema-verified `TOOL_MAP` pre-maps Cline, Roo, Kilo, Cursor, Windsurf, Continue, Copilot, OpenHands, OpenClaw and Hermes tool names to Claude Code's native set; MCP tools (`mcp__server__tool`) forward verbatim. Custom schemas: `--preserve-tools` or `--hybrid-tools`. [agent-compat.md](integrations/agent-compat.md)
- **Model aliases and caps.** `--model-alias=<name=target>` (repeatable) advertises a name of your choosing on `/v1/models` and routes it; `--effort=<low|medium|high|xhigh|ultracode|max|client>` and `--max-tokens=<N|client>` set, or pass through, per-request effort and output caps.
- **VPN / egress routing.** Route dario's upstream traffic through a VPN without putting the whole host on one. [vpn-routing.md](vpn-routing.md)
- **More than one instance, same accounts.** Refresh tokens are single-use, so two replicas refreshing the same seat leave one holding a dead token; the optional refresh lock (Redis or Cloudflare) makes the loser adopt the winner's credentials. [multi-instance.md](multi-instance.md)
- **PII redaction in front of dario.** Pair it with [cordon](https://github.com/askalf/cordon): [integrations/cordon.md](integrations/cordon.md)
- **Reachable from inside Claude Code or any MCP client.** `dario subagent install` registers a sub-agent for in-session diagnostics; `dario mcp` exposes dario as a read-only MCP server. [sub-agent.md](sub-agent.md) · [mcp-server.md](mcp-server.md)
</details>

---

[← README](../README.md) · [all reference docs](../README.md#reference)
