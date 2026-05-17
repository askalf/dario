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
>
> Watched-by-the-watcher: `.github/workflows/cc-drift-watcher-liveness.yml`
> runs every 2 hours on a github-hosted runner and opens a
> `cc-watcher-liveness`-labeled alert if the class-B watcher has not had a
> successful run within 3 hours (≥ 6 missed cycles). Catches "runner went
> offline silently" — the failure mode where class-B drift goes uncaught
> because the watcher itself is down. The liveness watcher lives on
> github-hosted infrastructure deliberately so it survives the exact failure
> modes it's designed to detect.

**Class C — billing-classifier drift** *(v4.6.0)*. Different signal again:
Anthropic changes the classifier *rules* — adds a new signal, tightens an
existing one, flips a threshold — and dario's canonical-rebuild output no
longer scores as `subscription` even though CC's wire shape is unchanged.
The template-drift watcher cannot see this because nothing in CC's outbound
has moved; only an end-to-end "send a real request, inspect the billing
bucket" probe catches it.

> Watched by `.github/workflows/cc-billing-classifier-canary.yml`. Runs daily
> at 06:30 UTC on the same self-hosted runner. Sends one tiny haiku request
> through `dario proxy` (canonical-rebuild mode, NOT `--passthrough`),
> captures the `representative-claim` response header, opens a
> `cc-billing-canary`-labeled alert when it flips to `overage` / `api`
> / `unknown`. Auto-closes when it next returns a subscription bucket.
> Cost: ~1 small subscription request per day.

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

# 2. GitHub CLI (`gh`) — the workflow's issue-open step shells out to it.
#    Without this, --check correctly detects drift but the "Open / update
#    drift issue" step fails with `gh: command not found`.
sudo apt-get install -y gh   # or follow https://github.com/cli/cli#installation

# 3. CC + dario CLI (dario provides the headless OAuth flow)
sudo npm i -g @anthropic-ai/claude-code @askalf/dario

# 4. OAuth — manual flow for headless boxes. Run from the host's shell,
#    follow the printed URL in any browser, paste the post-login callback
#    URL back into the SSH session.
#
#    v4.4.1: if this host runs OTHER CC clients sharing /root/.claude/
#    (e.g. docker services mounting the host's /root/.claude/ as a
#    credentials volume, an operator's own SSH-based CC sessions, etc.),
#    use an isolated home for the runner so its OAuth refresh cycle
#    does not race with theirs:
#
#      mkdir -p /root/.claude-runner/.claude
#      chmod 700 /root/.claude-runner
#      HOME=/root/.claude-runner dario login --manual
#      # dario writes its credentials to /root/.claude-runner/.dario/credentials.json
#      # CC reads from $HOME/.claude/.credentials.json — same JSON format, mirror it:
#      cp /root/.claude-runner/.dario/credentials.json \
#         /root/.claude-runner/.claude/.credentials.json
#      chmod 600 /root/.claude-runner/.claude/.credentials.json
#
#    The drift-watch + compat-test workflows pin `HOME: /root/.claude-runner`
#    on every step that spawns CC, so the isolated credential is what the
#    runner actually uses at workflow time.
#
#    If no other CC clients are sharing the box, the simpler default flow
#    works: just run `dario login --manual` and CC will find the
#    credentials under ~/.claude/.credentials.json.
dario login --manual

# 5. Smoke test (replace HOME with /root/.claude-runner if isolated):
echo "Reply with PONG" | claude --print     # should print PONG
```

### One-time repo setup

The workflow's issue-open step calls `gh issue create --label cc-drift-template`
which fails if the label doesn't exist in the repo. Create it once before the
runner's first execution:

```bash
gh label create cc-drift-template \
  --description "Bundled CC template has drifted from live capture" \
  --color FBCA04
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

## Runner credential rate-limit headroom

Workflows that exercise live `dario proxy` paths (compat-test, billing canary, future end-to-end probes) all consume against the runner credential's subscription pool. The cadence assumptions are:

| Workflow | Cadence | Requests per fire |
|---|---|---|
| `cc-drift-template-watch.yml` (`--check`) | every 30 min | 1 capture (no /v1/messages traffic — MITM-only) |
| `cc-billing-classifier-canary.yml` | daily 06:30 UTC | 1 small haiku request |
| `compat-test-self-hosted.yml` | per qualifying PR | ~11 small requests |

At steady state, this is comfortably inside Pro/Max headroom. The failure mode to watch for is **batched firing** — manually re-triggering the same workflow several times in a single hour, or PRs landing in rapid succession that each fire compat-test. We tripped this during the v4.6.x rollout: a half-dozen manual re-runs in a 2-hour window 429'd the runner credential. Pro/Max accounts have per-hour rate caps as well as per-5h / per-7d pools, and the per-hour cap is what surfaces first.

If the runner credential is rate-limited and a workflow run reports 429s across the board, the right diagnosis order is: (a) check `claude --print` with the runner HOME directly — if it 429s, the credential pool is dry, just wait an hour; (b) check the credential is still on a subscription account (`dario doctor`); (c) check workflow cadence assumptions haven't changed.

The runner credential should run a real Pro/Max subscription with no other workload on it. Sharing the credential with manual `claude` sessions or other CC clients eats the headroom the watchers need. v4.4.1's `HOME=/root/.claude-runner` isolation gives the runner its own token pair within the same Pro/Max account; if you also need its own subscription account, log into a different one when running `dario login --manual` against the isolated HOME.

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
