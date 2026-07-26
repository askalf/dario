/**
 * dario#872 guard 3 — the capture must not accept a request it cannot attribute
 * to the CC child it spawned.
 *
 * Before this, the MITM took the FIRST request whose URL merely contained
 * `/v1/messages`. The port is ephemeral so a collision is improbable rather than
 * impossible, and nothing downstream could tell a foreign request from the
 * child's once captured.
 *
 * The nonce rides in the URL rather than in ANTHROPIC_API_KEY, which was
 * measured rather than assumed: CC honours a path segment in
 * ANTHROPIC_BASE_URL (`http://127.0.0.1:PORT/<nonce>` produces
 * `/<nonce>/v1/messages?beta=true`), and on a subscription install it
 * authenticates with `authorization: Bearer sk-ant-…` — so a key-borne nonce
 * would do nothing there while changing the auth path for API-key installs.
 */
import { isOwnCaptureRequest } from '../dist/live-fingerprint.js';

const N = 'dario-capture-deadbeefdeadbeefdeadbeef';

let pass = 0;
let fail = 0;

function header(name) {
  console.log(`\n${name}`);
}

function check(label, cond) {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

header('1. our own child is accepted');
check('plain path', isOwnCaptureRequest(`/${N}/v1/messages`, N) === true);
// CC actually sends this shape — the query string is not optional in practice.
check('with ?beta=true', isOwnCaptureRequest(`/${N}/v1/messages?beta=true`, N) === true);
check('count_tokens under the same nonce', isOwnCaptureRequest(`/${N}/v1/messages/count_tokens`, N) === true);

header('2. the dario#872 case — a /v1/messages we cannot attribute');
check('no nonce at all is rejected', isOwnCaptureRequest('/v1/messages', N) === false);
check('with query string, still rejected', isOwnCaptureRequest('/v1/messages?beta=true', N) === false);
check(
  "another capture's nonce is rejected",
  isOwnCaptureRequest('/dario-capture-0000000000000000000000/v1/messages', N) === false,
);
// The nonce must be the PREFIX. Appearing anywhere in the path is not enough,
// or anything that can echo it back into a URL defeats the check.
check(
  'nonce present but not as prefix is rejected',
  isOwnCaptureRequest(`/someone-else/${N}/v1/messages`, N) === false,
);

header('3. other paths on our own port');
// CC probes this first; it must 404 like before, not be mistaken for a capture.
check('api/hello under our nonce is not a capture', isOwnCaptureRequest(`/${N}/api/hello`, N) === false);
check('v1/models under our nonce is not a capture', isOwnCaptureRequest(`/${N}/v1/models`, N) === false);
check('bare nonce root is not a capture', isOwnCaptureRequest(`/${N}/`, N) === false);

header('4. fails closed');
check('undefined url', isOwnCaptureRequest(undefined, N) === false);
check('empty url', isOwnCaptureRequest('', N) === false);
// An empty nonce would otherwise make `/${''}/v1/messages` = `//v1/messages`
// matchable, and worse, would accept a bare `/v1/...` under some prefixes.
check('empty nonce accepts nothing', isOwnCaptureRequest('/v1/messages', '') === false);
check('empty nonce with slash prefix accepts nothing', isOwnCaptureRequest('//v1/messages', '') === false);

console.log(`\n# pass ${pass}`);
console.log(`# fail ${fail}`);
if (fail > 0) process.exit(1);
