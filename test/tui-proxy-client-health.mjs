// ProxyClient.health() reachability semantics (#636).
//
// /health deliberately answers HTTP 503 WITH a JSON body when upstream auth
// is degraded — that's a RUNNING proxy reporting its state, not an
// unreachable one. The old client rejected every non-2xx, so the TUI rendered
// "unreachable — is `dario proxy` running?" against a proxy that was up and
// serving. health() must now parse any HTTP response with a JSON body and
// reserve null for no-response-at-all (connection refused / timeout) or a
// non-JSON body (something else squatting on the port).

import { createServer } from 'node:http';
import { ProxyClient } from '../dist/tui/proxy-client.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

function listen(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const close = (srv) => new Promise((r) => srv.close(r));

header('degraded proxy — 503 with JSON body');
{
  const srv = await listen((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'degraded', oauth: 'none', requests: 0 }));
  });
  const client = new ProxyClient({ baseUrl: `http://127.0.0.1:${srv.address().port}`, timeoutMs: 2000 });

  const h = await client.health();
  check('health() parses the 503 body instead of returning null', h !== null);
  check('degraded status surfaced', h?.status === 'degraded');
  check('oauth state surfaced', h?.oauth === 'none');

  // Regression guard: the default getJson contract (reject on non-2xx) is
  // unchanged for every other endpoint.
  let rejected = false;
  try { await client.getJson('/health'); } catch { rejected = true; }
  check('getJson without anyStatus still rejects non-2xx', rejected);

  await close(srv);
}

header('healthy proxy — 200 unchanged');
{
  const srv = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', oauth: 'healthy', expiresIn: '4h 2m', requests: 7 }));
  });
  const client = new ProxyClient({ baseUrl: `http://127.0.0.1:${srv.address().port}`, timeoutMs: 2000 });
  const h = await client.health();
  check('200 parses as before', h?.status === 'ok' && h?.requests === 7);
  await close(srv);
}

header('foreign server — non-JSON body stays null');
{
  const srv = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>not dario</html>');
  });
  const client = new ProxyClient({ baseUrl: `http://127.0.0.1:${srv.address().port}`, timeoutMs: 2000 });
  check('non-JSON body → null', (await client.health()) === null);
  await close(srv);
}

header('no proxy — connection refused stays null');
{
  // Grab an ephemeral port, then free it so the connect is refused.
  const srv = await listen(() => {});
  const port = srv.address().port;
  await close(srv);
  const client = new ProxyClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 1500 });
  check('connection refused → null (truly unreachable)', (await client.health()) === null);
}

console.log(`\ntui-proxy-client-health: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
