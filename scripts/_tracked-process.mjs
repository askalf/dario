// Start a server process and stop all of it.
//
// A CLI may relaunch itself under another runtime and leave a wrapper behind
// that does not forward signals (dist/cli.js does this under Bun). Killing the
// wrapper then leaves the real server listening. The child is therefore started
// as the leader of its own process group, and `stop` signals the group and
// reports whether the server actually went away.

import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spawn `command args` in its own process group.
 * Returns { child, hasExited(), stop(listening, { graceMs, killMs }) }.
 *
 * `stop` sends SIGTERM to the group, waits up to graceMs for `listening()` to
 * turn false, then sends SIGKILL and waits up to killMs. It resolves true when
 * the server no longer answers, false when it still does.
 */
export function startTracked(command, args, options = {}) {
  // Windows has no process groups to signal; the child alone is killed there.
  const grouped = process.platform !== 'win32';
  const child = spawn(command, args, { ...options, detached: grouped });
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', () => { exited = true; });

  const signal = (sig) => {
    try {
      if (grouped && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // The group is already gone.
    }
  };
  // The group outlives this process unless it is told otherwise.
  const lastResort = () => signal('SIGKILL');
  process.once('exit', lastResort);

  const stop = async (listening, { graceMs = 5000, killMs = 3000 } = {}) => {
    const gone = async (ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (!(await listening())) return true;
        await sleep(100);
      }
      return !(await listening());
    };
    signal('SIGTERM');
    let stopped = await gone(graceMs);
    if (!stopped) {
      signal('SIGKILL');
      stopped = await gone(killMs);
    }
    if (stopped) process.removeListener('exit', lastResort);
    return stopped;
  };

  return { child, hasExited: () => exited, stop };
}
