#!/usr/bin/env node
/**
 * An advisor tool on the wire carries its beta, dario#1812.
 *
 * dario forwards a client's `advisor_20260301` entry as declared, and the API
 * refuses that entry without `advisor-tool-2026-03-01`. The template has the
 * flag only when the capture it came from did: the bundle does, a live capture
 * from an install without the advisor does not, and on such an instance the
 * forwarded entry failed the request unless the client sent the flag itself.
 *
 * The proxy here loads a live template without the flag (the bundle's own,
 * minus that one flag), so the header it sends shows what dario adds. Hermetic:
 * the upstream is a fake via ProxyOptions.fetchImpl, in API-key mode.
 */

import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/free-port.mjs';

const ADVISOR_BETA = 'advisor-tool-2026-03-01';

// cc-template loads at import time, so the live cache must be in place first.
const DIR = join(tmpdir(), `dario-advisor-beta-test-${process.pid}`);
mkdirSync(DIR, { recursive: true });
process.env.DARIO_LIVE_TEMPLATE_CACHE = join(DIR, 'cc-template.live.json');
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* noop */ } });

const { CURRENT_SCHEMA_VERSION } = await import('../dist/live-fingerprint.js');
const bundle = JSON.parse(readFileSync(fileURLToPath(new URL('../dist/cc-template-data.json', import.meta.url)), 'utf8'));
const bundleFlags = bundle.anthropic_beta.split(',');
const live = {
  ...bundle,
  anthropic_beta: bundleFlags.filter((f) => f !== ADVISOR_BETA).join(','),
  _captured: new Date().toISOString(),
  _schemaVersion: CURRENT_SCHEMA_VERSION,
};
writeFileSync(process.env.DARIO_LIVE_TEMPLATE_CACHE, JSON.stringify(live));

const { startProxy, withAdvisorToolBeta, betaForModel } = await import('../dist/proxy.js');
const { CC_TEMPLATE } = await import('../dist/cc-template.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` :: ${detail}` : ''}`); }
}
function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

const advisor = { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-5-5', max_tokens: 256 };
const schema = { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] };
const custom = (name) => ({ name, description: `the ${name} tool`, input_schema: schema });

header('the flag is added only for an advisor entry, where the bundle has it');
{
  // The set the #1812 retest named: a live template with no advisor flag.
  const OPUS = 'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,mid-conversation-tool-changes-2026-07-01,thinking-token-count-2026-05-13,advanced-tool-use-2025-11-20,effort-2025-11-24';
  check('after mid-conversation-tool-changes when inline-tools is absent',
    withAdvisorToolBeta(OPUS, [advisor]) === 'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,mid-conversation-tool-changes-2026-07-01,advisor-tool-2026-03-01,thinking-token-count-2026-05-13,advanced-tool-use-2025-11-20,effort-2025-11-24');
  const SONNET = betaForModel(OPUS, 'claude-sonnet-5-5');
  check('after context-management on a family that sends neither tool flag',
    withAdvisorToolBeta(SONNET, [advisor]) === 'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,advisor-tool-2026-03-01,thinking-token-count-2026-05-13,advanced-tool-use-2025-11-20,effort-2025-11-24');
  check('after inline-tools when it is there',
    withAdvisorToolBeta('claude-code-20250219,context-management-2025-06-27,mid-conversation-tool-changes-2026-07-01,inline-tools-2026-09-15,effort-2025-11-24', [advisor])
      === 'claude-code-20250219,context-management-2025-06-27,mid-conversation-tool-changes-2026-07-01,inline-tools-2026-09-15,advisor-tool-2026-03-01,effort-2025-11-24');
  check('at the end when no anchor is present',
    withAdvisorToolBeta('oauth-2025-04-20,effort-2025-11-24', [advisor]) === 'oauth-2025-04-20,effort-2025-11-24,advisor-tool-2026-03-01');
  check('the bundle order comes back when the bundle loses the flag',
    withAdvisorToolBeta(live.anthropic_beta, [advisor]) === bundle.anthropic_beta);
  check('already there: the header is returned as it was',
    withAdvisorToolBeta(bundle.anthropic_beta, [advisor]) === bundle.anthropic_beta);
  check('an entry beside custom tools counts',
    withAdvisorToolBeta(OPUS, [custom('get_time'), advisor]).includes(ADVISOR_BETA));
  check('a later dated type counts', withAdvisorToolBeta(OPUS, [{ ...advisor, type: 'advisor_20270115' }]).includes(ADVISOR_BETA));

  check('no tools: unchanged', withAdvisorToolBeta(OPUS, undefined) === OPUS && withAdvisorToolBeta(OPUS, []) === OPUS);
  check('a client tool named advisor with its own schema: unchanged', withAdvisorToolBeta(OPUS, [custom('advisor')]) === OPUS);
  check('another Anthropic-defined tool: unchanged', withAdvisorToolBeta(OPUS, [{ type: 'computer_20251124', name: 'computer' }]) === OPUS);
  check('a type that only starts like it: unchanged', withAdvisorToolBeta(OPUS, [{ type: 'advisor_tool', name: 'advisor' }]) === OPUS);
  check('entries that are not objects: unchanged', withAdvisorToolBeta(OPUS, [null, 'advisor_20260301', 7]) === OPUS);
}

header('through the proxy, on a template without the flag');
{
  check('the loaded template is the one without the flag',
    !String(CC_TEMPLATE.anthropic_beta).split(',').includes(ADVISOR_BETA), String(CC_TEMPLATE.anthropic_beta));

  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  let calls = [];
  const fakeFetch = async (url, init) => {
    const body = init?.body ? Buffer.from(init.body).toString('utf8') : '';
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* not JSON */ }
    // The header set is an array of [name, value] pairs in Claude Code's order.
    const raw = init?.headers ?? {};
    const entries = Array.isArray(raw) ? raw : Object.entries(raw);
    const beta = entries.find(([k]) => String(k).toLowerCase() === 'anthropic-beta')?.[1];
    calls.push({ url: String(url), beta: typeof beta === 'string' ? beta.split(',') : null, tools: parsed.tools });
    return new Response(JSON.stringify({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const send = (tools, extraHeaders = {}) => fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'dario', ...extraHeaders },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 64, ...(tools ? { tools } : {}), messages: [{ role: 'user', content: 'hi' }] }),
  });
  const messages = () => calls.filter((c) => c.url.includes('/v1/messages'));

  await startProxy({
    port: PORT,
    host: '127.0.0.1',
    upstreamApiKey: 'sk-ant-test-not-a-real-key',
    noClaudeAuth: true,
    fetchImpl: fakeFetch,
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  calls = [];
  let res = await send([custom('get_time')]);
  let sent = messages()[0];
  check('no advisor entry: 200', res.status === 200, `got ${res.status}`);
  check('no advisor entry: the header was read', Array.isArray(sent?.beta) && sent.beta.includes('claude-code-20250219'), JSON.stringify(sent?.beta));
  check('no advisor entry: the flag is not sent', Array.isArray(sent?.beta) && !sent.beta.includes(ADVISOR_BETA), JSON.stringify(sent?.beta));

  calls = [];
  res = await send([advisor]);
  sent = messages()[0];
  check('advisor entry: 200', res.status === 200, `got ${res.status}`);
  check('advisor entry: it went out as declared', JSON.stringify(sent?.tools?.find((t) => t.name === 'advisor')) === JSON.stringify(advisor), JSON.stringify(sent?.tools));
  check('advisor entry: the flag is sent, once', sent?.beta?.filter((f) => f === ADVISOR_BETA).length === 1, JSON.stringify(sent?.beta));
  check('advisor entry: right after context-management, as Claude Code orders it on this model',
    sent?.beta?.[sent.beta.indexOf('context-management-2025-06-27') + 1] === ADVISOR_BETA, JSON.stringify(sent?.beta));

  calls = [];
  res = await send([advisor, custom('get_time')], { 'anthropic-beta': ADVISOR_BETA });
  sent = messages()[0];
  check('the client sends the flag too: still once, in the same place',
    sent?.beta?.filter((f) => f === ADVISOR_BETA).length === 1
      && sent.beta[sent.beta.indexOf('context-management-2025-06-27') + 1] === ADVISOR_BETA, JSON.stringify(sent?.beta));
}

console.log(`\nadvisor-tool-beta: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
