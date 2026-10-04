// Start a server process and stop all of it.
//
// A CLI may relaunch itself under another runtime and leave a wrapper behind
// that does not forward signals (dist/cli.js does this under Bun). Killing the
// wrapper then leaves the real server listening. The child is therefore started
// as the leader of its own process group, and `stop` signals the group and
// reports whether the server and every process in the group actually went away.
//
// Being in another group, the server does not receive a signal sent to the
// process that started it. `startTracked` therefore kills the group when that
// process exits or is ended by a signal.

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The signals that end a process by default and that a job runner or a terminal
// sends. A cancelled job gets SIGINT, then SIGTERM.
const ENDING_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Whether any process of the group `pgid` is left.
 *
 * Signal 0 to the group succeeds while any process in it is left, zombies
 * included. An orphan that nothing reaps (PID 1 in a container) stays a
 * zombie, so on Linux only members that are not zombies count.
 */
export function processGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
  } catch (err) {
    return err.code === 'EPERM';
  }
  if (process.platform !== 'linux') return true;
  try {
    return readdirSync('/proc').some((entry) => {
      if (!/^\d+$/.test(entry)) return false;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        // After the parenthesised command name: state, ppid, pgrp.
        const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return state !== 'Z' && Number(pgrp) === pgid;
      } catch {
        return false;
      }
    });
  } catch {
    return true;
  }
}

/**
 * Spawn `command args` in its own process group.
 * Returns { child, hasExited(), stop(listening, { graceMs, killMs }) }.
 *
 * `stop` sends SIGTERM to the group, waits up to graceMs for `listening()` to
 * turn false and for the group to be empty, then sends SIGKILL and waits up to
 * killMs. A server that closes its listener but keeps running is still killed.
 * It resolves true when the server no longer answers and no process of the
 * group remains, false otherwise.
 *
 * Until `stop` has seen the group gone, the group is killed when this process
 * exits, and when SIGINT, SIGTERM or SIGHUP reaches it. This process then
 * still ends by that signal.
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
  const groupAlive = () => {
    if (!child.pid) return false;
    return grouped ? processGroupAlive(child.pid) : !exited;
  };

  // The group outlives this process unless it is told otherwise. A signal that
  // ends this process runs no exit handler, so each of those is handled here:
  // the group is killed, the handlers are taken away, and the signal is raised
  // again with its default action back in place.
  const lastResort = () => signal('SIGKILL');
  const release = () => {
    process.removeListener('exit', lastResort);
    for (const sig of ENDING_SIGNALS) process.removeListener(sig, onSignal);
  };
  function onSignal(sig) {
    lastResort();
    release();
    process.kill(process.pid, sig);
  }
  process.once('exit', lastResort);
  for (const sig of ENDING_SIGNALS) process.on(sig, onSignal);

  const stop = async (listening, { graceMs = 5000, killMs = 3000 } = {}) => {
    const gone = async (ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (!groupAlive() && !(await listening())) return true;
        await sleep(100);
      }
      return !groupAlive() && !(await listening());
    };
    signal('SIGTERM');
    let stopped = await gone(graceMs);
    if (!stopped) {
      signal('SIGKILL');
      stopped = await gone(killMs);
    }
    // The cleanup above stays until no process of the group is left.
    if (!groupAlive()) release();
    return stopped;
  };

  return { child, hasExited: () => exited, stop };
}
