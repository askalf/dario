#!/bin/sh
# Decide whether a PR's package.json version may be auto-merged.
#
# Extracted from auto-merge-bot-prs.yml so it can be TESTED, and so the
# event-driven path and the hourly sweep cannot drift apart. Two copies of
# this rule would be worse than none: the sweep would quietly become a way
# around the gate the moment either copy was edited alone.
#
# THE RULE. Two bot PRs can independently bump package.json to the SAME
# version, because each is drafted off the current release without seeing the
# other (#954 and #955 both took 5.5.10 off 5.5.9, with different dates).
# Whichever merges SECOND is the casualty:
#
#   - equal to the released version -> cc-drift-auto-release's duplicate-tag
#     guard fast-exits green and ships NOTHING, a release that silently did
#     not happen on a chore PR nobody re-reads after merge;
#   - lower -> the base branch version moves BACKWARDS below a published tag.
#
# So a PR that CHANGES the version must carry one strictly greater than the
# base branch tip. A PR that leaves the version alone (the common Dependabot
# action bump) is unaffected — which is why base is compared as well as tip.
#
# Usage:  version-advances.sh <base_ver> <head_ver> <tip_ver>
#
# Writes exactly TWO lines to stdout:
#   1  safe    "true" | "false"
#   2  reason  short human-readable explanation
#
# Exit status is 0 for a decision of either kind; a non-zero exit means the
# script could not decide (bad arguments), which callers must treat as unsafe.
#
# Fixed-position lines rather than KEY=VALUE + eval, matching
# health-verdict.sh: these values come from repository content, and evaluating
# anything derived from that is not worth the convenience.

base_ver="$1"
head_ver="$2"
tip_ver="$3"

# Fail CLOSED on missing input. A caller that could not read one of the three
# package.json files must not fall through to "arm" — skipping one arming run
# is cheap because the next push (or the next sweep) re-runs this, whereas
# guessing risks exactly the silent no-op release the rule exists to prevent.
if [ -z "$base_ver" ] || [ -z "$head_ver" ] || [ -z "$tip_ver" ]; then
  printf 'false\n'
  printf 'could not read package.json at every ref\n'
  exit 0
fi

if [ "$head_ver" = "$base_ver" ]; then
  printf 'true\n'
  printf 'PR does not change the version - no ordering hazard\n'
  exit 0
fi

# The PR bumps the version, so it must land ABOVE the current tip.
#
# sort -V, not a string compare: 5.5.99 must not outrank 5.6.0. Require
# strictly greater — equal means another PR already published this version,
# and the duplicate-tag guard would turn this merge into a no-op release.
highest="$(printf '%s\n%s\n' "$tip_ver" "$head_ver" | sort -V | tail -1)"

if [ "$head_ver" != "$tip_ver" ] && [ "$highest" = "$head_ver" ]; then
  printf 'true\n'
  printf 'version advances %s -> %s\n' "$tip_ver" "$head_ver"
else
  printf 'false\n'
  printf 'proposes %s but base is already at %s\n' "$head_ver" "$tip_ver"
fi
