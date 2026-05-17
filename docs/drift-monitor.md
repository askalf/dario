# Drift monitor

Dario's bundled CC template (`src/cc-template-data.json`) is the wire-shape
fallback the proxy uses when it can't fingerprint a live CC install. For that
fallback to be honest, the bundle has to keep up with what real CC is actually
sending on the wire. CC drifts in two distinct ways, and there are two
distinct watchers — one of which needs a self-hosted runner.

## Two classes of drift

**Class A — npm-release drift.** Anthropic ships a new `@anthropic-ai/claude-code`
to npm. The binary changes; the wire shape usually changes with it (new tools,
new system-prompt slots, beta-header swaps). This is the visible kind.

> Watched by `.github/workflows/cc-drift-watch.yml`. Runs on a GitHub-hosted
> runner, no auth required — polls npm, diffs the dist file, opens an issue
> when the bundled `_version` is behind latest.

**Class B — same-binary remote-config drift.** Anthropic does *not* ship a new
npm version, but the wire shape changes anyway. We documented an instance of
this in [CHANGELOG `4.2.1`](../CHANGELOG.md#421---2026-05-17): same CC `2.1.143`
binary, same machine, captures 24h apart produced materially different
`/v1/messages` bodies (different anthropic-beta header, +355 char system
prompt). The npm watcher can't see this; the binary is unchanged.

> Watched by `.github/workflows/cc-drift-template-watch.yml`. Runs on a
> **self-hosted** runner because it needs a live, authenticated CC install
> to capture against. Runs `node scripts/capture-and-bake.mjs --check` every
> 30 min and opens (or comments on) a `cc-drift-template`-labeled issue when
> the captured template diverges from the committed bundle.

## What --check considers drift

The `--check` mode in `scripts/capture-and-bake.mjs` deliberately ignores
fields that always differ between runs (`_captured` timestamp, user-agent
string). It flags drift in:

- **tools** added or removed (by name set)
- **anthropic_beta** header values added or removed
- **system_prompt** content (any character delta)
- **body_field_order** (top-level JSON key order)
- **header_order**
- **agent_identity** content

Exit codes:

| Code | Meaning |
|---|---|
| 0   | No drift; bundled template matches live capture |
| 1   | Infrastructure failure (CC not on PATH, capture timeout, scrub leak) |
| 2   | Drift detected vs current bundled template |

The workflow swallows exit 2 (continues to the next step) so the issue-open
step can run; exit 1 fails the job.

## Setting up the self-hosted runner

Any dedicated Linux host works. Hetzner / DO / EC2 / etc. The runner needs
Node 22, a logged-in `claude` CLI, and disk for a clone of the repo (~200 MB
including `node_modules`).

### Prerequisites

```bash
# 1. Node 22 + npm
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs

# 2. CC + dario CLI (dario provides the headless OAuth flow)
sudo npm i -g @anthropic-ai/claude-code @askalf/dario

# 3. OAuth — manual flow for headless boxes. Run from the host's shell,
#    follow the printed URL in any browser, paste the post-login callback
#    URL back into the SSH session. Drops a credentials file at
#    ~/.claude/.credentials.json.
dario login --manual

# 4. Smoke test
echo "Reply with PONG" | claude --print     # should print PONG
```

### Register the runner

In a browser: `https://github.com/<owner>/<repo>/settings/actions/runners/new`.
Pick Linux x64. GitHub prints a `mkdir`/`curl`/`tar`/`./config.sh` snippet.
Paste it into the host. At the labels prompt, type **`dario-drift`** — the
workflow gates on `runs-on: [self-hosted, dario-drift]`, so the label is
load-bearing.

### Install as a systemd service

```bash
cd ~/actions-runner
sudo ./svc.sh install $(whoami)   # run as the same user that owns ~/.claude
sudo ./svc.sh start
sudo ./svc.sh status              # → "active (running)"
```

If the runner runs as `root` and `~/.claude/.credentials.json` lives under
`/root/`, `RUNNER_ALLOW_RUNASROOT=1 ./config.sh ...` lets `./config.sh` run as
root; GitHub's runner otherwise refuses root by default.

### Trigger once to verify

GitHub UI → Actions → **CC template drift watch (self-hosted)** → "Run
workflow." It should pick up the labeled runner within seconds and finish
within ~60s. Exit 0 (no drift) or exit 2 (issue auto-opened with the drift
report) both mean the pipeline is healthy. Exit 1 means the capture broke;
check the workflow logs.

After the first successful run, the `*/30 * * * *` cron takes over.

## When --check fires an issue

The workflow opens (or comments on) an issue labeled `cc-drift-template`
containing the `[bake]` output — the list of differing slots, sizes, tool
names. From there:

```bash
# On a maintainer machine with CC + a logged-in OAuth credential:
npm run build
node scripts/capture-and-bake.mjs   # rewrites src/cc-template-data.json
git diff src/cc-template-data.json  # review
# Open a PR with the re-bake; the auto-release pipeline publishes a patch
# version. The next clean --check cycle auto-closes the drift issue.
```

## Why a self-hosted runner

GitHub-hosted runners can't capture CC. They have no Pro/Max subscription
session, no MITM cert trust for CC's loopback proxy, no way to authenticate
against `claude.ai/oauth`. Anything that needs real CC running against real
Anthropic has to live on a host you control with an account you've logged
in to.

The runner is read-only against the repo (`contents: read`) and only writes
to issues (`issues: write`). It cannot push, tag, or release.

## Platform-superset preservation

CC ships different tools on different platforms — currently just `PowerShell`
on Windows, but the surface grows over time. The bundled template is meant to
be a **union** across platforms, and `filterToolsForPlatform()` strips it down
at request time. So a bake on Linux must not silently drop the Windows tool
set, or Windows dario users would lose those tools on the next release.

`scripts/capture-and-bake.mjs` preserves tools from the previous bundle whose
names are listed in `PLATFORM_ONLY_TOOLS` for a platform other than the
baking host's. The merged set is re-sorted alphabetically to match CC's wire
order. The runner can therefore bake from Linux without regressing Windows
users.
