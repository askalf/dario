#!/usr/bin/env node
/**
 * test/model-aliases.mjs
 *
 * User-defined model aliases: client-visible name → target model, applied
 * at request time before provider-prefix parsing so a target may carry a
 * prefix (`my-fast` → `openai:gpt-4o-mini`) and retarget the backend.
 *
 * Covers:
 *   - parseModelAliasSpecs: valid specs, invalid shapes skipped, key
 *     lowercasing, whitespace trim, last-wins on duplicates, targets with
 *     '=' in them survive (split on FIRST '=')
 *   - applyModelAlias: hit, miss, case-insensitive + trimmed lookup,
 *     self-mapping returns null, empty/undefined map returns null
 *   - composition with parseProviderPrefix: an alias target carrying a
 *     provider prefix parses into a forced provider
 *   - config-file sanitize: modelAliases round-trips, non-string values
 *     dropped, keys lowercased
 *
 * Runs in-process. No proxy, no OAuth, no network.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseModelAliasSpecs, applyModelAlias, parseProviderPrefix } from '../dist/proxy.js';
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

header('parseModelAliasSpecs');
{
  const parsed = parseModelAliasSpecs(['my-fast=openai:gpt-4o-mini', 'BIG=claude-opus-4-8']);
  check('valid specs parse', parsed['my-fast'] === 'openai:gpt-4o-mini');
  check('alias names are lowercased', parsed['big'] === 'claude-opus-4-8');
  check('no stray keys', Object.keys(parsed).length === 2);

  const junk = parseModelAliasSpecs(['no-equals', '=no-name', 'no-target=', '  =  ', '']);
  check('invalid shapes are skipped', Object.keys(junk).length === 0);

  const dupes = parseModelAliasSpecs(['a=first', 'a=second']);
  check('duplicate keys: last wins', dupes['a'] === 'second');

  const trimmed = parseModelAliasSpecs(['  Spaced  =  target-id  ']);
  check('whitespace trimmed on both sides', trimmed['spaced'] === 'target-id');

  const eq = parseModelAliasSpecs(['weird=target=with=equals']);
  check("split on FIRST '=' only", eq['weird'] === 'target=with=equals');
}

header('applyModelAlias');
{
  const aliases = { 'my-fast': 'openai:gpt-4o-mini', 'opus': 'claude-haiku-4-5' };
  check('exact hit resolves', applyModelAlias('my-fast', aliases) === 'openai:gpt-4o-mini');
  check('lookup is case-insensitive', applyModelAlias('My-Fast', aliases) === 'openai:gpt-4o-mini');
  check('lookup trims whitespace', applyModelAlias('  my-fast ', aliases) === 'openai:gpt-4o-mini');
  check('miss returns null', applyModelAlias('claude-opus-4-8', aliases) === null);
  check('built-in shortcut can be shadowed', applyModelAlias('opus', aliases) === 'claude-haiku-4-5');
  check('empty model returns null', applyModelAlias('', aliases) === null);
  check('undefined map returns null', applyModelAlias('my-fast', undefined) === null);
  check('self-mapping returns null (no loop)', applyModelAlias('same', { same: 'same' }) === null);
}

header('composition with provider prefixes');
{
  const aliases = parseModelAliasSpecs(['my-fast=openai:gpt-4o-mini', 'cheap=claude:haiku']);
  const t1 = applyModelAlias('my-fast', aliases);
  const p1 = parseProviderPrefix(t1);
  check('openai-prefixed target forces openai', p1?.provider === 'openai' && p1?.model === 'gpt-4o-mini');
  const t2 = applyModelAlias('cheap', aliases);
  const p2 = parseProviderPrefix(t2);
  check('claude-prefixed target forces claude', p2?.provider === 'claude' && p2?.model === 'haiku');
}

header('config-file sanitize');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-alias-test-'));
  const path = join(dir, 'config.json');
  try {
    writeFileSync(path, JSON.stringify({
      version: 1,
      modelAliases: {
        'My-Fast': 'openai:gpt-4o-mini',
        'bad-number': 42,
        '': 'dropped-empty-name',
        'no-target': '   ',
      },
    }));
    const { config, source } = loadConfig(path);
    check('file loads', source === 'file');
    check('keys lowercased through sanitize', config.modelAliases?.['my-fast'] === 'openai:gpt-4o-mini');
    check('non-string values dropped', !('bad-number' in (config.modelAliases ?? {})));
    check('empty names/targets dropped', Object.keys(config.modelAliases ?? {}).length === 1);

    writeFileSync(path, JSON.stringify({ version: 1 }));
    const absent = loadConfig(path);
    check('absent key defaults to empty map', Object.keys(absent.config.modelAliases ?? {}).length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${'='.repeat(70)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(70)}`);
process.exit(fail > 0 ? 1 : 0);
