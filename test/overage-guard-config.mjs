/**
 * test/overage-guard-config.mjs
 *
 * Config schema tests for the overageGuard cluster (dario#288, v4.1).
 * Verifies:
 *   - defaults: defaultConfig() exposes the v4.1 shape
 *   - sanitize: hand-edited config.json with valid + invalid types
 *   - mergeOver: partial overageGuard overrides preserve siblings
 */

import { defaultConfig, mergeOver, saveConfig, loadConfig } from '../dist/config-file.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;

function assert(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else      { console.error(`  ❌ ${label}`); fail++; }
}

function assertEq(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✅ ${label}`); pass++; }
  else    { console.error(`  ❌ ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); fail++; }
}

// ── 1. defaults expose v4.1 shape ───────────────────────────────────

{
  console.log('defaultConfig: exposes v4.1 overageGuard shape');
  const d = defaultConfig();
  assert('has overageGuard sub-object', typeof d.overageGuard === 'object' && d.overageGuard !== null);
  assertEq('default enabled=true (halt by default protects users)', d.overageGuard.enabled, true);
  assertEq('default behavior=halt', d.overageGuard.behavior, 'halt');
  assertEq('default cooldownMs=30min', d.overageGuard.cooldownMs, 30 * 60 * 1000);
  assertEq('default notifyOs=true', d.overageGuard.notifyOs, true);
}

// ── 2. mergeOver preserves siblings on partial override ──────────────

{
  console.log('mergeOver: partial overageGuard override preserves siblings');
  const base = defaultConfig();
  const partial = { overageGuard: { behavior: 'warn' } };
  const merged = mergeOver(base, partial);
  assertEq('behavior was overridden', merged.overageGuard.behavior, 'warn');
  assertEq('enabled preserved from default', merged.overageGuard.enabled, true);
  assertEq('cooldownMs preserved from default', merged.overageGuard.cooldownMs, 30 * 60 * 1000);
  assertEq('notifyOs preserved from default', merged.overageGuard.notifyOs, true);
}

// ── 3. sanitize drops invalid types, accepts valid types ─────────────

{
  console.log('sanitize: drops invalid types, accepts valid types');
  const dir = mkdtempSync(join(tmpdir(), 'dario-overage-cfg-'));
  const path = join(dir, 'config.json');
  try {
    // Write a config with a mix of valid + invalid types
    saveConfig(path, {
      version: 1,
      overageGuard: {
        enabled: 'yes',          // invalid type — should be dropped
        behavior: 'halt',        // valid
        cooldownMs: 60_000,      // valid
        notifyOs: false,         // valid
      },
    });
    const loaded = loadConfig(path);
    // mergeOver fills the default for enabled (since the invalid value was dropped)
    assertEq('invalid enabled dropped, falls back to default true', loaded.config.overageGuard.enabled, true);
    assertEq('valid behavior preserved', loaded.config.overageGuard.behavior, 'halt');
    assertEq('valid cooldownMs preserved', loaded.config.overageGuard.cooldownMs, 60_000);
    assertEq('valid notifyOs preserved', loaded.config.overageGuard.notifyOs, false);

    // Now write a config with an invalid behavior enum value
    saveConfig(path, {
      version: 1,
      overageGuard: {
        behavior: 'nuke-everything',   // invalid enum value
      },
    });
    const loaded2 = loadConfig(path);
    assertEq('invalid behavior enum dropped, falls back to default halt', loaded2.config.overageGuard.behavior, 'halt');

    // Negative cooldownMs is invalid
    saveConfig(path, {
      version: 1,
      overageGuard: {
        cooldownMs: -1,
      },
    });
    const loaded3 = loadConfig(path);
    assertEq('negative cooldownMs dropped', loaded3.config.overageGuard.cooldownMs, 30 * 60 * 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
