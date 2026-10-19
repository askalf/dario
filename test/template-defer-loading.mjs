#!/usr/bin/env node
/**
 * A tool declared with `defer_loading: true` keeps the flag through extraction,
 * scrubbing, a live-cache round trip and advertisement, and a template without
 * the flag is unchanged (no `defer_loading: false` on other tools).
 *
 * In-process, no proxy / OAuth / upstream.
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The advertise check needs the placeholder in the LOADED template, so serve it
// from a per-process live cache. The path is resolved per call, but cc-template
// loads at import time, so the env var must be set before the dynamic import.
const DIR = join(tmpdir(), `dario-defer-loading-test-${process.pid}`);
mkdirSync(DIR, { recursive: true });
process.env.DARIO_LIVE_TEMPLATE_CACHE = join(DIR, 'cc-template.live.json');
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* noop */ } });

const { _extractTemplateForTest, CURRENT_SCHEMA_VERSION } = await import('../dist/live-fingerprint.js');
const { scrubTemplate } = await import('../dist/scrub-template.js');
const { computeDrift } = await import('../scripts/drift-report.mjs');

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const PLACEHOLDER = {
  name: 'DeferredToolPlaceholder',
  description: 'Placeholder for a tool that is loaded on demand',
  input_schema: { type: 'object', properties: {} },
  defer_loading: true,
};
const READ = { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } };
const BASH = { name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } };

const captured = {
  method: 'POST',
  path: '/v1/messages',
  headers: { 'user-agent': 'claude-cli/2.1.304 (external)' },
  body: {
    system: [{ type: 'text', text: 'tag' }, { type: 'text', text: 'agent identity' }, { type: 'text', text: 'system prompt' }],
    tools: [BASH, READ, PLACEHOLDER],
    messages: [{ role: 'user', content: 'hi' }],
  },
};

header('extractTemplate keeps defer_loading: true, and only where CC sent it');
{
  const tpl = _extractTemplateForTest(captured);
  const byName = (n) => tpl.tools.find((t) => t.name === n);
  check('placeholder keeps defer_loading: true', byName('DeferredToolPlaceholder').defer_loading === true);
  check('Read has no defer_loading key', !('defer_loading' in byName('Read')));
  check('Bash has no defer_loading key', !('defer_loading' in byName('Bash')));
  check('placeholder name / description / schema survive',
    byName('DeferredToolPlaceholder').description === PLACEHOLDER.description
    && JSON.stringify(byName('DeferredToolPlaceholder').input_schema) === JSON.stringify(PLACEHOLDER.input_schema));
  check('placeholder key order matches CC (defer_loading last)',
    Object.keys(byName('DeferredToolPlaceholder')).join(',') === 'name,description,input_schema,defer_loading');

  const falsy = _extractTemplateForTest({
    ...captured,
    body: { ...captured.body, tools: [BASH, { ...READ, defer_loading: false }, { ...PLACEHOLDER, name: 'Other', defer_loading: 'yes' }] },
  });
  check('defer_loading: false is not carried', !('defer_loading' in falsy.tools.find((t) => t.name === 'Read')));
  check('a non-true defer_loading is not carried', !('defer_loading' in falsy.tools.find((t) => t.name === 'Other')));
}

header('the bake scrubber keeps the flag');
{
  const tpl = _extractTemplateForTest(captured);
  const scrubbed = scrubTemplate(tpl);
  check('scrubbed placeholder keeps defer_loading: true',
    scrubbed.tools.find((t) => t.name === 'DeferredToolPlaceholder').defer_loading === true);
  check('scrubbed Read has no defer_loading key', !('defer_loading' in scrubbed.tools.find((t) => t.name === 'Read')));
  check('scrub is idempotent with the flag',
    JSON.stringify(scrubTemplate(scrubbed)) === JSON.stringify(scrubbed));
}

header('drift detection sees a defer_loading flip');
{
  const withFlag = _extractTemplateForTest(captured);
  const without = JSON.parse(JSON.stringify(withFlag));
  delete without.tools.find((t) => t.name === 'DeferredToolPlaceholder').defer_loading;
  const drift = computeDrift(without, withFlag);
  check('flag gained is reported', drift.some((d) => /defer_loading changed: DeferredToolPlaceholder/.test(d.summary)));
  check('identical templates report no defer_loading drift',
    !computeDrift(withFlag, JSON.parse(JSON.stringify(withFlag))).some((d) => /defer_loading/.test(d.summary)));
}

header('advertise path: a declared DeferredToolPlaceholder goes out with defer_loading: true');
{
  // Serve a live template carrying the placeholder, as a dario next to CC 2.1.304 would.
  const live = _extractTemplateForTest(captured);
  live._captured = new Date().toISOString();
  live._schemaVersion = CURRENT_SCHEMA_VERSION;
  writeFileSync(process.env.DARIO_LIVE_TEMPLATE_CACHE, JSON.stringify(live));

  const { buildCCRequest, CC_NATIVE_NAMES_UNION, CC_TOOL_DEFINITIONS_UNION } = await import('../dist/cc-template.js');
  check('placeholder identity-maps (known native)', CC_NATIVE_NAMES_UNION.has('DeferredToolPlaceholder'));
  check('loaded template def keeps defer_loading: true',
    CC_TOOL_DEFINITIONS_UNION.find((t) => t.name === 'DeferredToolPlaceholder')?.defer_loading === true);

  const clientBody = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [READ, BASH, PLACEHOLDER],
  };
  const { body } = buildCCRequest(clientBody, 'x-anthropic-billing-header: cc_version=test;', { type: 'ephemeral' },
    { deviceId: 'd', accountUuid: 'u', sessionId: 's' }, {});
  const sent = (body.tools || []).find((t) => t.name === 'DeferredToolPlaceholder');
  check('placeholder is advertised', !!sent);
  check('advertised placeholder carries defer_loading: true', sent?.defer_loading === true);
  const sentRead = (body.tools || []).find((t) => t.name === 'Read');
  check('advertised Read has no defer_loading key', !!sentRead && !('defer_loading' in sentRead));
}

console.log(`\ntemplate-defer-loading: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
