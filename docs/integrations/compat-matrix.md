# Compatibility matrix

One-page status table per tool. The setup details for each row live in [`agent-compat.md`](./agent-compat.md) and the per-tool walkthroughs (`hands-walkthrough.md`, `openhands-walkthrough.md`, `openclaw-walkthrough.md`); this page is just "does it work?" with an honest cell per tool.

Status legend:

- **✅ Working** — code path exercised, walkthrough or per-tool docs exist, no known dario-side gaps.
- **⚪ Inferred** — uses a generic protocol path (Anthropic SDK or OpenAI-compat passthrough) that dario handles correctly, but no tool-specific test exists. Should work; report if not.
- **🟡 Untested** — listed in the README's "every tool that honors those env vars" sentence, but no walkthrough, no per-tool docs, and no smoke test.

| Tool | Protocol | Routes via | Status | Setup |
|---|---|---|---|---|
| **Claude Code** | Anthropic Messages | Claude backend | ✅ Working | Default — what dario was built around. `dario login`, `dario proxy`, no per-tool config. |
| **Cursor** (BYOK Custom OpenAI) | Anthropic Messages | Claude backend | ✅ Working | Cloudflared tunnel + `anthropic:` model prefix + Agent mode. Long form: [`agent-compat.md#cursor`](./agent-compat.md#cursor). |
| **Continue.dev** | Anthropic / OpenAI | Either | ✅ Working | [`agent-compat.md#continuedev`](./agent-compat.md#continuedev) |
| **Aider** | Anthropic / OpenAI | Either | ✅ Working | [`agent-compat.md#aider`](./agent-compat.md#aider) |
| **Cline / Roo Code / Kilo Code** | Anthropic (text-tool) | Claude backend | ✅ Working | Auto-flips into preserve-tools mode via system-prompt identity markers. [`agent-compat.md#cline--roo-code--kilo-code`](./agent-compat.md#cline--roo-code--kilo-code) |
| **Zed** | Anthropic | Claude backend | ✅ Working | [`agent-compat.md#zed`](./agent-compat.md#zed) |
| **OpenHands** | Anthropic | Claude backend | ✅ Working | Full walkthrough: [`openhands-walkthrough.md`](./openhands-walkthrough.md) |
| **OpenClaw** | Anthropic | Claude backend | ✅ Working | Full walkthrough: [`openclaw-walkthrough.md`](./openclaw-walkthrough.md). Identity-detected for preserve-tools. |
| **hands** | Anthropic | Claude backend | ✅ Working | Full walkthrough: [`hands-walkthrough.md`](./hands-walkthrough.md). Identity-detected. |
| **CC sub-agents** | Anthropic | Claude backend | ✅ Working | `dario subagent install` registers a CC sub-agent that exposes `dario doctor` and other read-only diagnostics inside any CC session. [`sub-agent.md`](./sub-agent.md) |
| **Claude Agent SDK** | Anthropic | Claude backend | ✅ Working | `baseURL: 'http://localhost:3456'` on the `Anthropic` client. SDK examples in [`usage.md`](./usage.md). |
| **MCP clients (any)** | MCP / JSON-RPC | dario as MCP server | ✅ Working | `dario mcp` exposes dario as a read-only MCP server. [`mcp-server.md`](./mcp-server.md) |
| **Codex CLI** | OpenAI | OpenAI-compat backend | ⚪ Inferred | `dario backend add openai --key=...` then point Codex CLI at `OPENAI_BASE_URL=http://localhost:3456/v1`. The OpenAI backend is a byte-for-byte passthrough (verified by `test/openai-backend-passthrough.mjs`); no Codex-specific code path exists or is needed. |
| **Hermes** | Anthropic | Claude backend | ⚪ Inferred | Identity-detected by name in CC's identity markers; routes through the standard preserve-tools path. No dedicated walkthrough yet. |
| **Windsurf** | Anthropic | Claude backend | 🟡 Untested | Listed in README — uses Anthropic-shape requests, should pass through dario's Claude backend. No dedicated walkthrough or smoke test. Open an issue with `dario doctor` output if it doesn't work. |
| **Claude Desktop** | Anthropic | Claude backend | 🟡 Untested | Generic Anthropic SDK consumer; should work via the same path Claude Code uses. No dedicated walkthrough. |
| **GitHub Copilot** | Proprietary | n/a | 🟡 Not applicable | Copilot's BYOK paths are surface-specific (Copilot Chat in VS Code, GitHub.com, etc.) and don't expose a generic OpenAI/Anthropic base-URL override. Listed in README for completeness; no dario integration is currently possible without a vendor-side change. |

## What "Inferred" means in practice

For ⚪ Inferred entries, the underlying protocol path is identical to a tested one — the generic OpenAI-compat passthrough (`forwardToOpenAI` in [`src/openai-backend.ts`](../src/openai-backend.ts), exercised by `test/openai-backend-passthrough.mjs`) or the standard Anthropic backend path. There's no tool-specific code to break; the dario-side risk is "did the upstream provider rotate something we cared about", which `cc-drift-watch.yml` catches on the Claude side and which OpenAI-compat clients self-detect by speaking the protocol they speak.

If an Inferred entry doesn't work for you, the failure is almost always upstream (provider rate-limit shape, model deprecation, custom header the tool sends that we don't forward). Open an issue with `dario doctor` output and we'll either fix it (if it's dario) or document the workaround (if it's the tool).

## What's missing from this page

- A "tested at version vX.Y.Z" column — the matrix is moment-in-time, not historical.
- Performance characteristics (latency, throughput) — see the per-tool walkthroughs.
- Per-tool feature matrices (does Cursor's BYOK pass `tools`? does Cline's text-tool mode survive `--system-prompt=partial`? etc) — those live in the long-form docs.

## Adding a tool to this matrix

Honest framing for new entries:

- **✅ Working** requires either (a) a checked-in walkthrough doc, or (b) a smoke test that exercises the tool's request shape end-to-end.
- **⚪ Inferred** is the right cell for "uses a generic protocol path I can point to in code, but I haven't run the actual tool through dario."
- **🟡 Untested** is the right cell for "mentioned in README, but I have no evidence either way."

Don't promote ⚪ → ✅ without a walkthrough or test landing. Don't promote 🟡 → ⚪ without at least pointing at the code path you're claiming covers it.
