#!/bin/sh
#
# dario container entrypoint.
#
# Best-effort self-heal of the `/home/dario/.dario` config volume on startup,
# then drops privileges to the dario user and execs the dario CLI.
#
# Pattern: run as root briefly, chown the volume IFF the volume isn't already
# correctly owned and CAP_CHOWN is available, then `su-exec` down to the
# unprivileged dario user before exec'ing the actual process.
#
# The conditional chown is what makes this safe under hardened container
# configs that drop all capabilities (e.g. compose's `cap_drop: ALL`). Without
# CAP_CHOWN the chown fails with EPERM; if we attempt it unconditionally we
# break every cap-dropped deploy. So:
#
#   - normal case (volume already dario-owned): skip chown, no caps needed
#   - recovery case + caps available: chown succeeds, volume is healed
#   - recovery case + caps dropped: chown fails silently, dario user still
#     can't write, but the container starts — operator sees clear EACCES in
#     subsequent operation logs rather than a cryptic entrypoint crash loop
#
# Why the recovery case existed: any prior `docker run --user 0 ... -v
# dario-config:/home/dario/.dario` recovery op (the documented dance for
# wiping credentials.json before --force-reauth shipped in v3.37.11) leaves
# files owned by root. Subsequent normal-user runs then see EACCES on every
# write — credentials can't refresh, login can't persist.

set -e

DARIO_HOME=/home/dario/.dario
DARIO_UID=$(id -u dario)
DARIO_GID=$(id -g dario)

if [ "$(id -u)" = "0" ]; then
  # mkdir is best-effort — if the volume mount already created it, this is a
  # no-op; if not, we get a fresh dir owned by root which the conditional
  # chown below will fix.
  mkdir -p "$DARIO_HOME" 2>/dev/null || true

  # Only attempt chown if the volume isn't already correctly owned. The
  # success path (volume previously written by dario user) skips the chown
  # entirely, so no CAP_CHOWN is required for normal container starts under
  # `cap_drop: ALL`.
  CURRENT_OWNER=$(stat -c '%u:%g' "$DARIO_HOME" 2>/dev/null || echo 'unknown')
  if [ "$CURRENT_OWNER" != "$DARIO_UID:$DARIO_GID" ]; then
    if chown -R dario:dario "$DARIO_HOME" 2>/dev/null; then
      echo "[entrypoint] self-healed $DARIO_HOME ownership ($CURRENT_OWNER → $DARIO_UID:$DARIO_GID)" >&2
    else
      echo "[entrypoint] WARN: $DARIO_HOME is $CURRENT_OWNER (expected $DARIO_UID:$DARIO_GID) but chown failed (no CAP_CHOWN). Container will start; subsequent writes may EACCES. To self-heal, restart with cap_add: [CHOWN, FOWNER] for one boot, then drop caps again." >&2
    fi
  fi

  exec su-exec dario node /app/dist/cli.js "$@"
fi

# Already running as a non-root user (operator opted out of self-heal via
# `docker run --user dario ...` or a CI runner without root) — just exec.
exec node /app/dist/cli.js "$@"
