#!/usr/bin/env node
/**
 * The proxy that scripts/rebake-upstream-check.mjs sends its probes to.
 *
 *   node scripts/_rebake-probe-proxy.mjs <port> <recordFile>
 *
 * It is this checkout's proxy, started in code and not through the CLI. The
 * CLI resolves most of its options from flags, DARIO_* variables and
 * ~/.dario/config.json, any of which can change how a request is built
 * (passthrough, the system-prompt mode, skipped fields, model aliases).
 * Here every option is either set below or left at the proxy's own default.
 *
 * Every request the proxy sends upstream is appended to <recordFile> as one
 * JSON line, { url, status, request }, once upstream has answered. `request`
 * holds the model, system blocks and tools of a /v1/messages body and is null
 * for anything else. Headers are never recorded: they carry the subscription
 * token. Neither is the rest of the body, which names the account.
 */
import { appendFileSync } from 'node:fs';
import { startProxy } from '../dist/proxy.js';

const [port, recordFile] = process.argv.slice(2);

const sentRequest = (body) => {
  try {
    const { model, system, tools } = JSON.parse(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
    return { model, system, tools };
  } catch {
    return {};
  }
};

const recording = async (input, init) => {
  const { origin, pathname } = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)));
  const entry = { url: origin + pathname, status: 0, request: pathname === '/v1/messages' ? sentRequest(init?.body) : null };
  try {
    const response = await fetch(input, init);
    entry.status = response.status;
    return response;
  } finally {
    try {
      appendFileSync(recordFile, JSON.stringify(entry) + '\n');
    } catch {
      // A record that cannot be written must not fail the request it describes.
      // The check gives no verdict on a 200 that it has no record for.
    }
  }
};

await startProxy({
  port: Number(port),
  host: '127.0.0.1',
  fetchImpl: recording,
  // The bundle is the only template: no capture is made, and the caller points
  // the live template cache at a file that does not exist.
  noLiveCapture: true,
  // A probe run keeps no lifetime ledger and takes no part in ~/.dario/keys.json,
  // and its overage guard raises no desktop notification.
  ledger: false,
  keys: false,
  overageGuardNotifyOs: false,
});
