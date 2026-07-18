#!/usr/bin/env node
/**
 * test/pool-fallback.mjs
 *
 * Pool-exhausted fallback body rewrite + config wiring. The dispatch paths
 * that USE buildPoolFallbackBody are exercised end-to-end by the live e2e
 * harness; here we cover the pure pieces without a proxy:
 *
 *   - buildPoolFallbackBody: swaps model, preserves other fields, returns
 *     null on non-object / non-JSON bodies (so the caller surfaces the
 *     original error instead of forwarding garbage)
 *   - config sanitize: poolFallback.model round-trips, null preserved,
 *     wrong-typed value dropped, absent defaults to null
 *
 * Runs in-process. No proxy, no OAuth, no network.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPoolFallbackBody } from '../dist/proxy.js';
import { loadConfig } from '../dist/config-file.js';

let pass = 0;
let fail = 0;

function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}

function header(name) {
  console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`);
}

header('buildPoolFallbackBody');
{
  const src = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    temperature: 0.7,
  }));
  const out = buildPoolFallbackBody(src, 'openrouter/anthropic/claude-3.5-sonnet');
  check('returns a Buffer', Buffer.isBuffer(out));
  const parsed = JSON.parse(out.toString());
  check('model is swapped', parsed.model === 'openrouter/anthropic/claude-3.5-sonnet');
  check('messages preserved', parsed.messages[0].content === 'hi');
  check('stream flag preserved', parsed.stream === true);
  check('other fields preserved', parsed.temperature === 0.7);

  check('non-JSON body returns null', buildPoolFallbackBody(Buffer.from('not json'), 'x') === null);
  check('JSON array returns null', buildPoolFallbackBody(Buffer.from('[1,2,3]'), 'x') === null);
  check('JSON null returns null', buildPoolFallbackBody(Buffer.from('null'), 'x') === null);
  check('JSON string returns null', buildPoolFallbackBody(Buffer.from('"a string"'), 'x') === null);
  check('empty body returns null', buildPoolFallbackBody(Buffer.from(''), 'x') === null);
}

header('config-file sanitize — poolFallback');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-fallback-test-'));
  const path = join(dir, 'config.json');
  try {
    writeFileSync(path, JSON.stringify({ version: 1, poolFallback: { model: 'gpt-4o-mini' } }));
    check('model round-trips', loadConfig(path).config.poolFallback?.model === 'gpt-4o-mini');

    writeFileSync(path, JSON.stringify({ version: 1, poolFallback: { model: null } }));
    check('null model preserved', loadConfig(path).config.poolFallback?.model === null);

    writeFileSync(path, JSON.stringify({ version: 1, poolFallback: { model: 42 } }));
    check('wrong-typed model dropped (defaults null)', loadConfig(path).config.poolFallback?.model === null);

    writeFileSync(path, JSON.stringify({ version: 1 }));
    check('absent poolFallback defaults to null model', loadConfig(path).config.poolFallback?.model === null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);
