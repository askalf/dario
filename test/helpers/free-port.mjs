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
// Lives in a subdirectory so all.test.mjs (top-level *.mjs only) does not run
// it as a test.

import { createServer } from 'node:net';

/** @returns {Promise<number>} */
export function freePort() {
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
