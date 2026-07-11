# Recovery runbook

Things automation can't fix. Sorted by frequency: top entries are most likely to come up.

If you're hitting something not listed here, check the workflow logs first — the auto-release and drift workflows include diagnostic comments inline.

---

## Release shipped to GitHub but not npm

**Symptom**: `gh release view v$X` succeeds; `npm view @askalf/dario@$X` returns 404 or the version is stale.

**Cause**: npm publish step in `cc-drift-auto-release.yml` failed at the time of the release (transient registry 5xx, trusted-publisher misconfig, network blip). The hourly schedule tick normally self-heals this; if it hasn't within 2 hours, `npm-drift-watch.yml` opens an issue (label `npm-drift`) because the self-heal itself is failing.

**Fix**:
```bash
# Re-dispatch the auto-release; the gate (PR #343) sees GH release
# exists + npm doesn't, fills only the missing publish + ghcr push.
gh workflow run cc-drift-auto-release.yml -R askalf/dario
```

Verify after ~3 min:
```bash
npm view @askalf/dario version    # should match the expected version
```

---

## npm publish auth failed (trusted publishing)

**Symptom**: the `npm publish (OIDC trusted publishing)` step fails with an auth-shaped error — `404 Not Found - PUT https://registry.npmjs.org/@askalf%2fdario` (npm's misleading way of saying auth failed) or an explicit OIDC/permissions message. There is no NPM_TOKEN anymore; auth is the workflow's OIDC token exchanged via npm's trusted publisher.

**Fix**:
1. npmjs.com → `@askalf/dario` → package **Settings** → **Trusted Publisher**
2. It must point at repository `askalf/dario`, workflow **`cc-drift-auto-release.yml`** (the filename is the binding — renaming the workflow file breaks publishing), environment: none
3. Re-create it if it's missing or mismatched, then re-dispatch: `gh workflow run cc-drift-auto-release.yml -R askalf/dario`
4. Backfill check: see "Release shipped to GitHub but not npm" above

---

## OAuth credential dead (refresh token invalid)

**Symptom**: Workflows on the self-hosted runner fail with `invalid_grant` on the refresh endpoint. Or `dario status` reports `oauth: broken`.

**Cause**: The OAuth credential at `/root/.claude/.credentials.json` hasn't been refreshed in long enough that Anthropic invalidated the refresh token. In current shared-credential design (dario#342), this should only happen if the platform dario container has been down for an extended period.

**Fix** — re-authenticate (requires browser access):
```bash
# On the Hetzner host:
ssh -i ~/.ssh/askalf_platform_ed25519 root@178.104.181.103

# Stop platform dario so it doesn't race with login:
docker compose -f /root/.askalf/docker-compose.selfhosted.yml stop dario

# Re-auth. --manual prints a URL — open in your browser locally, paste code back.
HOME=/root dario login --manual

# Verify credentials file landed correctly:
ls -la /root/.claude/.credentials.json /root/.dario/credentials.json
# Should both be symlinks to /var/lib/askalf-dario/credentials.json (the
# bind-mount platform dario uses). If they aren't, re-create symlinks:
ln -sfn /var/lib/askalf-dario/credentials.json /root/.dario/credentials.json
ln -sfn /var/lib/askalf-dario/credentials.json /root/.claude/.credentials.json

# Bring platform dario back up:
docker compose -f /root/.askalf/docker-compose.selfhosted.yml up -d dario
docker exec askalf-dario sh -c "node -e 'fetch(\"http://localhost:3456/health\").then(r=>r.json()).then(console.log)'"
# Expect: { status: 'ok', oauth: 'healthy', ... }
```

---

## Compat suite 429s on every PR

**Symptom**: `compat-test-self-hosted` reports tests failing with `HTTP 429: rate_limit_error: "Rate limited (rejected)"`. Single isolated calls through the *platform* dario succeed; only the compat suite fails.

**Cause** (corrected 2026-06-08 — the earlier "~3/min per-minute cap" was a misdiagnosis): it is **not a rate/volume cap**. The compat job runs dario in **`--passthrough`** (so it can verify the no-injection guarantee), which means its outbound requests are **not CC-shaped**. Anthropic's **Max OAuth pool rejects non-CC-shaped traffic by design** — returning `429 "Rate limited (rejected)"` (the billing classifier) for *any* such request, even a single one, regardless of pacing. The platform dario succeeds on the *same* OAuth path because it rebuilds requests as CC (canonical mode), which the classifier accepts. (Verified: routing the suite through dario→Max gives ~9/10 rejections immediately; separately, canonical CC-shaped traffic runs 25 req/min clean — so rate was never the issue.)

**Fix** — route the suite **through** dario, but point dario's *upstream* at the **per-token API pool** (which has no such classifier) via `ANTHROPIC_UPSTREAM_API_KEY`. The suite still exercises dario's wire — the passthrough-verification + OpenAI-compat sections **run** (unlike the older direct-Anthropic bypass, which skipped them). Implemented by the `ANTHROPIC_UPSTREAM_API_KEY` path (`upstreamAuthHeaders` in `src/proxy.ts`) + `compat-test-self-hosted.yml`:

1. console.anthropic.com → Settings → API Keys → **Create Key** e.g. `dario-compat-ci`
2. `gh secret set ANTHROPIC_COMPAT_API_KEY -R askalf/dario --body 'sk-ant-api03-...'` — the workflow passes this to the dario-start step as `ANTHROPIC_UPSTREAM_API_KEY`, so dario forwards upstream on the per-token pool.
3. Verify: `gh workflow run compat-test-self-hosted.yml -R askalf/dario` (expect 10/10).

Do **not** switch dario's upstream back to the Max OAuth to "save the key" — passthrough on the Max pool cannot work (see **Cause**).

Cost: ~$0.05–0.20 per compat run, on the standard per-token API tier (a separate pool from the Max subscription).

**If the API key is unavailable** (revoked, don't want to pay): there is no working path through dario→Max (every `--passthrough` request is classifier-rejected), so compat goes red. Either restore the per-token key, or temporarily set `DARIO_TEST_API_KEY` (legacy direct-Anthropic mode — hits Anthropic directly and **skips** the dario-routing sections) and admin-merge, watching for the `Release shipped to GitHub but not npm` failure mode instead.

---

## ghcr docker image missing for a release

**Symptom**: `docker pull ghcr.io/askalf/dario:v$X` fails with `manifest unknown`. GitHub release tag exists, npm has the version, but the docker image wasn't pushed.

**Cause**: Docker push step in the release workflow failed (ghcr.io transient, runner ran out of disk, network blip).

**Fix**:
```bash
gh workflow run cc-drift-auto-release.yml -R askalf/dario
# Gate sees: gh_release_exists=true, npm_published=true (so npm publish skipped),
# docker push reruns (idempotent re-tag is safe on ghcr).
```

If that also fails, build + push locally:
```bash
git checkout v$X
docker build -t ghcr.io/askalf/dario:v$X -t ghcr.io/askalf/dario:latest .
echo $GHCR_PAT | docker login ghcr.io -u askalf --password-stdin
docker push ghcr.io/askalf/dario:v$X
docker push ghcr.io/askalf/dario:latest
```

---

## Self-hosted runner offline

**Symptom**: All self-hosted workflows (compat, drift watchers, billing canary) skip with `No runner matching the specified labels was found: self-hosted, dario-drift`. The `cc-drift-watcher-liveness` workflow will eventually open an issue.

**Fix** — re-bring-up the runner:
```bash
ssh -i ~/.ssh/askalf_platform_ed25519 root@178.104.181.103

# Check runner service:
systemctl status actions.runner.askalf-dario.askalf-platform-1.service

# If stopped, start it:
systemctl start actions.runner.askalf-dario.askalf-platform-1.service

# If service is broken or runner needs to be re-registered:
cd /home/runner/actions-runner   # typical install path
./config.sh remove --token <RUNNER_REMOVAL_TOKEN>   # if old registration is stuck
./config.sh --url https://github.com/askalf/dario --token <NEW_RUNNER_TOKEN> --labels dario-drift
./svc.sh install
./svc.sh start
```

Get a fresh runner registration token from: github.com → askalf/dario → Settings → Actions → Runners → New self-hosted runner.

---

## Anthropic actively rate-limiting the subscription

**Symptom**: ALL traffic through dario gets 429s, not just compat. Single requests fail. OAuth itself authenticates fine (`/health` shows healthy). This is distinct from a token issue — it's Anthropic policy or burst-detection.

**Cause**: Subscription hit Anthropic's caps. Either:
- Heavy day's usage burned the 5h window
- Anthropic's billing classifier started routing your traffic to a stricter pool (the `cc-billing-classifier-canary.yml` workflow exists specifically to detect this — check its recent runs)

**Fix**:
1. Wait it out — 5h window rebuilds
2. Check `cc-billing-classifier-canary.yml` runs — if the canary is flipping `pass`→`warn` or `pass`→`fail` over recent days, the wire-shape mimicry is degrading. Look at the latest captured `cc-template.live.json` vs whatever the watchers have flagged
3. If the canary's drifting toward `fail`, re-bake the template manually:
   ```bash
   ssh -i ~/.ssh/askalf_platform_ed25519 root@178.104.181.103
   cd /opt/path/to/dario   # wherever runner has it checked out
   HOME=/root node scripts/capture-and-bake.mjs   # NOT --check; real bake
   ```
   Then open a PR with the new `src/cc-template-data.json` and let compat verify it.

---

## Hetzner box itself is down

**Symptom**: SSH fails. Cloudflare tunnel shows `dario.askalf.org` unreachable. No workflows can fire (runner is offline + dario is offline).

**Fix** — Hetzner side:
1. Hetzner Cloud Console → askalf-platform-1 → check VM state (running / stopped / hung)
2. If hung: console-reset or hard-reboot from the console
3. If filesystem corruption: snapshot restore (R2 nightly age-encrypted offsite backups, recovery via `restic`)

Recovery time: typically minutes for a console-reboot. Snapshot restore is hours.

---

## What I do NOT cover here

- Building new dario features (we're in maintenance mode)
- Tuning compat-suite coverage (Anthropic-wire-shape correctness is captured by the existing tests; expanding it is out of maintenance scope)
- Migrating off the OAuth proxy pattern entirely (dario is the OAuth proxy; if Anthropic blocks it permanently, that's a strategic decision, not a runbook recovery)
