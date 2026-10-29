#!/usr/bin/env node
/**
 * The browser request guard's two predicates, on their own (browser-guard.ts).
 *
 * isCrossOriginAllowed is the CSRF half: a page on another origin must not get
 * a state-changing request through. isBrowserHostAllowed is the DNS-rebinding
 * half: a page whose name now resolves to 127.0.0.1 is same-origin to the
 * browser, so only its Host header gives it away. The property that matters
 * most is the one nobody notices when it holds: a request with neither
 * Origin nor Sec-Fetch-Site (every SDK, curl, CLI) is never judged at all.
 */
import {
  allowedBrowserHosts, hostnameOf, isBrowserHostAllowed, isBrowserRequest,
  isCrossOriginAllowed, normalizeOrigin, trustedOriginSet,
} from '../dist/browser-guard.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const trusted = trustedOriginSet(['http://localhost:3456']);
const host = { host: '127.0.0.1:3456' };

header('normalizeOrigin');
check('http origin keeps scheme, host, port', normalizeOrigin('http://localhost:3456') === 'http://localhost:3456');
check('trailing slash and case are dropped', normalizeOrigin('HTTPS://App.Example/') === 'https://app.example');
check('a default port is dropped the way browsers send it', normalizeOrigin('https://app.example:443') === 'https://app.example');
check('null stays null', normalizeOrigin('null') === 'null');
check('an extension origin is kept as written', normalizeOrigin('chrome-extension://abcdef') === 'chrome-extension://abcdef');
check('garbage is never an origin', normalizeOrigin('not an origin') === undefined && normalizeOrigin('') === undefined);

header('hostnameOf');
check('drops the port', hostnameOf('localhost:3456') === 'localhost');
check('keeps IPv6 brackets', hostnameOf('[::1]:3456') === '[::1]');
check('lower-cases', hostnameOf('Attacker.Example:3456') === 'attacker.example');
check('no port is fine', hostnameOf('127.0.0.1') === '127.0.0.1');
check('a bare IPv6 address is not a Host', hostnameOf('::1') === undefined);
check('missing Host is undefined', hostnameOf(undefined) === undefined);

header('isBrowserRequest: what is never judged');
check('no headers: not a browser', !isBrowserRequest({ host: '127.0.0.1:3456' }));
check('Node fetch sends Sec-Fetch-Mode only: not a browser', !isBrowserRequest({ host: '127.0.0.1:3456', 'sec-fetch-mode': 'cors' }));
check('Origin marks a browser', isBrowserRequest({ origin: 'https://x.example' }));
check('Sec-Fetch-Site marks a browser', isBrowserRequest({ 'sec-fetch-site': 'same-origin' }));

header('isCrossOriginAllowed: the reported attack');
check('text/plain no-cors POST from another site, modern browser: refused',
  !isCrossOriginAllowed('POST', { ...host, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, trusted));
check('same, from a browser with no Sec-Fetch-Site: refused on Origin vs Host',
  !isCrossOriginAllowed('POST', { ...host, origin: 'https://attacker.example', 'content-type': 'text/plain' }, trusted));
check('Sec-Fetch-Site cross-site with no Origin: refused',
  !isCrossOriginAllowed('POST', { ...host, 'sec-fetch-site': 'cross-site' }, trusted));
check('another localhost port is same-site, not same-origin: refused',
  !isCrossOriginAllowed('POST', { ...host, origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' }, trusted));
check('Origin null (sandboxed frame, file: page): refused',
  !isCrossOriginAllowed('POST', { ...host, origin: 'null' }, trusted));
check('a garbage Origin is refused, not waved through',
  !isCrossOriginAllowed('POST', { ...host, origin: '%%%' }, trusted));
check('PUT and DELETE are judged like POST',
  !isCrossOriginAllowed('PUT', { ...host, 'sec-fetch-site': 'cross-site' }, trusted)
  && !isCrossOriginAllowed('DELETE', { ...host, 'sec-fetch-site': 'cross-site' }, trusted));

header('isCrossOriginAllowed: what keeps working');
check('no Origin, no Sec-Fetch-Site (SDK, curl): allowed', isCrossOriginAllowed('POST', { ...host, 'content-type': 'text/plain' }, trusted));
check('same-origin (the dashboard): allowed', isCrossOriginAllowed('POST', { ...host, origin: 'http://127.0.0.1:3456', 'sec-fetch-site': 'same-origin' }, trusted));
check('none (typed URL, bookmark): allowed', isCrossOriginAllowed('POST', { ...host, 'sec-fetch-site': 'none' }, trusted));
check('old browser, Origin equals Host: allowed', isCrossOriginAllowed('POST', { ...host, origin: 'http://127.0.0.1:3456' }, trusted));
check('old browser, Origin differs from Host only by port: refused', !isCrossOriginAllowed('POST', { ...host, origin: 'http://127.0.0.1:3457' }, trusted));
check('the trusted CORS origin, cross-site: allowed', isCrossOriginAllowed('POST', { ...host, origin: 'http://localhost:3456', 'sec-fetch-site': 'cross-site' }, trusted));
check('GET, HEAD and OPTIONS are never judged',
  ['GET', 'HEAD', 'OPTIONS'].every((m) => isCrossOriginAllowed(m, { ...host, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }, trusted)));
check('method case does not matter', isCrossOriginAllowed('get', { ...host, 'sec-fetch-site': 'cross-site' }, trusted));
const ext = trustedOriginSet(['chrome-extension://abcdef']);
check('a trusted extension origin: allowed', isCrossOriginAllowed('POST', { ...host, origin: 'chrome-extension://abcdef', 'sec-fetch-site': 'cross-site' }, ext));
check('a different extension: refused', !isCrossOriginAllowed('POST', { ...host, origin: 'chrome-extension://zzzzzz', 'sec-fetch-site': 'cross-site' }, ext));

header('allowedBrowserHosts');
{
  const hosts = allowedBrowserHosts(trustedOriginSet(['https://dario.example.com']), '127.0.0.1');
  check('localhost is always allowed', hosts.has('localhost'));
  check('the trusted origin host is allowed', hosts.has('dario.example.com'));
  check('the bind host is allowed', hosts.has('127.0.0.1'));
  check('an IPv6 bind host is bracketed like a Host header', allowedBrowserHosts(new Set(), '::1').has('[::1]'));
  check('an extension origin adds no host', allowedBrowserHosts(ext, undefined).size === 1);
}

header('isBrowserHostAllowed: DNS rebinding');
{
  const allowed = allowedBrowserHosts(trusted, '127.0.0.1');
  check('a rebound attacker name: refused', !isBrowserHostAllowed({ host: 'attacker.example:3456' }, allowed));
  check('localhost: allowed', isBrowserHostAllowed({ host: 'localhost:3456' }, allowed));
  check('a *.localhost name: allowed', isBrowserHostAllowed({ host: 'dario.localhost:3456' }, allowed));
  check('a name that only ends in localhost: refused', !isBrowserHostAllowed({ host: 'evillocalhost:3456' }, allowed));
  check('an IPv4 literal: allowed', isBrowserHostAllowed({ host: '192.168.1.5:3456' }, allowed));
  check('an IPv6 literal: allowed', isBrowserHostAllowed({ host: '[::1]:3456' }, allowed));
  check('no Host: refused', !isBrowserHostAllowed({}, allowed));
  check('a trusted origin host: allowed',
    isBrowserHostAllowed({ host: 'dario.example.com' }, allowedBrowserHosts(trustedOriginSet(['https://dario.example.com']), undefined)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
