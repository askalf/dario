// Unit tests for drift detection + schema versioning helpers added in
// v3.17 (live-fingerprint.ts). These are pure-function tests — no CC
// binary probe runs; the `detectDrift` helper accepts an injected
// installed-version string specifically so these tests can exercise
// every drift branch without spawning a real process.

import {
  CURRENT_SCHEMA_VERSION,
  detectDrift,
  describeTemplate,
  formatCaptureAge,
  extractTemplate,
} from '../dist/live-fingerprint.js';

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

function templateFixture(overrides = {}) {
  return {
    _version: '2.1.104',
    _captured: new Date().toISOString(),
    _source: 'live',
    _schemaVersion: CURRENT_SCHEMA_VERSION,
    agent_identity: 'You are Claude Code.',
    system_prompt: 'stub',
    tools: [{ name: 'Bash', description: '', input_schema: {} }],
    tool_names: ['Bash'],
    ...overrides,
  };
}

// ======================================================================
//  detectDrift — matching versions
// ======================================================================
header('detectDrift — cache matches installed CC');
{
  const t = templateFixture({ _version: '2.1.104' });
  const r = detectDrift(t, '2.1.104');
  check('drifted=false when versions match', r.drifted === false);
  check('cachedVersion echoes template._version', r.cachedVersion === '2.1.104');
  check('installedVersion echoes override', r.installedVersion === '2.1.104');
  check('message mentions the version', r.message.includes('2.1.104'));
}

// ======================================================================
//  detectDrift — mismatched versions
// ======================================================================
header('detectDrift — cache lags installed CC');
{
  const t = templateFixture({ _version: '2.1.104' });
  const r = detectDrift(t, '2.2.0');
  check('drifted=true when versions differ', r.drifted === true);
  check('cachedVersion = captured', r.cachedVersion === '2.1.104');
  check('installedVersion = installed', r.installedVersion === '2.2.0');
  check('message identifies both versions', r.message.includes('2.1.104') && r.message.includes('2.2.0'));
  check('message hints at refresh', r.message.includes('refresh'));
}

// ======================================================================
//  detectDrift — probe unavailable
// ======================================================================
header('detectDrift — installed CC unavailable (probe returned null)');
{
  const t = templateFixture({ _version: '2.1.104' });
  const r = detectDrift(t, null);
  check('drifted=false when installed version unknown', r.drifted === false);
  check('installedVersion=null is propagated', r.installedVersion === null);
  check('message explains probe miss', r.message.toLowerCase().includes('not probed'));
}

// ======================================================================
//  formatCaptureAge — time formatting
// ======================================================================
header('formatCaptureAge — seconds / minutes / hours / days');
{
  const now = Date.parse('2026-04-16T12:00:00.000Z');
  check('30 seconds → "30s"', formatCaptureAge(new Date(now - 30_000).toISOString(), now) === '30s');
  check('5 minutes → "5m"', formatCaptureAge(new Date(now - 5 * 60_000).toISOString(), now) === '5m');
  check('3 hours → "3h"', formatCaptureAge(new Date(now - 3 * 3600_000).toISOString(), now) === '3h');
  check('3 days → "3d"', formatCaptureAge(new Date(now - 3 * 86_400_000).toISOString(), now) === '3d');
  check('future timestamp clamped → "0s"', formatCaptureAge(new Date(now + 10_000).toISOString(), now) === '0s');
  check('unparseable string → "unknown age"', formatCaptureAge('not-a-date', now) === 'unknown age');
}

// ======================================================================
//  describeTemplate — human summary
// ======================================================================
header('describeTemplate — one-line summary');
{
  const t = templateFixture({
    _version: '2.1.104',
    _captured: new Date(Date.now() - 5 * 60_000).toISOString(),
    _source: 'live',
  });
  const s = describeTemplate(t);
  check('mentions source', s.includes('live'));
  check('mentions CC version', s.includes('2.1.104'));
  check('mentions age', /\d+[smhd]/.test(s));

  const bundled = templateFixture({ _source: 'bundled' });
  check('bundled label surfaces', describeTemplate(bundled).startsWith('bundled'));

  const undefSource = templateFixture({ _source: undefined });
  check('undefined _source falls back to "bundled"', describeTemplate(undefSource).startsWith('bundled'));
}

// ======================================================================
//  extractTemplate — new captures stamp CURRENT_SCHEMA_VERSION
// ======================================================================
header('extractTemplate — fresh captures are stamped with the current schema version');
{
  const captured = {
    method: 'POST',
    path: '/v1/messages',
    headers: {
      'x-anthropic-billing-header': 'cc_version=2.1.104; cc_session_id=s',
      'user-agent': 'claude-cli/2.1.104',
    },
    rawHeaders: ['user-agent', 'claude-cli/2.1.104', 'x-anthropic-billing-header', 'cc_version=2.1.104'],
    body: {
      system: [
        { type: 'text', text: 'billing' },
        { type: 'text', text: 'You are Claude Code.' },
        { type: 'text', text: 'system prompt body...' },
      ],
      tools: [{ name: 'Bash', description: 'run a shell', input_schema: { type: 'object' } }],
    },
  };
  const t = extractTemplate(captured);
  check('extract returned a template', t !== null);
  check('_schemaVersion stamped', t && t._schemaVersion === CURRENT_SCHEMA_VERSION);
  check('_source stamped "live"', t && t._source === 'live');
  check('_version pulled from billing header', t && t._version === '2.1.104');
  check('header_order populated from rawHeaders', Array.isArray(t && t.header_order) && t.header_order.length === 2);
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);
