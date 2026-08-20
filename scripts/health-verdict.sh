#!/bin/sh
# Turn a dario /health body into a monitoring verdict.
#
# Extracted from cc-oauth-health.yml so it can be TESTED. A watcher's failure
# mode is silence: if the parsing quietly stops matching — a field renamed, a
# body shape changed — the workflow keeps reporting "all axes healthy" forever
# and nobody finds out until the next outage. Logic buried in a YAML `run:`
# block cannot be exercised without firing the real workflow against a real
# broken proxy, so it never is. test/health-verdict.mjs drives this directly.
#
# Reads the body on stdin. Writes exactly SIX lines to stdout, in this order:
#
#   1  oauth         the oauth field, or "unreachable" when absent/empty
#   2  probe_ok      "true" | "false" | "" (empty = not measured)
#   3  probe_reason  the probe's reason, or "" when there was no probe
#   4  stalled       queue.stalledForMs as an integer, or "0" when absent
#   5  axis          "" when healthy, else a short failure label
#   6  reason        dario's `expiresIn` line for a non-healthy pool — "all
#                    accounts rate-limited", "all tokens expired — run `dario
#                    login`", "all accounts in auth-cooldown" — or "" when absent
#
# Fixed-position lines rather than KEY=VALUE + eval: the body is attacker-
# adjacent enough (it is whatever the container returned) that evaluating
# anything derived from it is not worth the convenience.
#
# Env: STALL_ALERT_MS (default 300000) — how long slots may sit at capacity
# with zero turnover before that counts as wedged rather than busy.

STALL_ALERT_MS="${STALL_ALERT_MS:-300000}"

body="$(cat)"

oauth="$(printf '%s' "$body" | grep -o '"oauth":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
[ -z "$oauth" ] && oauth="unreachable"

# Both objects are flat — no nested braces — so `[^}]*` is exact here rather
# than merely close. Scoping to the object matters: a bare grep for `"ok":`
# would also match a probe-less body that happens to carry the key elsewhere.
probe_obj="$(printf '%s' "$body" | grep -o '"probe":{[^}]*}' | head -1 || true)"
probe_ok="$(printf '%s' "$probe_obj" | grep -o '"ok":[a-z]*' | head -1 | cut -d: -f2 || true)"
probe_reason="$(printf '%s' "$probe_obj" | grep -o '"reason":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"

# dario 5.5.30+ names WHY a pool cannot serve, in `expiresIn`. That string is
# the difference between "run `dario login`" and "wait for the window", so it
# is carried out rather than collapsed into the oauth field.
reason="$(printf '%s' "$body" | grep -o '"expiresIn":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"

queue_obj="$(printf '%s' "$body" | grep -o '"queue":{[^}]*}' | head -1 || true)"
stalled="$(printf '%s' "$queue_obj" | grep -o '"stalledForMs":[0-9]*' | head -1 | cut -d: -f2 || true)"
[ -z "$stalled" ] && stalled=0

# Remediation-first ordering: a dead credential also fails the probe, so report
# the root axis and not the symptom it produces.
axis=""

# A pool whose accounts are ALL rate-limited reports oauth=broken as of dario
# 5.5.30, when derivePoolStatus started answering the router's question instead
# of a narrower one. The credential is fine there — the usage window is spent,
# and it refills on its own. Paging for that contradicts the rule this file
# already follows one branch down, where dario deliberately reports a throttled
# probe as ok:true "so a watchdog does not restart on a throttle". The same
# throttle must not page through the oauth axis either. Still reported on line
# 1 and line 6; simply not raised as an axis.
throttled=0
case "$reason" in
  *"rate-limited"*) throttled=1 ;;
esac

if [ "$oauth" != "healthy" ] && [ "$throttled" = "0" ]; then
  axis="OAuth $oauth"
elif [ "$probe_ok" = "false" ]; then
  # rate-limited / upstream-overloaded never reach here — dario reports those
  # as ok:true precisely so a watchdog does not restart on a throttle.
  axis="not serving (${probe_reason:-unknown})"
elif [ "$stalled" -gt "$STALL_ALERT_MS" ] 2>/dev/null; then
  axis="queue wedged ($((stalled / 60000))m)"
fi

printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$oauth" "$probe_ok" "$probe_reason" "$stalled" "$axis" "$reason"
