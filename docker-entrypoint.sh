#!/bin/sh
#
# dario container entrypoint.
#
# Self-heals the `/home/dario/.dario` config volume on startup, then drops
# privileges to the dario user and execs the dario CLI.
#
# Without the chown, any prior recovery op that ran as root (e.g.
# `docker run --user 0 ... -v dario-config:/home/dario/.dario` to fix
# something like a stale credentials.json) leaves files owned by root,
# and subsequent normal-user runs see EACCES on every write — credentials
# can't refresh, login can't write, the container drifts into a broken
# state that looks like an OAuth bug.
#
# Pattern: run as root briefly, chown the volume, then `su-exec` down to
# the unprivileged dario user before exec'ing the actual process.

set -e

DARIO_HOME=/home/dario/.dario

if [ "$(id -u)" = "0" ]; then
  # Running as root — self-heal then drop privileges
  # The mkdir handles the case where the volume mount created an empty dir
  # that didn't inherit the build-stage ownership.
  mkdir -p "$DARIO_HOME"
  chown -R dario:dario "$DARIO_HOME"
  exec su-exec dario node /app/dist/cli.js "$@"
fi

# Already running as a non-root user (operator opted out of the self-heal by
# setting USER explicitly, or this is a CI runner without root) — just exec.
exec node /app/dist/cli.js "$@"
