#!/usr/bin/env node
/**
 * Unit tests for the released-vs-deployed verdict.
 *
 * This logic is only ever exercised for real when a deploy is stuck — i.e.
 * exactly when nobody is watching and the answer matters most. So it is pinned
 * here rather than discovered in production. The failure mode of a watcher is
 * not a crash; it is quietly reporting "aligned" forever.
 */
import { deployVerdict, parseVersion, compareVersions } from '../scripts/deploy-verdict.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const MIN = 60_000;
const GRACE = 90 * MIN;
const v = (o) => deployVerdict({ graceMs: GRACE, ...o });

header('version parsing tolerates the tag/package split');
{
  // Releases are tagged `v5.5.66`; the container reports `5.5.66`. Comparing
  // them raw would make every aligned deploy look mismatched.
  check('a v-prefixed tag parses', JSON.stringify(parseVersion('v5.5.66')) === '[5,5,66]');
  check('a bare version parses', JSON.stringify(parseVersion('5.5.66')) === '[5,5,66]');
  check('they compare equal', compareVersions('5.5.66', 'v5.5.66') === 0);
  check('junk is null, not 0', parseVersion('latest') === null);
  check('numeric compare, not lexical (5.5.9 < 5.5.66)', compareVersions('5.5.9', '5.5.66') === -1);
}

header('aligned');
{
  const r = v({ deployed: '5.5.66', released: 'v5.5.66', releaseAgeMs: 5 * MIN });
  check('state', r.state === 'aligned', r.state);
  check('does not alert', r.alert === false);
}

header('a deploy in flight must NOT page');
{
  // The common case: a release was just cut and the box has not pulled yet.
  // Alerting here would page on literally every release.
  const r = v({ deployed: '5.5.65', released: 'v5.5.66', releaseAgeMs: 4 * MIN });
  check('state is deploying', r.state === 'deploying', r.state);
  check('does not alert', r.alert === false);
  check('summary says why it is being patient', /window/.test(r.summary), r.summary);
}

header('a deploy that never landed MUST page');
{
  const r = v({ deployed: '5.5.65', released: 'v5.5.66', releaseAgeMs: 5 * 60 * MIN });
  check('state is stuck', r.state === 'stuck', r.state);
  check('alerts', r.alert === true);
  check('summary names both versions', /5\.5\.65/.test(r.summary) && /5\.5\.66/.test(r.summary), r.summary);
}

header('the grace boundary is exact');
{
  check('one ms inside the window is still deploying',
    v({ deployed: '5.5.65', released: 'v5.5.66', releaseAgeMs: GRACE - 1 }).state === 'deploying');
  check('exactly at the window is stuck (not off-by-one into silence)',
    v({ deployed: '5.5.65', released: 'v5.5.66', releaseAgeMs: GRACE }).state === 'stuck');
}

header('running something that was never released');
{
  // A hand-built image or an aborted rollback. The tag no longer describes
  // what is running, which is the whole invariant.
  const r = v({ deployed: '5.6.0', released: 'v5.5.66', releaseAgeMs: 10 * 60 * MIN });
  check('state is ahead', r.state === 'ahead', r.state);
  check('alerts regardless of grace', r.alert === true);
  check('a fresh release does not excuse it',
    v({ deployed: '5.6.0', released: 'v5.5.66', releaseAgeMs: 1 * MIN }).alert === true);
}

header('unreadable input never alerts — the health watcher owns container-down');
{
  // Two watchers filing separate issues for one outage doubles the noise on
  // the worst possible day. Silence here is a division of labour, not a gap.
  for (const bad of [null, '', '   ', 'latest', 'unknown']) {
    const r = v({ deployed: bad, released: 'v5.5.66', releaseAgeMs: 10 * 60 * MIN });
    check(`deployed=${JSON.stringify(bad)} -> unreadable, no alert`, r.state === 'unreadable' && r.alert === false, r.state);
  }
  const r = v({ deployed: '5.5.66', released: null, releaseAgeMs: 10 * 60 * MIN });
  check('unreadable release -> no alert', r.state === 'unreadable' && r.alert === false, r.state);
}

header('every verdict explains itself');
{
  // These strings land in a GH issue that someone reads at 3am.
  for (const c of [
    { deployed: '5.5.66', released: 'v5.5.66', releaseAgeMs: MIN },
    { deployed: '5.5.65', released: 'v5.5.66', releaseAgeMs: MIN },
    { deployed: '5.5.65', released: 'v5.5.66', releaseAgeMs: 500 * MIN },
    { deployed: '5.6.0', released: 'v5.5.66', releaseAgeMs: MIN },
    { deployed: '', released: 'v5.5.66', releaseAgeMs: MIN },
  ]) {
    const r = v(c);
    check(`${r.state}: summary is non-empty`, typeof r.summary === 'string' && r.summary.length > 10, r.summary);
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
