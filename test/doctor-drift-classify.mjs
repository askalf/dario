#!/usr/bin/env node
// Unit tests for scripts/doctor-drift-classify.mjs — the pure parse + drift
// classifier behind the dario-doctor-watch. The headline case is dario#721:
// an "OAuth expired" row that coexists with fully-passing obedience probes
// (dario refreshes the bearer in-memory and doesn't persist the fresh expiry
// to the on-disk credential doctor reads) must NOT file OAuth drift — the
// non-Haiku obedience PONGs prove OAuth is serving. Everything else the
// watcher flags (a genuinely dead bearer, a stale live-capture template, an
// identity WARN, an obedience FAIL) must still trip.

import { classifyDoctorOutput } from '../scripts/doctor-drift-classify.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// Build a doctor dump from [status, detail] rows.
const dump = (rows) => rows.map(([st, txt]) => `  [${st}]  ${txt}`).join('\n') + '\n';
const has = (drift, name) => drift.some((d) => d.check === name);

const OAUTH_OK = ['OK', 'OAuth               healthy (expires in 3h 12m)'];
const OAUTH_EXPIRED = ['WARN', 'OAuth               expired'];
const TEMPLATE_BUNDLED = ['INFO', 'Template            bundled capture, CC v2.1.207 (13h old) (schema v3)'];
const TEMPLATE_LIVE = ['INFO', 'Template            live capture, CC v2.1.207 (2h old) (schema v3)'];
const IDENTITY_OK = ['OK', 'Identity            1/1 pool account match ~/.claude.json (userID=798b515a…)'];
const IDENTITY_WARN = ['WARN', 'Identity            bearer/userID mismatch (userID drift)'];
const OB = (fam, st = 'OK', d = '"PONG" (attempt 1/3)') => [st, `Obedience (${fam})  ${d}`];
const OB_ALL_OK = [OB('haiku'), OB('sonnet'), OB('opus'), OB('fable')];

// ─────────────────────────────────────────────────────────────
header('dario#721 — OAuth expired but all obedience PONG → NO OAuth drift');
{
  const r = classifyDoctorOutput(dump([OAUTH_EXPIRED, TEMPLATE_BUNDLED, IDENTITY_OK, ...OB_ALL_OK]));
  check('OAuth parsed as WARN/expired', r.oauth && r.oauth.status === 'WARN');
  check('4 obedience rows parsed', r.obedience.length === 4);
  check('no OAuth drift (non-Haiku serves)', !has(r.drift, 'OAuth'));
  check('drift is empty overall', r.drift.length === 0);
  check('parsedAnchors true', r.parsedAnchors === true);
}

header('dead bearer — OAuth expired + non-Haiku FAIL → OAuth drift fires');
{
  const r = classifyDoctorOutput(dump([
    OAUTH_EXPIRED, TEMPLATE_BUNDLED, IDENTITY_OK,
    OB('haiku'), OB('sonnet', 'FAIL', 'ignored system prompt'),
    OB('opus', 'FAIL', 'ignored system prompt'), OB('fable', 'FAIL', 'ignored system prompt'),
  ]));
  check('OAuth drift present', has(r.drift, 'OAuth'));
  check('obedience FAIL also drifts', has(r.drift, 'Obedience'));
}

header('predates --obedience — OAuth expired + no obedience rows → OAuth drift fires');
{
  const r = classifyDoctorOutput(dump([OAUTH_EXPIRED, TEMPLATE_BUNDLED, IDENTITY_OK]));
  check('no obedience rows', r.obedience.length === 0);
  check('OAuth drift present (serving unproven)', has(r.drift, 'OAuth'));
}

header('partial non-Haiku not OK — OAuth expired + opus WARN → OAuth drift fires');
{
  const r = classifyDoctorOutput(dump([
    OAUTH_EXPIRED, TEMPLATE_BUNDLED, IDENTITY_OK,
    OB('haiku'), OB('sonnet'), OB('opus', 'WARN', 'probe timed out'), OB('fable'),
  ]));
  check('OAuth drift present (not every non-Haiku OK)', has(r.drift, 'OAuth'));
}

header('healthy fleet → no drift');
{
  const r = classifyDoctorOutput(dump([OAUTH_OK, TEMPLATE_BUNDLED, IDENTITY_OK, ...OB_ALL_OK]));
  check('drift empty', r.drift.length === 0);
}

header('other drifts still fire (behaviour preserved)');
{
  const live = classifyDoctorOutput(dump([OAUTH_OK, TEMPLATE_LIVE, IDENTITY_OK, ...OB_ALL_OK]));
  check('live-capture template → Template drift', has(live.drift, 'Template'));

  const idw = classifyDoctorOutput(dump([OAUTH_OK, TEMPLATE_BUNDLED, IDENTITY_WARN, ...OB_ALL_OK]));
  check('identity WARN → Identity drift', has(idw.drift, 'Identity'));

  const obf = classifyDoctorOutput(dump([
    OAUTH_OK, TEMPLATE_BUNDLED, IDENTITY_OK,
    OB('haiku'), OB('sonnet', 'FAIL', 'ignored system prompt'), OB('opus'), OB('fable'),
  ]));
  check('obedience FAIL (OAuth OK) → Obedience drift, no OAuth drift', has(obf.drift, 'Obedience') && !has(obf.drift, 'OAuth'));
}

header('format error — neither anchor row → parsedAnchors false');
{
  const r = classifyDoctorOutput('some unrelated output\nwith no doctor rows\n');
  check('parsedAnchors false', r.parsedAnchors === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
