# Shim mode

*Experimental, opt-in. The proxy is still the default — shim mode is a second transport, not a replacement.*

Shim mode runs a child process with an **in-process `globalThis.fetch` patch** that rewrites the child's outbound requests to `api.anthropic.com/v1/messages` exactly the way the proxy would, then sends them directly from the child to Anthropic. No localhost HTTP hop. No port to bind. No `ANTHROPIC_BASE_URL` to set.

```bash
dario shim -- claude --print "hello"
dario shim -v -- claude --print "hello"        # verbose
```

Under the hood: `dario shim` spawns the child with `NODE_OPTIONS=--require <dario-runtime.cjs>` and a unix socket / named pipe for telemetry. The runtime patches `globalThis.fetch` only for Anthropic messages requests, applies the same template replay the proxy does, and relays per-request events back to the parent so analytics still work. Every other fetch call is untouched and fails safe on any internal error.

**Why it matters.** A proxy has observable surface — TLS, headers, IP, `BASE_URL` env. Shim mode has none of that: the request goes out through CC's own network stack, unchanged. It's the transport with the smallest observable footprint.

**Hardening (v3.13+)** added runtime detection (canary for upstream runtime changes), template mtime-based auto-reload (long-running children pick up mid-session template refreshes without restart), strict defensive `rewriteBody` (requires exactly 3 text blocks, passes through on any mismatch instead of inventing structure), and header-order replay (honors captured CC header sequence so the shim matches CC wire-exact).

## When to use shim mode

- Running a single CC instance on a locked-down machine where binding a local port is inconvenient.
- Wrapping one-off scripts (`dario shim -- node my-agent.js`) without setting up environment variables.
- Debugging a specific child process in isolation — verbose logs are scoped to that child.
- You want to take the proxy layer off the wire entirely — no local port, no `BASE_URL`, no extra network hop.

## When to stay on the proxy (default)

- Multi-client routing. The proxy serves every tool on the machine through one endpoint; shim wraps one child at a time.
- Multi-account pool mode. Pooling across subscriptions needs a shared OAuth pool the proxy owns — a shim patch inside one child can't see pool state across other processes.
- Anything that isn't a Node / Bun child. The shim relies on `NODE_OPTIONS`, so Python SDKs or Go CLIs still need the proxy.

## `--priority=<level>` (v3.37+) — RDP / network-IO friendly scheduling

Shim mode launches its child at `Normal` scheduling priority by default. On modest hardware — particularly older 4-core CPUs without hyperthreading — heavy claude tool-call work can saturate every core during agent-loop bursts. If you're RDP'd into the same machine that's hosting claude, those bursts starve the kernel network IO threads, RDP socket writes time out with `ERROR_SEM_TIMEOUT` (`0x80070079`), and your session drops with `code=2147942521` in the TerminalServices log. The drops correlate 1-to-1 with the claude burst pattern but appear "random" because the bursts are.

```bash
dario shim --priority=below-normal -- claude
```

Cross-platform via Node's `os.setPriority`:

| Level | Windows class | POSIX nice value |
|---|---|---|
| `normal` *(default)* | `NORMAL_PRIORITY_CLASS` | 0 |
| `below-normal` | `BELOW_NORMAL_PRIORITY_CLASS` | +7 |
| `low` | `IDLE_PRIORITY_CLASS` | +19 |

**Recommended for the RDP-host scenario: `below-normal`.** Same throughput when nothing else needs CPU; instant preemption when the kernel needs to send a packet. If `below-normal` isn't enough on a very small machine (4-core / 4-thread), escalate to `low` and consider also setting CPU affinity manually — on a 4-thread machine, `(Get-Process claude).ProcessorAffinity = 0x07` reserves logical CPU 3 for the OS, guaranteeing kernel network threads always have somewhere to run no matter what claude does.

The flag is a no-op when set to `normal`. `setPriority` failures are logged at verbose and the child continues at default — priority is a perf optimization, not a correctness requirement, so a denied syscall never blocks the run.
