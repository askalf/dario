# Releasing dario

How a release actually ships and what to verify post-publish. Process exists because **dario#143** — a regression that broke every npm-global install for four releases in a row — slipped through `npm test`, CI, and the dev loop, all of which exercise the dev tree (`node dist/cli.js …`) but never the installed bin shim.

## How releases ship

Dario uses **inline auto-release**: bumping `package.json.version` on master fires `.github/workflows/auto-release.yml`, which tags `vX.Y.Z`, generates a GitHub Release from the matching `## [X.Y.Z]` CHANGELOG section, and runs `npm publish --access public --provenance` in the same job.

No manual `git tag` / `npm publish` step. The version bump on master is the release.

The flow chosen because `GITHUB_TOKEN`-created releases don't fire `release:published`, so a separate `publish.yml` listening for that event would never trigger. Cost: lost the v0.3.0-equivalent of [deepdive#3.0](https://github.com/askalf/deepdive) once via that mistake; not making it twice.

## Pre-merge checklist (PR author / reviewer)

- [ ] `npm run build` — clean
- [ ] `npm test` — all green (currently 54+ assertions)
- [ ] `package.json.version` bumped if and only if the PR is a release
- [ ] `CHANGELOG.md` has a matching `## [X.Y.Z] - YYYY-MM-DD` heading above `## [Unreleased]`, populated with the release's user-visible changes
- [ ] No `Co-Authored-By:` trailers in commits
- [ ] `package-lock.json` re-synced (`npm install --package-lock-only`)
- [ ] PR description names what's user-visible — copy the CHANGELOG heading body in if non-trivial

## Post-merge / post-publish smoke (NEW — was the dario#143 gap)

Most failures get caught by `npm test`. **Bin-shim invocation does not** — the dev tree, the test runner, and CI's `--help` smoke all run `node dist/cli.js` directly, never through the symlink an end user actually invokes.

Within ~10 minutes of `npm publish` completing (auto-release prints the publish line in the workflow output):

```bash
# 1. Install the just-published version globally.
npm install -g @askalf/dario@latest
# (or @<exact version> if you want to pin past a fast-follow.)

# 2. Confirm the bin-shim is reachable and the version matches.
which dario
dario --version

# 3. THE FAILURE THAT dario#143 SHIPPED — silent CLI on the installed binary.
#    These all should produce normal output. If any prints nothing and
#    exits 0, the main-entry guard is broken (or whatever new way the CLI
#    is gating itself out). Roll back immediately.
dario --help
dario doctor
dario doctor --usage          # also exercises the per-model probe path

# 4. Confirm the proxy starts and serves /health from the installed binary.
DARIO_NO_BUN=1 dario proxy &
sleep 2
curl -s http://127.0.0.1:3456/health
kill %1
```

If anything is silent, ships an `Unknown command:` error from `commands[command]` lookup, or fails to bind: stop, file an issue, ship a fix as the next patch release. **Do not assume the next user will report it** — dario has multi-day windows where a regression like this can sit on npm with hundreds of pulls before a single user types out a bug report (#143's silent-CLI was on npm for ~12 hours and exposed in dependency-free `dario doctor` runs across four releases before the report arrived).

## Hotfix releases

When a release ships broken (the dario#143 case): branch from master, fix, version-bump to next patch, re-run the post-publish smoke above against the new version. Don't try to `npm unpublish` an already-released version — npm allows it for 72 hours but downstream caches and lockfiles are unpredictable; the fix-and-fast-follow pattern is more honest. Mention the broken version range in the new release's CHANGELOG with an explicit "anyone on vX.Y.Z–vA.B.C should upgrade" line.

## Out of scope (lessons we already absorbed)

- **CodeQL / actionlint required-status-check path filters.** Removed across dario / claude-bridge / deepdive / hands. A path-filtered required check sits as permanently-pending on PRs that don't touch the path, which blocks merges silently. Already fixed; mentioned here so a future contributor doesn't re-add a path filter.
- **Co-Authored-By trailers.** User's git log is single-author. Don't add the `Co-Authored-By: Claude …` block to commit messages.
- **Skipped pre-commit hooks.** `--no-verify` and `--no-gpg-sign` flags are not used. If a hook fails, fix the underlying issue.

## Required GitHub repo settings (verified once, set-and-forget)

| Setting | State | Why |
|---|---|---|
| `delete_branch_on_merge` | on | Auto-clean merged head branches; no stale-branch litter |
| Required status checks | `build (18/20/22)`, `validate-package-json`, `analyze`, `actionlint` | All four green before merge; no path filters |
| Auto-merge | on | PRs auto-merge once required checks clear |
| Branch protection on `master` | on | Prevent force-push, require PR review |
| `NPM_TOKEN` secret | set | auto-release uses it for `npm publish --provenance` |
| Secret scanning + push protection | on | Catches token leaks pre-push |
| Dependabot security updates | on | Free on public repos |

## Reference

The dario#143 silent-CLI regression that motivated the post-publish smoke step:

- [Issue dario#143 — No console output since upgrading to v3.31.18](https://github.com/askalf/dario/issues/143)
- [PR dario#144 — v3.31.19 fix](https://github.com/askalf/dario/pull/144)
- [v3.31.19 CHANGELOG entry](./CHANGELOG.md)
