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
> successful run within 8 hours (≥ 16 missed cycles). Catches "runner went
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
#    SHARE the credential with any other CC clients that auto-refresh
#    (e.g. a platform dario container running 24/7). Just run the standard
#    `dario login --manual` against /root/.claude/.credentials.json and let
#    that long-running refresh authority keep the token fresh. The workflows
#    read whatever's current at fire time and never attempt a refresh from
#    the runner side.
#
#    History: v4.4.1 isolated the runner's credential at /root/.claude-runner
#    to avoid OAuth refresh-token rotation races between the runner and other
#    CC clients on the host. The isolation worked for races but introduced a
#    different failure: the isolated token had no refresh authority between
#    workflow fires (each <10 min, often hours apart), and Anthropic invalidates
#    refresh tokens that idle too long. Result: `invalid_grant` on every
#    workflow fire, recoverable only via interactive `dario login --manual`.
#
#    Sharing with a 24/7 refresh authority (typical setup: the docker-stack
#    dario container) fixes that. The race the isolation was protecting
#    against is rare in practice — platform dario refreshes proactively
#    when the access token has ~1h life remaining, so workflow runs hit a
#    fresh token and don't need to refresh themselves.
dario login --manual

# 5. Smoke test:
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

## Optional: PAT for downstream workflow triggers

Since v4.4.0, the watcher auto-opens a `bot/template-rebake-*` PR on detection. Since v4.3.0, `compat-test-self-hosted.yml` is supposed to run on PRs touching `src/cc-template-data.json`. **Without the setup below, it doesn't.** GitHub Actions has a deliberate restriction: workflows authenticated by the default `GITHUB_TOKEN` cannot trigger downstream workflow runs ([docs](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication#using-the-github_token-in-a-workflow)). The auto-rebake PR is therefore invisible to compat-test, and the validation gate the v4.4.0 design promised is effectively bypassed.

To close the gap, create a fine-grained personal access token (PAT) scoped to this repo and expose it to the watcher as `DARIO_DRIFT_BOT_PAT`:

1. **Generate** at `https://github.com/settings/personal-access-tokens/new`:
   - Resource owner: your user (or org)
   - Repository access: select `dario` only
   - Permissions: **Contents: read & write**, **Pull requests: read & write**, **Issues: read & write**
   - Expiration: whatever your security policy mandates (90 days / 1 year)

2. **Store** at `Settings → Secrets and variables → Actions → New repository secret`:
   - Name: `DARIO_DRIFT_BOT_PAT`
   - Value: the PAT from step 1

3. **Verify** on the next watcher cycle that detects drift. The auto-rebake PR's "Checks" tab should now include the `compat` job (which it didn't pre-v4.6.5).

The watcher workflow uses `GH_TOKEN: ${{ secrets.DARIO_DRIFT_BOT_PAT || secrets.GITHUB_TOKEN }}` for `gh` CLI ops, so the PAT is **optional** — the watcher keeps working without it, you just don't get compat-test gating on auto-rebake PRs (same behavior as v4.4.0 through v4.6.4). The fallback exists so a maintainer can defer the PAT setup without breaking the loop.

## Runner credential rate-limit headroom

Workflows that exercise live `dario proxy` paths (compat-test, billing canary, future end-to-end probes) all consume against the runner credential's subscription pool. The cadence assumptions are:

| Workflow | Declared cadence | Observed cadence | Requests per fire |
|---|---|---|---|
| `cc-drift-template-watch.yml` (`--check`) | every 30 min (`*/30 * * * *`) | typically every 2-4h | 1 capture (no /v1/messages traffic — MITM-only) |
| `cc-billing-classifier-canary.yml` | daily 06:30 UTC | daily | 1 small haiku request |
| `compat-test-self-hosted.yml` | per qualifying PR | per qualifying PR | ~11 small requests |

**Cron scheduler reality.** GitHub Actions' free-tier cron scheduler is best-effort, not guaranteed. The class-B watcher declares `*/30 * * * *` but in practice GitHub honors it every 2-4 hours on this repo. The liveness alarm (added v4.4.2) has its threshold set to 8h (raised from 3h in v4.7.1) to absorb this skew — anything past that is signal, not scheduler noise. If you need a tighter SLA (sub-hour), self-host the runner *and* the cron driver (e.g. a cron entry on the same Hetzner box invoking `gh workflow run` directly).

At steady state, this is comfortably inside Pro/Max headroom. The failure mode to watch for is **batched firing** — manually re-triggering the same workflow several times in a single hour, or PRs landing in rapid succession that each fire compat-test. We tripped this during the v4.6.x rollout: a half-dozen manual re-runs in a 2-hour window 429'd the runner credential. Pro/Max accounts have per-hour rate caps as well as per-5h / per-7d pools, and the per-hour cap is what surfaces first.

If the runner credential is rate-limited and a workflow run reports 429s across the board, the right diagnosis order is: (a) check `claude --print` directly — if it 429s, the credential pool is dry, just wait an hour; (b) check the credential is still on a subscription account (`dario doctor`); (c) check workflow cadence assumptions haven't changed.

The runner shares its OAuth credential with any other long-running CC client on the box (typically the platform dario container, which auto-refreshes 24/7). Sharing is intentional: a workflow that fires sparsely cannot keep its own refresh token alive — Anthropic invalidates idle refresh tokens, and `invalid_grant` then breaks every subsequent run. Letting a 24/7 refresh authority own the token rotation eliminates that failure mode at the cost of competing for the same Pro/Max headroom. With current cadence (drift-template-watch every 30 min + compat per PR + canary daily), runner-side burn on the shared account is a manageable fraction of the headroom available on a Max plan; reducing cadence further is a knob if a particular workload needs more of it.

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
