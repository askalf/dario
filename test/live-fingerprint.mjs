// Test for live fingerprint extraction (v3.11.0 — #2 from the "get ahead
// of Anthropic" plan).
//
// We don't spawn a real CC here — that's the e2e test's job. Instead we
// exercise extractTemplate() against a synthetic CC-shaped request to
// verify the extractor correctly pulls agent identity, system prompt,
// tools, and version from a captured body. And we exercise loadTemplate()
// against cache files we write by hand to verify the sync path's
// fallback order (live cache > bundled).

import { _extractTemplateForTest, loadTemplate, CURRENT_SCHEMA_VERSION } from '../dist/live-fingerprint.js';
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

const LIVE_CACHE = join(homedir(), '.dario', 'cc-template.live.json');
const BACKUP = LIVE_CACHE + '.test-backup';

// Back up any existing live cache so we don't clobber the user's real fingerprint.
if (existsSync(LIVE_CACHE)) {
  const { readFileSync } = await import('node:fs');
  writeFileSync(BACKUP, readFileSync(LIVE_CACHE, 'utf-8'));
}

function restoreCache() {
  try {
    if (existsSync(BACKUP)) {
      const { readFileSync } = require('node:fs');
      writeFileSync(LIVE_CACHE, readFileSync(BACKUP, 'utf-8'));
      rmSync(BACKUP);
    } else {
      if (existsSync(LIVE_CACHE)) rmSync(LIVE_CACHE);
    }
  } catch { /* noop */ }
}

process.on('exit', restoreCache);

// ======================================================================
//  extractTemplate — happy path
// ======================================================================
header('extractTemplate — pulls agent identity, system prompt, tools, version');
{
  const captured = {
    method: 'POST',
    path: '/v1/messages',
    headers: {
      'x-anthropic-billing-header': 'cc_version=2.1.200; cc_entrypoint=sdk-cli; cch=abc12',
      'user-agent': 'claude-cli/2.1.200 (external)',
      'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
    },
    body: {
      model: 'claude-opus-4-5',
      max_tokens: 32000,
      system: [
        { type: 'text', text: 'billing tag payload' },
        { type: 'text', text: 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Large system prompt content here, normally ~25KB. Contains tool-use instructions.', cache_control: { type: 'ephemeral' } },
      ],
      tools: [
        { name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } },
        { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
        { name: 'Edit', description: 'Edit a file', input_schema: { type: 'object', properties: {} } },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    },
  };

  const template = _extractTemplateForTest(captured);
  check('extraction returned non-null', template !== null);
  check('version extracted from billing header', template?._version === '2.1.200');
  check('source marked as live', template?._source === 'live');
  check('agent identity pulled from system[1]', template?.agent_identity.includes('Claude Agent SDK'));
  check('system prompt pulled from system[2]', template?.system_prompt.includes('tool-use instructions'));
  check('3 tools captured', template?.tools.length === 3);
  check('tool_names matches', JSON.stringify(template?.tool_names) === JSON.stringify(['Bash', 'Read', 'Edit']));
  check('billing tag NOT stored (system[0] dropped)', !template?.system_prompt.includes('billing tag payload') && !template?.agent_identity.includes('billing tag payload'));
}

// ======================================================================
//  extractTemplate — version from user-agent when billing header missing
// ======================================================================
header('extractTemplate — user-agent fallback for version');
{
  const captured = {
    method: 'POST',
    path: '/v1/messages',
    headers: {
      'user-agent': 'claude-cli/2.1.201 (internal build)',
    },
    body: {
      system: [
        { type: 'text', text: 'tag' },
        { type: 'text', text: 'agent identity' },
        { type: 'text', text: 'system prompt' },
      ],
      tools: [{ name: 'Bash', description: '', input_schema: {} }],
    },
  };
  const template = _extractTemplateForTest(captured);
  check('version from user-agent', template?._version === '2.1.201');
}

// ======================================================================
//  extractTemplate — rejects malformed requests
// ======================================================================
header('extractTemplate — returns null on malformed request bodies');
{
  // Missing system blocks
  const r1 = _extractTemplateForTest({ method: 'POST', path: '/v1/messages', headers: {}, body: { messages: [] } });
  check('null on missing system', r1 === null);

  // System too short
  const r2 = _extractTemplateForTest({ method: 'POST', path: '/v1/messages', headers: {}, body: { system: [{ type: 'text', text: 'only' }] } });
  check('null on short system (< 2 blocks)', r2 === null);

  // No tools
  const r3 = _extractTemplateForTest({
    method: 'POST', path: '/v1/messages', headers: {},
    body: {
      system: [
        { type: 'text', text: 'tag' },
        { type: 'text', text: 'agent' },
        { type: 'text', text: 'prompt' },
      ],
      tools: [],
    },
  });
  check('null on empty tools array', r3 === null);

  // Non-text blocks
  const r4 = _extractTemplateForTest({
    method: 'POST', path: '/v1/messages', headers: {},
    body: {
      system: [
        { type: 'image', source: {} },
        { type: 'text', text: 'agent' },
        { type: 'text', text: 'prompt' },
      ],
      tools: [{ name: 'Bash', description: '', input_schema: {} }],
    },
  });
  // system[0] is non-text but we don't use it — agent/prompt are still text, so this should succeed.
  check('non-text block[0] is ignored (it\'s the billing tag slot we discard)', r4 !== null);
}

// ======================================================================
//  extractTemplate — captures header order from rawHeaders (v3.13, option 2)
// ======================================================================
header('extractTemplate — header_order captured from rawHeaders');
{
  // rawHeaders is Node's flat [k1, v1, k2, v2, ...] representation. Node
  // preserves insertion order here, so we can recover CC's exact header
  // order from the capture without relying on flattened key/value maps.
  const captured = {
    method: 'POST',
    path: '/v1/messages',
    headers: {
      'host': 'api.anthropic.com',
      'user-agent': 'claude-cli/2.1.300 (external, cli)',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'authorization': 'Bearer redacted',
    },
    rawHeaders: [
      'Host', 'api.anthropic.com',
      'User-Agent', 'claude-cli/2.1.300 (external, cli)',
      'Content-Type', 'application/json',
      'anthropic-version', '2023-06-01',
      'Authorization', 'Bearer redacted',
      // Duplicate header should be de-duped, preserving first occurrence.
      'User-Agent', 'this second value gets dropped',
    ],
    body: {
      system: [
        { type: 'text', text: 'tag' },
        { type: 'text', text: 'agent identity' },
        { type: 'text', text: 'system prompt body' },
      ],
      tools: [{ name: 'Bash', description: '', input_schema: {} }],
    },
  };

  const t = _extractTemplateForTest(captured);
  check('header_order captured', Array.isArray(t?.header_order));
  check('header_order has 5 entries (dup dropped)', t?.header_order?.length === 5);
  check('header_order[0] = host', t?.header_order?.[0] === 'host');
  check('header_order[1] = user-agent', t?.header_order?.[1] === 'user-agent');
  check('header_order[2] = content-type', t?.header_order?.[2] === 'content-type');
  check('header_order preserves exact insertion sequence',
    JSON.stringify(t?.header_order) ===
    JSON.stringify(['host', 'user-agent', 'content-type', 'anthropic-version', 'authorization']));
}

header('extractTemplate — header_order omitted when rawHeaders missing');
{
  // Old synthetic captures (and the existing test fixtures above) don't
  // pass rawHeaders at all. header_order should be undefined in that case
  // so the outbound paths fall through to default ordering.
  const captured = {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'user-agent': 'claude-cli/2.1.300' },
    rawHeaders: [],
    body: {
      system: [
        { type: 'text', text: 'tag' },
        { type: 'text', text: 'agent' },
        { type: 'text', text: 'prompt' },
      ],
      tools: [{ name: 'Bash', description: '', input_schema: {} }],
    },
  };
  const t = _extractTemplateForTest(captured);
  check('header_order undefined when rawHeaders empty', t?.header_order === undefined);
}

// ======================================================================
//  loadTemplate — prefers live cache when fresh
// ======================================================================
header('loadTemplate — reads fresh live cache in preference to bundled');
{
  // Write a fresh live cache file and verify loadTemplate reads it.
  mkdirSync(dirname(LIVE_CACHE), { recursive: true });
  const fakeLive = {
    _version: '99.99.99-live-test',
    _captured: new Date().toISOString(),
    _source: 'live',
    _schemaVersion: CURRENT_SCHEMA_VERSION,
    agent_identity: 'FAKE LIVE IDENTITY',
    system_prompt: 'FAKE LIVE SYSTEM PROMPT',
    tools: [{ name: 'Bash', description: '', input_schema: {} }],
    tool_names: ['Bash'],
  };
  writeFileSync(LIVE_CACHE, JSON.stringify(fakeLive));

  const loaded = loadTemplate({ silent: true });
  check('live cache used (version matches)', loaded._version === '99.99.99-live-test');
  check('live cache agent_identity used', loaded.agent_identity === 'FAKE LIVE IDENTITY');
  check('source marked live', loaded._source === 'live');
}

// ======================================================================
//  loadTemplate — rejects cache without _schemaVersion (pre-v3.17 shape)
// ======================================================================
header('loadTemplate — rejects cache with missing or mismatched _schemaVersion');
{
  mkdirSync(dirname(LIVE_CACHE), { recursive: true });

  // Missing _schemaVersion entirely (the pre-v3.17 on-disk shape)
  const preV317 = {
    _version: '99.99.99-pre-schema',
    _captured: new Date().toISOString(),
    _source: 'live',
    agent_identity: 'PRE-SCHEMA IDENTITY',
    system_prompt: 'PRE-SCHEMA PROMPT',
    tools: [{ name: 'Bash', description: '', input_schema: {} }],
    tool_names: ['Bash'],
  };
  writeFileSync(LIVE_CACHE, JSON.stringify(preV317));
  const loadedPre = loadTemplate({ silent: true });
  check('missing _schemaVersion rejected → falls back to bundled', loadedPre._version !== '99.99.99-pre-schema');
  check('bundled fallback has _source !== "live"', loadedPre._source !== 'live');

  // Future/mismatched _schemaVersion
  const futureSchema = { ...preV317, _version: '99.99.99-future', _schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
  writeFileSync(LIVE_CACHE, JSON.stringify(futureSchema));
  const loadedFuture = loadTemplate({ silent: true });
  check('future _schemaVersion rejected → falls back to bundled', loadedFuture._version !== '99.99.99-future');
}

// ======================================================================
//  loadTemplate — falls back to bundled when no cache
// ======================================================================
header('loadTemplate — falls back to bundled when no live cache');
{
  rmSync(LIVE_CACHE, { force: true });
  const loaded = loadTemplate({ silent: true });
  check('bundled snapshot loaded', loaded._source === 'bundled' || loaded._source === undefined);
  check('bundled has agent_identity', typeof loaded.agent_identity === 'string' && loaded.agent_identity.length > 0);
  check('bundled has system_prompt', typeof loaded.system_prompt === 'string' && loaded.system_prompt.length > 0);
  check('bundled has tools', Array.isArray(loaded.tools) && loaded.tools.length > 0);
}

// ======================================================================
//  readLiveCache — corruption recovery (quarantine + fallback)
// ======================================================================
import { readdirSync } from 'node:fs';
const cacheDir = dirname(LIVE_CACHE);

function clearQuarantineFiles() {
  if (!existsSync(cacheDir)) return;
  for (const name of readdirSync(cacheDir)) {
    if (name.startsWith('cc-template.live.json.corrupt-')) {
      rmSync(join(cacheDir, name), { force: true });
    }
  }
}
function quarantineCount() {
  if (!existsSync(cacheDir)) return 0;
  return readdirSync(cacheDir).filter((n) => n.startsWith('cc-template.live.json.corrupt-')).length;
}

// Silence expected stderr warnings from the quarantine path so the
// test's pass/fail output stays clean. Restore at the end of the section.
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = () => true;

header('readLiveCache — unparseable JSON is quarantined, cache falls back to bundled');
{
  clearQuarantineFiles();
  rmSync(LIVE_CACHE, { force: true });
  mkdirSync(cacheDir, { recursive: true });
  const corruptBody = '{"_version":"X","_captured":"2026-04-16","_schemaVersion":1,"tools":[{"name":"Bash"'; // truncated
  writeFileSync(LIVE_CACHE, corruptBody);

  const loaded = loadTemplate({ silent: true });
  check('corrupt cache → bundled fallback', loaded._source === 'bundled' || loaded._source === undefined);
  check('original corrupt file removed from primary path', !existsSync(LIVE_CACHE));
  check('exactly one quarantine file created', quarantineCount() === 1);

  const quarantines = readdirSync(cacheDir).filter((n) => n.startsWith('cc-template.live.json.corrupt-'));
  const quarantinedBody = readFileSync(join(cacheDir, quarantines[0]), 'utf-8');
  check('quarantined file preserves original bytes', quarantinedBody === corruptBody);
  clearQuarantineFiles();
}

header('readLiveCache — missing required fields are quarantined');
{
  clearQuarantineFiles();
  rmSync(LIVE_CACHE, { force: true });
  mkdirSync(cacheDir, { recursive: true });
  // Valid JSON, schema version present, but `tools` is empty → required-fields reject.
  const incomplete = {
    _version: '2.1.104',
    _captured: new Date().toISOString(),
    _schemaVersion: CURRENT_SCHEMA_VERSION,
    agent_identity: 'stub',
    system_prompt: 'stub',
    tools: [],
    tool_names: [],
  };
  writeFileSync(LIVE_CACHE, JSON.stringify(incomplete));

  const loaded = loadTemplate({ silent: true });
  check('required-fields miss → bundled fallback', loaded._source === 'bundled' || loaded._source === undefined);
  check('quarantine file created', quarantineCount() === 1);
  clearQuarantineFiles();
}

header('readLiveCache — schema mismatch does NOT quarantine (expected version-transition)');
{
  clearQuarantineFiles();
  rmSync(LIVE_CACHE, { force: true });
  mkdirSync(cacheDir, { recursive: true });
  const futureSchema = {
    _version: '2.1.104',
    _captured: new Date().toISOString(),
    _schemaVersion: CURRENT_SCHEMA_VERSION + 1, // future dario wrote this
    agent_identity: 'stub',
    system_prompt: 'stub',
    tools: [{ name: 'Bash', description: '', input_schema: {} }],
    tool_names: ['Bash'],
  };
  writeFileSync(LIVE_CACHE, JSON.stringify(futureSchema));

  const loaded = loadTemplate({ silent: true });
  check('schema mismatch → bundled fallback', loaded._source === 'bundled' || loaded._source === undefined);
  check('original file left in place (not quarantined)', existsSync(LIVE_CACHE));
  check('no quarantine files created', quarantineCount() === 0);
  rmSync(LIVE_CACHE, { force: true });
}

// Restore stderr so the final summary prints normally.
process.stderr.write = originalStderrWrite;

// ======================================================================
//  Schema v3 (v3.22) — anthropic_beta + header_values + body_field_order
// ======================================================================
header('extractTemplate — anthropic_beta + header_values + body_field_order (schema v3)');
{
  const captured = {
    method: 'POST',
    path: '/v1/messages',
    headers: {
      'user-agent': 'claude-cli/2.1.104 (external, cli)',
      'x-anthropic-billing-header': 'cc_version=2.1.104; cch=abc',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07',
      'anthropic-version': '2023-06-01',
      'x-app': 'cli',
      'x-stainless-arch': 'x64',
      'x-stainless-lang': 'js',
      'x-stainless-os': 'Linux',
      'x-stainless-package-version': '0.81.0',
      'x-stainless-retry-count': '0',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v24.3.0',
      'authorization': 'Bearer SECRET',
      'content-type': 'application/json',
      'content-length': '512',
      'host': 'api.anthropic.com',
      'x-claude-code-session-id': 'session-abc',
      'x-client-request-id': 'rid-xyz',
      // x-api-key is the capture-env placeholder that dario's fingerprint
      // spawn sets (ANTHROPIC_API_KEY=sk-dario-fingerprint-capture). It must
      // never land in the stored template — see dario#42.
      'x-api-key': 'sk-dario-fingerprint-capture',
    },
    rawHeaders: [
      'host', 'api.anthropic.com',
      'user-agent', 'claude-cli/2.1.104 (external, cli)',
      'anthropic-version', '2023-06-01',
      'anthropic-beta', 'claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07',
    ],
    body: {
      system: [
        { type: 'text', text: 'billing tag' },
        { type: 'text', text: 'You are Claude Code, Anthropic\'s official CLI for Claude.' },
        { type: 'text', text: 'system prompt body with enough content to look real' },
      ],
      tools: [{ name: 'Bash', description: '', input_schema: {} }],
    },
  };
  const t = _extractTemplateForTest(captured);
  check('_schemaVersion === 3', t?._schemaVersion === 3);
  check('body_field_order is an array',
    Array.isArray(t?.body_field_order));
  check('body_field_order captures top-level keys in insertion order',
    JSON.stringify(t?.body_field_order) === JSON.stringify(['system', 'tools']));
  check('anthropic_beta captured verbatim',
    t?.anthropic_beta === 'claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07');
  check('header_values is an object', typeof t?.header_values === 'object' && t?.header_values !== null);
  check('header_values contains user-agent', t?.header_values?.['user-agent'] === 'claude-cli/2.1.104 (external, cli)');
  check('header_values contains x-app', t?.header_values?.['x-app'] === 'cli');
  check('header_values contains x-stainless-package-version',
    t?.header_values?.['x-stainless-package-version'] === '0.81.0');
  check('header_values excludes authorization', !('authorization' in (t?.header_values ?? {})));
  check('header_values excludes content-type', !('content-type' in (t?.header_values ?? {})));
  check('header_values excludes content-length', !('content-length' in (t?.header_values ?? {})));
  check('header_values excludes host', !('host' in (t?.header_values ?? {})));
  check('header_values excludes anthropic-beta (captured separately)',
    !('anthropic-beta' in (t?.header_values ?? {})));
  check('header_values excludes x-anthropic-billing-header (per-request)',
    !('x-anthropic-billing-header' in (t?.header_values ?? {})));
  check('header_values excludes x-claude-code-session-id',
    !('x-claude-code-session-id' in (t?.header_values ?? {})));
  check('header_values excludes x-client-request-id',
    !('x-client-request-id' in (t?.header_values ?? {})));
  check('header_values excludes x-api-key (capture-env placeholder, dario#42)',
    !('x-api-key' in (t?.header_values ?? {})));
}

header('extractTemplate — omits anthropic_beta + header_values when absent');
{
  // Captured request with no anthropic-beta header — field should be undefined,
  // not an empty string. Header_values still fires for user-agent etc.
  const captured = {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'user-agent': 'claude-cli/2.1.104' },
    rawHeaders: [],
    body: {
      system: [
        { type: 'text', text: 'tag' },
        { type: 'text', text: 'agent' },
        { type: 'text', text: 'prompt' },
      ],
      tools: [{ name: 'Bash', description: '', input_schema: {} }],
    },
  };
  const t = _extractTemplateForTest(captured);
  check('anthropic_beta undefined when header missing', t?.anthropic_beta === undefined);
  check('header_values still captures user-agent',
    t?.header_values?.['user-agent'] === 'claude-cli/2.1.104');
}

// ======================================================================
//  Summary
// ======================================================================
restoreCache();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
