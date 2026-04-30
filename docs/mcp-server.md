# dario as MCP server (v3.27)

`dario mcp` turns dario itself into a **stdio JSON-RPC 2.0 MCP server**. Claude Desktop, Cursor, Zed, any MCP-aware editor can introspect dario's state without leaving the editor.

```bash
dario mcp        # spawns the MCP server on stdin/stdout — wire it up to your MCP client
```

**Strictly read-only.** The exposed tool set is:

| Tool | What it reports |
|---|---|
| `doctor` | Full aggregated health report — same output as `dario doctor` |
| `status` | OAuth authentication state (authenticated / no-credentials / expired-but-refreshable) |
| `accounts_list` | Pool accounts + expiry times. Never touches API keys. |
| `backends_list` | Configured OpenAI-compat backends — keys redacted completely (not even a `sk-…` prefix) |
| `subagent_status` | CC sub-agent install and version-match state |
| `fingerprint_info` | Runtime / TLS classification, template source + schema version |

Mutations (`login`, `logout`, `accounts add/remove`, `backend add/remove`, `subagent install/remove`, `proxy` start/stop) are **not** exposed. An MCP client can observe dario; changing dario's state stays a CLI action the user types with intent. The test suite asserts the forbidden-tool set stays forbidden so a future accidental drift gets caught.

Zero runtime deps — the JSON-RPC dispatcher is hand-rolled over Node's `readline`. `src/mcp/protocol.ts` + `src/mcp/tools.ts` + `src/mcp/server.ts` are each pure over their inputs (streams are injectable, data sources are injectable) so the e2e test runs in-process against a `PassThrough` pair.
