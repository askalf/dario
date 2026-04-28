// Unit tests for src/mcp/tools.ts (v3.27, direction #4 — MCP server).
// Exercises buildToolRegistry with purely synthetic data sources — no
// filesystem, no OAuth, no network. Each dario subsystem the registry
// wraps already has its own test suite; these tests only verify the
// mapping: data source → formatted text content.

import { buildToolRegistry } from '../dist/mcp/tools.js';

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

/** Build a registry with every data source fully stubbed. Override per test. */
function stubs(overrides = {}) {
  const defaults = {
    doctor: async () => [],
    status: async () => ({ authenticated: false, status: 'none' }),
    accounts: async () => [],
    backends: async () => [],
    subagent: async () => ({
      installed: false, path: '/fake/.claude/agents/dario.md',
      fileVersion: null, current: false, agentsDirExists: false,
    }),
    fingerprint: async () => ({
      runtime: 'node', runtimeVersion: 'v22.0.0', status: 'diverged',
      detail: 'OpenSSL, not Bun', templateSource: 'bundled', templateSchema: 2,
    }),
    usage: async () => ({ mode: 'pool', reachable: false, port: 3456, detail: 'stubbed' }),
    darioVersion: () => '0.0.0-test',
  };
  return buildToolRegistry({ ...defaults, ...overrides });
}

// ======================================================================
//  Registry shape
// ======================================================================
header('Registry shape — seven read-only tools, no destructive names');
{
  const reg = stubs();
  const names = reg.map((t) => t.name);
  check('exposes exactly seven tools', reg.length === 7);
  check('includes doctor', names.includes('doctor'));
  check('includes status', names.includes('status'));
  check('includes accounts_list', names.includes('accounts_list'));
  check('includes backends_list', names.includes('backends_list'));
  check('includes subagent_status', names.includes('subagent_status'));
  check('includes fingerprint_info', names.includes('fingerprint_info'));
  check('includes usage', names.includes('usage'));
  // No mutation verbs leak through:
  const forbidden = ['login', 'logout', 'accounts_add', 'accounts_remove', 'backend_add', 'backend_remove', 'proxy_start', 'subagent_install', 'subagent_remove'];
  for (const n of forbidden) {
    check(`does NOT expose mutation: ${n}`, !names.includes(n));
  }
  for (const t of reg) {
    check(`${t.name}: description is a non-empty string`, typeof t.description === 'string' && t.description.length > 0);
    check(`${t.name}: inputSchema.type='object'`, t.inputSchema.type === 'object');
    check(`${t.name}: no required args (all zero-arg read-only)`, Array.isArray(t.inputSchema.required) && t.inputSchema.required.length === 0);
  }
}

// ======================================================================
//  doctor tool
// ======================================================================
header('doctor — formats checks into aligned prefixes + summary');
{
  const reg = stubs({
    doctor: async () => [
      { status: 'ok', label: 'Node', detail: 'v22.0.0' },
      { status: 'warn', label: 'CC binary', detail: 'v2.1.112 outside tested range' },
      { status: 'fail', label: 'OAuth', detail: 'expired, no refresh token' },
      { status: 'info', label: 'Platform', detail: 'darwin arm64' },
    ],
  });
  const tool = reg.find((t) => t.name === 'doctor');
  const r = await tool.handler({});
  const text = r.content[0].text;
  check('contains [ OK ] prefix', text.includes('[ OK ]'));
  check('contains [WARN] prefix', text.includes('[WARN]'));
  check('contains [FAIL] prefix', text.includes('[FAIL]'));
  check('contains [INFO] prefix', text.includes('[INFO]'));
  check('labels are padded consistently', /\[ OK \]  Node     /.test(text) || /\[ OK \]  Node  /.test(text));
  check('summary reports fail count', /1 fail/.test(text));
  check('summary reports warn count', /1 warn/.test(text));
  check('summary reports total', /4 checks/.test(text));
}

header('doctor — empty check list → friendly message, not crash');
{
  const reg = stubs({ doctor: async () => [] });
  const tool = reg.find((t) => t.name === 'doctor');
  const r = await tool.handler({});
  check('handles empty check list', r.content[0].text.includes('No checks'));
  check('not an error response', !r.isError);
}

// ======================================================================
//  status tool
// ======================================================================
header('status — authenticated path');
{
  const reg = stubs({ status: async () => ({ authenticated: true, status: 'valid', expiresIn: '4h 12m' }) });
  const tool = reg.find((t) => t.name === 'status');
  const r = await tool.handler({});
  check('reports Authenticated: yes', r.content[0].text.includes('Authenticated: yes'));
  check('includes status line', r.content[0].text.includes('valid'));
  check('includes expiry', r.content[0].text.includes('4h 12m'));
}

header('status — no credentials');
{
  const reg = stubs({ status: async () => ({ authenticated: false, status: 'none' }) });
  const r = await reg.find((t) => t.name === 'status').handler({});
  check('reports Authenticated: no', r.content[0].text.includes('Authenticated: no'));
  check('suggests `dario login`', r.content[0].text.includes('dario login'));
}

header('status — expired but refreshable');
{
  const reg = stubs({ status: async () => ({ authenticated: false, status: 'expired', canRefresh: true }) });
  const r = await reg.find((t) => t.name === 'status').handler({});
  check('mentions refreshable', /refresh/.test(r.content[0].text));
}

// ======================================================================
//  accounts_list tool
// ======================================================================
header('accounts_list — empty pool');
{
  const reg = stubs({ accounts: async () => [] });
  const r = await reg.find((t) => t.name === 'accounts_list').handler({});
  check('reports single-account mode', r.content[0].text.includes('single-account mode'));
}

header('accounts_list — single account (pool not active)');
{
  const now = Date.now();
  // +30s buffer so the floor(minutes) calculation inside the handler can't
  // round down across the test's own latency (e.g. 14m59.99s → "14m").
  const reg = stubs({ accounts: async () => [{ alias: 'personal', expiresAt: now + 3 * 3600_000 + 15 * 60_000 + 30_000 }] });
  const r = await reg.find((t) => t.name === 'accounts_list').handler({});
  check('reports 1 account (singular)', /1 account:/.test(r.content[0].text));
  check('includes alias', r.content[0].text.includes('personal'));
  check('includes expiry in hours+minutes', /3h 15m/.test(r.content[0].text));
  check('notes that pool mode needs 2+ accounts', /2\+ accounts/.test(r.content[0].text));
}

header('accounts_list — pool active (2+ accounts), no pool-mode note');
{
  const now = Date.now();
  const reg = stubs({
    accounts: async () => [
      { alias: 'work', expiresAt: now + 3600_000 },
      { alias: 'personal', expiresAt: now - 60_000 },
    ],
  });
  const r = await reg.find((t) => t.name === 'accounts_list').handler({});
  check('reports 2 accounts (plural)', /2 accounts:/.test(r.content[0].text));
  check('expired account marked as expired', r.content[0].text.includes('expired'));
  check('no pool-mode suggestion when already pooled', !r.content[0].text.includes('2+ accounts'));
}

// ======================================================================
//  backends_list tool
// ======================================================================
header('backends_list — empty');
{
  const reg = stubs({ backends: async () => [] });
  const r = await reg.find((t) => t.name === 'backends_list').handler({});
  check('reports no backends', /No OpenAI-compat backends/.test(r.content[0].text));
}

header('backends_list — populated, no API keys in output');
{
  const reg = stubs({
    backends: async () => [
      { name: 'openai', baseUrl: 'https://api.openai.com/v1' },
      { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b' },
    ],
  });
  const r = await reg.find((t) => t.name === 'backends_list').handler({});
  check('lists openai', r.content[0].text.includes('openai'));
  check('lists groq', r.content[0].text.includes('groq'));
  check('includes groq default model', r.content[0].text.includes('llama-3.3-70b'));
  // Defense in depth: the handler is given data without apiKey, but verify
  // that nothing that looks like a key accidentally leaks in formatting.
  check('no "sk-" prefix anywhere in output', !/sk-/.test(r.content[0].text));
  check('no "apiKey" label in output', !/apiKey/i.test(r.content[0].text));
}

// ======================================================================
//  subagent_status tool
// ======================================================================
header('subagent_status — not installed, no agents dir');
{
  const reg = stubs({
    subagent: async () => ({
      installed: false, path: '/home/u/.claude/agents/dario.md',
      fileVersion: null, current: false, agentsDirExists: false,
    }),
  });
  const r = await reg.find((t) => t.name === 'subagent_status').handler({});
  check('path reported', r.content[0].text.includes('/home/u/.claude/agents/dario.md'));
  check('agents dir: no', /~\/\.claude\/agents exists: no/.test(r.content[0].text));
  check('installed: no', r.content[0].text.includes('Installed: no'));
  check('no install hint when CC not installed', !r.content[0].text.includes('dario subagent install'));
}

header('subagent_status — installed and current');
{
  const reg = stubs({
    subagent: async () => ({
      installed: true, path: '/home/u/.claude/agents/dario.md',
      fileVersion: '3.27.0', current: true, agentsDirExists: true,
    }),
  });
  const r = await reg.find((t) => t.name === 'subagent_status').handler({});
  check('installed: yes (v3.27.0)', r.content[0].text.includes('Installed: yes (v3.27.0)'));
  check('no staleness note when current', !r.content[0].text.includes('does not match'));
}

header('subagent_status — installed but stale');
{
  const reg = stubs({
    subagent: async () => ({
      installed: true, path: '/home/u/.claude/agents/dario.md',
      fileVersion: '3.20.0', current: false, agentsDirExists: true,
    }),
  });
  const r = await reg.find((t) => t.name === 'subagent_status').handler({});
  check('mentions stale', r.content[0].text.includes('does not match'));
  check('suggests re-install', r.content[0].text.includes('dario subagent install'));
}

header('subagent_status — not installed but agents dir exists → install hint surfaces');
{
  const reg = stubs({
    subagent: async () => ({
      installed: false, path: '/home/u/.claude/agents/dario.md',
      fileVersion: null, current: false, agentsDirExists: true,
    }),
  });
  const r = await reg.find((t) => t.name === 'subagent_status').handler({});
  check('install hint shown', r.content[0].text.includes('Install with:'));
}

// ======================================================================
//  fingerprint_info tool
// ======================================================================
header('fingerprint_info — Bun runtime, live template');
{
  const reg = stubs({
    fingerprint: async () => ({
      runtime: 'bun', runtimeVersion: '1.1.0', status: 'match',
      detail: 'Bun BoringSSL matches CC', templateSource: 'live',
      templateSchema: 2,
    }),
    darioVersion: () => '3.27.0',
  });
  const r = await reg.find((t) => t.name === 'fingerprint_info').handler({});
  const text = r.content[0].text;
  check('reports bun runtime', text.includes('bun 1.1.0'));
  check('reports TLS status', text.includes('match'));
  check('reports TLS detail', text.includes('BoringSSL'));
  check('reports template source', /Template source:\s+live/.test(text));
  check('reports template schema v2', text.includes('v2'));
  check('reports dario version', text.includes('3.27.0'));
}

header('fingerprint_info — Node runtime, bundled template, null schema');
{
  const reg = stubs({
    fingerprint: async () => ({
      runtime: 'node', runtimeVersion: 'v22.0.0', status: 'diverged',
      detail: 'OpenSSL JA3 differs from CC', templateSource: 'bundled',
      templateSchema: null,
    }),
  });
  const r = await reg.find((t) => t.name === 'fingerprint_info').handler({});
  check('reports diverged', r.content[0].text.includes('diverged'));
  check('null schema rendered as v?', r.content[0].text.includes('v?'));
}

header('usage — proxy unreachable returns isError + actionable hint');
{
  const reg = stubs({
    usage: async () => ({ mode: 'pool', reachable: false, port: 3456, detail: 'fetch failed' }),
  });
  const r = await reg.find((t) => t.name === 'usage').handler({});
  check('isError set on unreachable', r.isError === true);
  check('mentions the port', r.content[0].text.includes('3456'));
  check('points at dario doctor --usage as substitute', r.content[0].text.includes('dario doctor --usage'));
}

header('usage — single-account mode notes analytics is pool-only');
{
  const reg = stubs({
    usage: async () => ({ mode: 'single-account', reachable: true, port: 3456 }),
  });
  const r = await reg.find((t) => t.name === 'usage').handler({});
  check('not isError when proxy is reachable', !r.isError);
  check('mentions single-account', r.content[0].text.includes('single-account'));
  check('explains analytics is pool-only', r.content[0].text.includes('pool mode'));
  check('points at dario doctor --usage', r.content[0].text.includes('dario doctor --usage'));
}

header('usage — pool mode with traffic renders the burn-rate digest');
{
  const reg = stubs({
    usage: async () => ({
      mode: 'pool', reachable: true, port: 3456,
      window: {
        minutes: 60, requests: 12,
        totalInputTokens: 18432, totalOutputTokens: 3210,
        avgLatencyMs: 1230, errorRate: 0,
        subscriptionPercent: 100, estimatedCost: 0.04,
      },
      perAccount: {
        primary: { requests: 9, subscriptionPercent: 100 },
        backup: { requests: 3, subscriptionPercent: 67 },
      },
    }),
  });
  const r = await reg.find((t) => t.name === 'usage').handler({});
  const text = r.content[0].text;
  check('renders Mode: pool', text.includes('Mode:    pool'));
  check('renders requests count', text.includes('Requests:        12'));
  check('renders input tokens with comma formatting', text.includes('18,432'));
  check('renders subscription %', text.includes('Subscription %:  100%'));
  check('renders estimated cost', text.includes('$0.0400'));
  check('renders per-account block', text.includes('primary') && text.includes('backup'));
  check('per-account shows request counts', text.includes('9 reqs') && text.includes('3 reqs'));
}

header('usage — pool mode with zero traffic skips the per-window stats');
{
  const reg = stubs({
    usage: async () => ({
      mode: 'pool', reachable: true, port: 3456,
      window: {
        minutes: 60, requests: 0,
        totalInputTokens: 0, totalOutputTokens: 0,
        avgLatencyMs: 0, errorRate: 0,
        subscriptionPercent: 0, estimatedCost: 0,
      },
    }),
  });
  const r = await reg.find((t) => t.name === 'usage').handler({});
  const text = r.content[0].text;
  check('still reports the window header', text.includes('Window:  last 60 minutes'));
  check('reports zero requests', text.includes('Requests:        0'));
  check('does NOT render token totals when no traffic', !text.includes('Input tokens'));
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);
