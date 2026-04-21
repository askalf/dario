#!/usr/bin/env node
// Hermes Agent compatibility tests — dario#88.
//
// Covers the two pieces that landed in v3.30.13:
//   1. detectTextToolClient returns 'hermes' on Hermes's canonical
//      system-prompt identity lines so buildCCRequest's auto-preserve-
//      tools path fires for Hermes sessions.
//   2. resolveMaxTokens + --max-tokens flag: the pin / client-passthrough
//      logic that keeps Hermes's 64k/128k per-model caps from being
//      silently truncated to dario's 32k default.

import {
  detectTextToolClient,
  buildCCRequest,
  resolveMaxTokens,
  DEFAULT_MAX_TOKENS,
} from '../dist/cc-template.js';
import { resolveMaxTokensFlag } from '../dist/cli.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// ─────────────────────────────────────────────────────────────
header('detectTextToolClient — Hermes Agent identity');
{
  const canonical = "You are Hermes Agent, an intelligent AI assistant created by Nous Research. You are helpful, knowledgeable, and direct.";
  check('canonical opener → "hermes"', detectTextToolClient(canonical) === 'hermes');

  const nousOnly = "The assistant is a coding agent created by Nous Research, operating within a CLI harness.";
  check('"created by Nous Research" alone → "hermes"', detectTextToolClient(nousOnly) === 'hermes');

  check('Cline prompt NOT matched as hermes',
    detectTextToolClient('You are Cline, an AI software engineer') === 'cline');

  check('generic prompt without Hermes markers → null',
    detectTextToolClient('You are Claude, an AI assistant from Anthropic') === null);
}

header('detectTextToolClient — Hermes detection survives prompt wrapping');
{
  // Hermes's actual opener is wrapped in a broader system prompt; make sure
  // surrounding context doesn't defeat the regex anchor.
  const wrapped = `Some user preamble goes here.

You are Hermes Agent, an intelligent AI assistant created by Nous Research. You are helpful, knowledgeable, and direct.

<env>cwd=/home/user</env>`;
  check('detects Hermes identity even when wrapped in surrounding context',
    detectTextToolClient(wrapped) === 'hermes');
}

// ─────────────────────────────────────────────────────────────
header('resolveMaxTokens — number pin paths');
{
  check('undefined → DEFAULT_MAX_TOKENS',
    resolveMaxTokens(undefined, {}) === DEFAULT_MAX_TOKENS);
  check('32000 → 32000', resolveMaxTokens(32000, {}) === 32000);
  check('128000 → 128000 (opus ceiling)', resolveMaxTokens(128000, {}) === 128000);
  check('1 → 1 (absurd but legal per-value)', resolveMaxTokens(1, {}) === 1);
}

header('resolveMaxTokens — client passthrough');
{
  check('client, no max_tokens in body → DEFAULT fallback',
    resolveMaxTokens('client', {}) === DEFAULT_MAX_TOKENS);
  check('client, body.max_tokens = 64000 (Hermes sonnet default) → 64000',
    resolveMaxTokens('client', { max_tokens: 64000 }) === 64000);
  check('client, body.max_tokens = 128000 (Hermes opus default) → 128000',
    resolveMaxTokens('client', { max_tokens: 128000 }) === 128000);
  check('client, non-numeric body value → DEFAULT fallback',
    resolveMaxTokens('client', { max_tokens: 'big' }) === DEFAULT_MAX_TOKENS);
  check('client, zero body value → DEFAULT fallback',
    resolveMaxTokens('client', { max_tokens: 0 }) === DEFAULT_MAX_TOKENS);
  check('client, negative body value → DEFAULT fallback',
    resolveMaxTokens('client', { max_tokens: -10 }) === DEFAULT_MAX_TOKENS);
  check('client, float body value → floored to integer',
    resolveMaxTokens('client', { max_tokens: 64000.9 }) === 64000);
}

// ─────────────────────────────────────────────────────────────
header('buildCCRequest — maxTokens option reaches outbound body');
{
  const identity = { deviceId: 'D', accountUuid: 'A', sessionId: 'S' };
  const cacheControl = { type: 'ephemeral' };
  const billingTag = 'billing';

  const def = buildCCRequest(
    { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], stream: false },
    billingTag, cacheControl, identity,
  ).body;
  check('default: max_tokens = 32000', def.max_tokens === 32000);

  const pinned = buildCCRequest(
    { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }], stream: false },
    billingTag, cacheControl, identity,
    { maxTokens: 128000 },
  ).body;
  check('pinned: max_tokens = 128000', pinned.max_tokens === 128000);

  const passthrough = buildCCRequest(
    { model: 'claude-sonnet-4-6', max_tokens: 64000, messages: [{ role: 'user', content: 'hi' }], stream: false },
    billingTag, cacheControl, identity,
    { maxTokens: 'client' },
  ).body;
  check('client-passthrough: 64000 flows through from body', passthrough.max_tokens === 64000);

  const passthroughNoneBody = buildCCRequest(
    { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], stream: false },
    billingTag, cacheControl, identity,
    { maxTokens: 'client' },
  ).body;
  check('client-passthrough with no body.max_tokens → DEFAULT fallback',
    passthroughNoneBody.max_tokens === DEFAULT_MAX_TOKENS);
}

// ─────────────────────────────────────────────────────────────
header('resolveMaxTokensFlag — CLI parsing');
{
  check('no flag, no env → undefined',
    resolveMaxTokensFlag([], undefined) === undefined);
  check('--max-tokens=64000 → 64000',
    resolveMaxTokensFlag(['--max-tokens=64000'], undefined) === 64000);
  check('--max-tokens=client → "client"',
    resolveMaxTokensFlag(['--max-tokens=client'], undefined) === 'client');
  check('--max-tokens=CLIENT (case) → "client"',
    resolveMaxTokensFlag(['--max-tokens=CLIENT'], undefined) === 'client');
  check('--max-tokens=  128000  (whitespace) → 128000',
    resolveMaxTokensFlag(['--max-tokens=  128000  '], undefined) === 128000);
  check('env DARIO_MAX_TOKENS=64000 → 64000',
    resolveMaxTokensFlag([], '64000') === 64000);
  check('env client → "client"',
    resolveMaxTokensFlag([], 'client') === 'client');
  check('flag wins over env',
    resolveMaxTokensFlag(['--max-tokens=32000'], '128000') === 32000);
  check('empty env → undefined',
    resolveMaxTokensFlag([], '') === undefined);
}

header('resolveMaxTokensFlag — invalid values exit non-zero');
{
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [
    '-e',
    `import('./dist/cli.js').then(({ resolveMaxTokensFlag }) => { resolveMaxTokensFlag(['--max-tokens=abc'], undefined); });`,
  ], { cwd: process.cwd(), encoding: 'utf-8', timeout: 5_000 });
  check('non-numeric, non-client value → non-zero exit', result.status !== 0);
  check('stderr names the "client" literal', /positive integer or the literal "client"/.test(result.stderr));
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
