# Returning to dario

If you used dario before — set it up, hit a drift / capacity / tool-compat wall during the v3.30s, drifted to Codex or Cursor's BYOK or pure API keys — this page is the 5-minute path back.

## What changed while you were gone

- **Multi-arch Docker image** — `ghcr.io/askalf/dario:latest` (and `:vX.Y.Z`, `:vX.Y`, `:vX`). Pull and run, no npm install needed. See [`docs/docker.md`](./docker.md).
- **GHCR publish wired into the release pipeline** — every dario release ships an image. Renovate / Argo Image Updater / Keel can track `:vX.Y.Z` automatically.
- **Hourly CC drift detection** — `cc-drift-watch.yml` runs every hour, auto-drafts a maxTested bump PR within 60 minutes of a Claude Code release. The "dario broke because CC drifted" gap that bit returners is closed.
- **Headless OAuth flow** — `dario login --manual` skips the localhost callback for SSH / container / k8s installs. Browser anywhere, paste the code back.
- **Multi-account pool** — `dario accounts add work` / `dario accounts add personal`. Pool mode kicks in at 2+ accounts; sticky-session routing keeps prompt cache alive across multi-turn agent runs.
- **System-prompt stripping** — `dario proxy --system-prompt=partial` removes CC's behavioral constraints, recovers ~1.2–2.8× output capability on open-ended work without flipping subscription billing. See [`docs/system-prompt.md`](./system-prompt.md).
- **MCP server + CC sub-agent** — `dario mcp` exposes dario as a read-only MCP server; `dario subagent install` registers it inside CC for in-session diagnostics.

## I have an existing dario install

```sh
dario upgrade           # pulls the latest npm release
dario doctor            # reports config, OAuth health, drift status, pool state
```

Read the doctor output. If it's all OK / WARN, nothing to do. If anything is RED, the line tells you the fix.

## I uninstalled dario; have my Claude Code creds; want to come back

```sh
npm install -g @askalf/dario
dario login             # detects existing CC credentials, no re-OAuth needed
dario proxy
```

Or via Docker:

```sh
docker volume create dario-config
docker run --rm -it -v dario-config:/home/dario/.dario \
  ghcr.io/askalf/dario:latest login --manual

docker run -d -p 3456:3456 -v dario-config:/home/dario/.dario \
  -e DARIO_API_KEY="$(openssl rand -hex 32)" \
  ghcr.io/askalf/dario:latest
```

Point your tools at `http://localhost:3456` (Anthropic) or `http://localhost:3456/v1` (OpenAI) with the same `DARIO_API_KEY`.

## I picked up Codex CLI / Cursor BYOK / OpenAI direct in the gap — keep them?

Yes. dario routes both protocols through one endpoint:

```sh
dario backend add openai --key=sk-proj-...
```

Now Codex CLI hits dario at `OPENAI_BASE_URL=http://localhost:3456/v1` and gets routed to OpenAI (your existing OpenAI cost path stays as-is), while Claude Code / Cursor / Aider hit dario at `ANTHROPIC_BASE_URL=http://localhost:3456` and get routed to your Claude subscription. Same proxy. Same restart.

Force a specific backend with a model prefix when the default routing isn't what you want:

- `openai:gpt-4o` — always goes to OpenAI, even from a tool that defaults to Claude
- `anthropic:opus` — always goes to your Claude subscription, even from an OpenAI-shape tool
- `groq:llama-3.3-70b` / `local:qwen-coder` — same pattern for any backend you've added

## I'm hitting the 5h subscription cap immediately on agent runs

Add a second account.

```sh
dario accounts add work
dario accounts add personal
dario proxy
```

Pool mode activates automatically at 2+ accounts. Each request picks the account with the most headroom. Multi-turn agent sessions stick to one account so the Anthropic prompt cache survives. In-flight 429s retry on a different account before your tool sees the error. Tier mixing is fine — Pro + Max 5x + Max 20x all pool together; dario only cares about headroom percentage, not plan name.

Full headroom math, sticky-key implementation, inspection endpoints: [`docs/multi-account-pool.md`](./multi-account-pool.md).

## I'm running this in k8s now, not on my laptop

The Docker image is k8s-ready: non-root user, healthcheck on `/health`, volume on `/home/dario/.dario`, mandatory `DARIO_API_KEY` when binding non-loopback. A complete Deployment + Service + Secret manifest is in [`docs/docker.md#kubernetes-example`](./docker.md#kubernetes-example).

Pre-seed credentials by running `dario login --manual` on a workstation, then ship `~/.dario/credentials.json` into the k8s Secret via SOPS / sealed-secrets / `kubectl create secret generic --from-file`. Refresh tokens auto-rotate inside the pod.

Replicas should stay at `1`. dario's OAuth refresh races on a single credentials file. For HA, run multiple dario instances each with their own account in a multi-account pool — separate Deployments, separate Secrets, separate Services, fronted by your usual ingress.

## I had `--passthrough` set; do I still need it?

`--passthrough` is only useful when the upstream tool already builds Claude-Code-shaped requests on its own. Most tools don't; without `--passthrough` dario rebuilds the request to match CC's wire shape, which is what keeps the request on the subscription-billing path.

If you weren't sure what `--passthrough` did before and just had it set, drop it. `dario doctor` will tell you whether your installed CC binary is being used as the template source.

## Something specific is broken

`dario doctor` prints a paste-ready report. Open an issue with that report attached.

If you're inside Claude Code, `dario subagent install` registers a CC sub-agent — ask CC to "use the dario sub-agent to run doctor" and it'll attach the report to your conversation directly.
