// A loopback port the kernel says is free right now.
//
// The in-process proxy tests used to pin ports like 38838. Linux hands out
// ephemeral source ports from 32768-60999, so on a busy host a long-lived
// loopback connection can be sitting on exactly that number — on the
// self-hosted runner it was cloudflared, `127.0.0.1:38838 -> 127.0.0.1:3005`,
// ESTABLISHED for hours — and `startProxy` then fails with "Port 38838 is
// already in use" on every PR until the connection recycles (dario#1235's
// live-test, 2026-09-06). Asking for port 0 and reading back the assignment
// sidesteps the whole range.
//
// The port is released before it is returned, so there is a short window in
// which something else could take it. That is the standard trade-off for a
// proxy that needs to know its port before it listens; the window is
// microseconds against a collision that used to last for hours.
//
// That same release, though, lets the kernel hand the SAME number to two
// consecutive calls in ONE file — it is free again by the time the second
// call asks. dario#1323's live-test hit exactly that: `codex-pool-seat-
// rotation.mjs` drew 39989 for both CODEX_PORT and PROXY_PORT, the stub
// bound it first, and startProxy died with "Port 39989 is already in use by
// another process", which all.test.mjs's retry did not match at the time,
// so the file failed outright. `issued` remembers every port
// this process has handed out and re-draws past it.
//
// `issued` is per process, and all.test.mjs runs several files at once. When
// DARIO_TEST_PORT_DIR is set, it names a directory shared by every file in
// the run, and a port is handed out only once a file named after it can be
// created there with `wx`. That create is atomic and fails if the file
// exists, so each number goes to one file per run. Without the variable,
// only `issued` applies.
//
// Lives in a subdirectory so all.test.mjs (top-level *.mjs only) does not run
// it as a test.

import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every port already handed out in this process — never reissued. */
const issued = new Set();

/** Claim a port for the whole suite run; false if another file already has it. */
function reserve(port) {
  const dir = process.env.DARIO_TEST_PORT_DIR;
  if (!dir) return true;
  try {
    writeFileSync(join(dir, String(port)), String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

/** @returns {Promise<number>} */
function drawPort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** @returns {Promise<number>} */
export async function freePort() {
  // The kernel cycles the ephemeral range, so a repeat is rare and a fresh
  // number arrives on the next draw; the cap only stops an unbounded loop if
  // the range is somehow exhausted.
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await drawPort();
    if (issued.has(port)) continue;
    issued.add(port);
    if (reserve(port)) return port;
  }
  throw new Error('freePort: could not find an unused loopback port in 50 attempts');
}
