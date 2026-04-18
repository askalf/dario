// Unit tests for the authorize-URL probe response classifier
// (scripts/_authorize-probe-classifier.mjs). Pure-function tests — no
// network calls. Feeds synthetic response shapes into the classifier
// and asserts verdicts; also checks the A/B combiner returns the right
// outcome for each scenario cc-drift-watch cares about.

import {
  classifyAuthorizeResponse,
  combineVerdicts,
  REJECT_MARKER,
} from '../scripts/_authorize-probe-classifier.mjs';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

header('classifyAuthorizeResponse');

{
  const r = classifyAuthorizeResponse({
    status: 400,
    location: null,
    body: `<html><body>Error: ${REJECT_MARKER}</body></html>`,
    error: null,
  });
  check('400 with reject marker -> rejected', r.verdict === 'rejected');
}

{
  const r = classifyAuthorizeResponse({
    status: 302,
    location: 'https://claude.com/login?continue=...',
    body: '',
    error: null,
  });
  check('302 with Location -> accepted', r.verdict === 'accepted');
}

{
  const r = classifyAuthorizeResponse({
    status: 200,
    location: null,
    body: '<html><body>Sign in to authorize claude-code</body></html>',
    error: null,
  });
  check('200 consent page (no marker) -> accepted', r.verdict === 'accepted');
}

{
  const r = classifyAuthorizeResponse({
    status: 500,
    location: null,
    body: 'Internal Server Error',
    error: null,
  });
  check('500 -> inconclusive', r.verdict === 'inconclusive');
}

{
  const r = classifyAuthorizeResponse({
    status: 0,
    location: null,
    body: '',
    error: 'ENOTFOUND claude.com',
  });
  check('network error -> inconclusive', r.verdict === 'inconclusive');
}

{
  // The reject marker wins even if the status looks success-y. Not a
  // realistic server response, but the classifier should be conservative
  // about the marker since that's the signal we care most about.
  const r = classifyAuthorizeResponse({
    status: 200,
    location: null,
    body: REJECT_MARKER,
    error: null,
  });
  check('200 with reject marker in body -> rejected', r.verdict === 'rejected');
}

{
  const r = classifyAuthorizeResponse({
    status: 302,
    location: null,
    body: '',
    error: null,
  });
  check('3xx without Location -> inconclusive', r.verdict === 'inconclusive');
}

{
  // The exact shape CI runners see: CF interstitial at 403 with "Just a moment..." title.
  const r = classifyAuthorizeResponse({
    status: 403,
    location: null,
    body: '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>...</body></html>',
    error: null,
  });
  check('CF challenge 403 -> inconclusive with CF-specific reason', r.verdict === 'inconclusive' && r.reason.includes('Cloudflare'));
}

{
  // CF sometimes serves the challenge with status 200 and JS.
  const r = classifyAuthorizeResponse({
    status: 200,
    location: null,
    body: '<html><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=..."></script></body></html>',
    error: null,
  });
  check('CF challenge 200 -> inconclusive (not mis-classified as accepted)', r.verdict === 'inconclusive' && r.reason.includes('Cloudflare'));
}

header('combineVerdicts');

{
  const r = combineVerdicts(
    { verdict: 'accepted', reason: '302 to login' },
    { verdict: 'rejected', reason: 'body contains marker' },
  );
  check('A accepted, B rejected -> clean, no drift', r.outcome === 'clean' && r.drift === false && r.items.length === 0);
}

{
  const r = combineVerdicts(
    { verdict: 'rejected', reason: 'body contains marker' },
    { verdict: 'rejected', reason: 'body contains marker' },
  );
  check('A rejected -> drift, high severity', r.drift === true && r.items.some((i) => i.probe === 'A' && i.severity === 'high'));
}

{
  const r = combineVerdicts(
    { verdict: 'accepted', reason: '302 to login' },
    { verdict: 'accepted', reason: '302 to login' },
  );
  check('B accepted -> drift, medium severity', r.drift === true && r.items.some((i) => i.probe === 'B' && i.severity === 'medium'));
}

{
  const r = combineVerdicts(
    { verdict: 'inconclusive', reason: 'fetch error: timeout' },
    { verdict: 'rejected', reason: 'body contains marker' },
  );
  check('A inconclusive -> outcome inconclusive, no drift claim', r.outcome === 'inconclusive' && r.drift === false);
  check('inconclusive item severity is info (not page-worthy)', r.items.length === 1 && r.items[0].severity === 'info');
}

{
  const r = combineVerdicts(
    { verdict: 'inconclusive', reason: 'fetch error' },
    { verdict: 'inconclusive', reason: 'fetch error' },
  );
  check('both inconclusive -> two info items, no drift', r.outcome === 'inconclusive' && r.drift === false && r.items.length === 2);
}

{
  // Both drifted at once (A rejected AND B accepted). This would mean
  // the server rotated its entire scope policy — both items should land
  // in the report so the issue body tells the whole story.
  const r = combineVerdicts(
    { verdict: 'rejected', reason: 'body contains marker' },
    { verdict: 'accepted', reason: '302 to login' },
  );
  check('A rejected AND B accepted -> both items reported', r.drift === true && r.items.length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
