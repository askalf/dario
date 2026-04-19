/**
 * E2E test — runs the detector against the real CC binary and prints proof.
 *
 * What this verifies:
 *   1. Detector finds claude binary on disk
 *   2. Detector lands on the PROD OAuth config block (not the dead-code
 *      `-local-oauth` dev block)
 *   3. Detected client_id is the prod UUID and is NOT the dead-code dev UUID
 *   4. All four OAuth primitives (client_id, authorize URL, token URL,
 *      scopes) are extracted correctly
 *   5. Cache persists across calls
 *
 * Background: CC ships three OAuth config factories (`local`, `staging`,
 * `prod`) in one binary, selected at runtime by a function that is
 * hardcoded to `prod` in every shipped build. The `-local-oauth` block
 * with CLIENT_ID `22422756-…` is dead code for internal Anthropic dev
 * stack use only — it's never reached at runtime. The live block is the
 * prod factory `nh$` with CLIENT_ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e`.
 *
 * See CHANGELOG v3.4.3 for the full story of why this test was previously
 * asserting the wrong UUID.
 */

import { detectCCOAuthConfig, _resetDetectorCache } from '../dist/cc-oauth-detect.js';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const CACHE_PATH = join(homedir(), '.dario', 'cc-oauth-cache-v4.json');
const PROD_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEAD_DEV_CLIENT_ID = '22422756-60c9-4084-8eb7-27705fd5cf9a';
const OVERRIDE_CLIENT_ID = '11111111-2222-4333-8444-555555555555';
const OVERRIDE_AUTHORIZE_URL = 'https://override.example.test/cai/oauth/authorize';
const NON_HTTPS_AUTHORIZE_URL = 'http://override.example.test/cai/oauth/authorize';
const NON_HTTPS_TOKEN_URL = 'http://override.example.test/v1/oauth/token';

function captureOverrideEnv() {
  return {
    previousDisable: process.env.DARIO_OAUTH_DISABLE_OVERRIDE,
    previousOverridePath: process.env.DARIO_OAUTH_OVERRIDE_PATH,
    previousOverrideClientId: process.env.DARIO_OAUTH_CLIENT_ID,
    previousOverrideAuthorizeUrl: process.env.DARIO_OAUTH_AUTHORIZE_URL,
    previousOverrideTokenUrl: process.env.DARIO_OAUTH_TOKEN_URL,
    previousOverrideScopes: process.env.DARIO_OAUTH_SCOPES,
  };
}

function restoreOverrideEnv(saved) {
  if (saved.previousDisable === undefined) delete process.env.DARIO_OAUTH_DISABLE_OVERRIDE;
  else process.env.DARIO_OAUTH_DISABLE_OVERRIDE = saved.previousDisable;
  if (saved.previousOverridePath === undefined) delete process.env.DARIO_OAUTH_OVERRIDE_PATH;
  else process.env.DARIO_OAUTH_OVERRIDE_PATH = saved.previousOverridePath;
  if (saved.previousOverrideClientId === undefined) delete process.env.DARIO_OAUTH_CLIENT_ID;
  else process.env.DARIO_OAUTH_CLIENT_ID = saved.previousOverrideClientId;
  if (saved.previousOverrideAuthorizeUrl === undefined) delete process.env.DARIO_OAUTH_AUTHORIZE_URL;
  else process.env.DARIO_OAUTH_AUTHORIZE_URL = saved.previousOverrideAuthorizeUrl;
  if (saved.previousOverrideTokenUrl === undefined) delete process.env.DARIO_OAUTH_TOKEN_URL;
  else process.env.DARIO_OAUTH_TOKEN_URL = saved.previousOverrideTokenUrl;
  if (saved.previousOverrideScopes === undefined) delete process.env.DARIO_OAUTH_SCOPES;
  else process.env.DARIO_OAUTH_SCOPES = saved.previousOverrideScopes;
}

function clearOverrideEnv() {
  process.env.DARIO_OAUTH_DISABLE_OVERRIDE = '0';
  delete process.env.DARIO_OAUTH_OVERRIDE_PATH;
  delete process.env.DARIO_OAUTH_CLIENT_ID;
  delete process.env.DARIO_OAUTH_AUTHORIZE_URL;
  delete process.env.DARIO_OAUTH_TOKEN_URL;
  delete process.env.DARIO_OAUTH_SCOPES;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DARIO — CC OAuth AUTO-DETECTOR E2E TEST');
  console.log('═══════════════════════════════════════════════════════════\n');

  const savedEnv = captureOverrideEnv();
  const overridePath = join(tmpdir(), `dario-oauth-override-${process.pid}.json`);

  try {
    // Clean slate. Force pure auto-detection for the baseline checks so a
    // local operator override file cannot make this test flaky.
    process.env.DARIO_OAUTH_DISABLE_OVERRIDE = '1';
    delete process.env.DARIO_OAUTH_OVERRIDE_PATH;
    delete process.env.DARIO_OAUTH_CLIENT_ID;
    delete process.env.DARIO_OAUTH_AUTHORIZE_URL;
    delete process.env.DARIO_OAUTH_TOKEN_URL;
    delete process.env.DARIO_OAUTH_SCOPES;

    try { await unlink(CACHE_PATH); } catch {}
    _resetDetectorCache();

    console.log('→ Running detector (cold start, no cache)...\n');
    const t0 = Date.now();
    const cfg1 = await detectCCOAuthConfig();
    const t1 = Date.now();
    console.log(`  Took ${t1 - t0}ms\n`);

  console.log('─── Detected config ───');
  console.log(`  source:        ${cfg1.source}`);
  console.log(`  ccPath:        ${cfg1.ccPath || '(none)'}`);
  console.log(`  ccHash:        ${cfg1.ccHash || '(none)'}`);
  console.log(`  clientId:      ${cfg1.clientId}`);
  console.log(`  authorizeUrl:  ${cfg1.authorizeUrl}`);
  console.log(`  tokenUrl:      ${cfg1.tokenUrl}`);
  console.log(`  scopes:        ${cfg1.scopes}\n`);

  // Assertions
  const checks = [];

  checks.push({
    name: 'source is "detected" (not fallback)',
    pass: cfg1.source === 'detected',
  });
  checks.push({
    name: `clientId is the PROD UUID (${PROD_CLIENT_ID.slice(0, 8)}…)`,
    pass: cfg1.clientId === PROD_CLIENT_ID,
  });
  checks.push({
    name: `clientId is NOT the dead-code dev UUID (${DEAD_DEV_CLIENT_ID.slice(0, 8)}…)`,
    pass: cfg1.clientId !== DEAD_DEV_CLIENT_ID,
  });
  checks.push({
    name: 'authorizeUrl uses claude.com/cai/oauth/authorize',
    pass: cfg1.authorizeUrl === 'https://claude.com/cai/oauth/authorize',
  });
  checks.push({
    name: 'tokenUrl uses platform.claude.com/v1/oauth/token',
    pass: cfg1.tokenUrl === 'https://platform.claude.com/v1/oauth/token',
  });
  checks.push({
    name: 'scopes include user:inference',
    pass: cfg1.scopes.includes('user:inference'),
  });
  checks.push({
    name: 'scopes do NOT include org:create_api_key (Anthropic rejects it for CC client_id since v2.1.107 — dario #42)',
    pass: !cfg1.scopes.includes('org:create_api_key'),
  });
  checks.push({
    name: 'scopes include user:file_upload (missing from v3.4.3 scanner output due to regex picking up help-message literal)',
    pass: cfg1.scopes.includes('user:file_upload'),
  });
  checks.push({
    name: 'scopes contain exactly 5 items (user-only n36 union post-v2.1.107)',
    pass: cfg1.scopes.split(/\s+/).length === 5,
  });

  // Prove the PROD config block context: find the prod-specific anchor
  // `BASE_API_URL:"https://api.anthropic.com"` (this literal only appears
  // inside the `nh$` prod config object) and show the surrounding bytes.
  // The detected CLIENT_ID must appear in this block.
  if (cfg1.ccPath) {
    console.log('─── Binary proof: PROD config block (the one shipped CC actually uses) ───');
    const buf = await readFile(cfg1.ccPath);
    const anchor = Buffer.from('BASE_API_URL:"https://api.anthropic.com"');
    const idx = buf.indexOf(anchor);
    if (idx !== -1) {
      const ctx = buf.slice(idx, idx + 1024).toString('latin1');
      const cidMatch = ctx.match(/CLIENT_ID\s*:\s*"[0-9a-f-]{36}"/);
      const snippet = cidMatch
        ? ctx.slice(0, ctx.indexOf(cidMatch[0]) + cidMatch[0].length)
        : ctx.slice(0, 800);
      console.log(`  ...${snippet}...\n`);
      checks.push({
        name: 'PROD config block contains the detected clientId',
        pass: snippet.includes(cfg1.clientId),
      });
      checks.push({
        name: 'PROD block does NOT contain the dead-code dev UUID',
        pass: !snippet.includes(DEAD_DEV_CLIENT_ID),
      });
    } else {
      checks.push({ name: 'PROD block anchor found in binary', pass: false });
    }

    // Also verify the `-local-oauth` dev block still exists as dead code.
    // We're intentionally NOT using it, but it should still be in the
    // binary — if it disappears from future CC builds, our detector's
    // defensive rejection of the dev UUID becomes pointless and we should
    // remove that guard.
    const deadAnchor = Buffer.from('OAUTH_FILE_SUFFIX:"-local-oauth"');
    const didx = buf.indexOf(deadAnchor);
    if (didx !== -1) {
      const dctx = buf.slice(Math.max(0, didx - 220), didx + deadAnchor.length + 40).toString('latin1');
      console.log('─── Binary proof: -local-oauth dev block (dead code, NOT used by shipped CC) ───');
      console.log(`  ...${dctx}...\n`);
      checks.push({
        name: 'Dead-code dev block contains the rejected UUID (confirms defensive guard is still meaningful)',
        pass: dctx.includes(DEAD_DEV_CLIENT_ID),
      });
    }
  }

  // Cache hit test
  console.log('→ Running detector again (should hit cache)...\n');
  _resetDetectorCache();
  const t2 = Date.now();
  const cfg2 = await detectCCOAuthConfig();
  const t3 = Date.now();
  console.log(`  Took ${t3 - t2}ms`);
  console.log(`  source: ${cfg2.source}\n`);
  checks.push({
    name: 'Second call uses cache (source=cached)',
    pass: cfg2.source === 'cached',
  });
  checks.push({
    name: 'Cache hit is fast (<200ms)',
    pass: (t3 - t2) < 200,
  });
  checks.push({
    name: 'Cache returns same clientId',
    pass: cfg2.clientId === cfg1.clientId,
  });

  // Override-file escape hatch test
  console.log('→ Running detector with manual override file...\n');
  await writeFile(overridePath, JSON.stringify({ clientId: OVERRIDE_CLIENT_ID }, null, 2));
  clearOverrideEnv();
  process.env.DARIO_OAUTH_OVERRIDE_PATH = overridePath;
  _resetDetectorCache();
  const cfg3 = await detectCCOAuthConfig();
  console.log(`  source: ${cfg3.source}`);
  console.log(`  clientId: ${cfg3.clientId}\n`);
  checks.push({
    name: 'Manual override file wins over detected clientId',
    pass: cfg3.source === 'override' && cfg3.clientId === OVERRIDE_CLIENT_ID,
  });

  // Env override test
  console.log('→ Running detector with env override...\n');
  clearOverrideEnv();
  process.env.DARIO_OAUTH_CLIENT_ID = OVERRIDE_CLIENT_ID;
  process.env.DARIO_OAUTH_AUTHORIZE_URL = OVERRIDE_AUTHORIZE_URL;
  _resetDetectorCache();
  const cfg4 = await detectCCOAuthConfig();
  console.log(`  source: ${cfg4.source}`);
  console.log(`  clientId: ${cfg4.clientId}`);
  console.log(`  authorizeUrl: ${cfg4.authorizeUrl}\n`);
  checks.push({
    name: 'Env override wins over detected clientId',
    pass: cfg4.source === 'override' && cfg4.clientId === OVERRIDE_CLIENT_ID,
  });
  checks.push({
    name: 'Partial env override preserves detected tokenUrl and scopes',
    pass: cfg4.tokenUrl === cfg1.tokenUrl && cfg4.scopes === cfg1.scopes,
  });

  // Env > file precedence test
  console.log('→ Running detector with both env and file overrides...\n');
  await writeFile(overridePath, JSON.stringify({ clientId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, null, 2));
  clearOverrideEnv();
  process.env.DARIO_OAUTH_OVERRIDE_PATH = overridePath;
  process.env.DARIO_OAUTH_CLIENT_ID = OVERRIDE_CLIENT_ID;
  _resetDetectorCache();
  const cfg5 = await detectCCOAuthConfig();
  checks.push({
    name: 'Env override takes precedence over file override',
    pass: cfg5.clientId === OVERRIDE_CLIENT_ID,
  });

  // Disable test
  console.log('→ Running detector with override disabled...\n');
  clearOverrideEnv();
  process.env.DARIO_OAUTH_OVERRIDE_PATH = overridePath;
  process.env.DARIO_OAUTH_CLIENT_ID = OVERRIDE_CLIENT_ID;
  process.env.DARIO_OAUTH_DISABLE_OVERRIDE = '1';
  _resetDetectorCache();
  const cfg6 = await detectCCOAuthConfig();
  checks.push({
    name: 'DARIO_OAUTH_DISABLE_OVERRIDE=1 disables env and file overrides',
    pass: cfg6.source === 'cached' && cfg6.clientId === cfg1.clientId,
  });

  // Non-HTTPS warning hardening test
  console.log('→ Running detector with non-HTTPS override URLs...\n');
  const originalWarn = console.warn;
  const warnings = [];
  try {
    console.warn = (...args) => warnings.push(args.join(' '));
    clearOverrideEnv();
    process.env.DARIO_OAUTH_AUTHORIZE_URL = NON_HTTPS_AUTHORIZE_URL;
    process.env.DARIO_OAUTH_TOKEN_URL = NON_HTTPS_TOKEN_URL;
    _resetDetectorCache();
    const cfg7 = await detectCCOAuthConfig();
    const expectedAuthorizeWarning = `[dario] OAuth override authorizeUrl is non-HTTPS (${NON_HTTPS_AUTHORIZE_URL}). Allowed as an emergency escape hatch, but double-check the source before using it.`;
    const expectedTokenWarning = `[dario] OAuth override tokenUrl is non-HTTPS (${NON_HTTPS_TOKEN_URL}). Allowed as an emergency escape hatch, but double-check the source before using it.`;
    console.log(`  warnings: ${warnings.join('\n') || '(none)'}\n`);
    checks.push({
      name: 'Non-HTTPS authorize/token override URLs still apply',
      pass: cfg7.authorizeUrl === NON_HTTPS_AUTHORIZE_URL && cfg7.tokenUrl === NON_HTTPS_TOKEN_URL,
    });
    checks.push({
      name: 'Non-HTTPS override URLs emit warnings without blocking',
      pass:
        warnings.includes(expectedAuthorizeWarning) &&
        warnings.includes(expectedTokenWarning),
    });
  } finally {
    console.warn = originalWarn;
  }

  // Results
  console.log('─── Results ───');
  let passed = 0;
  for (const c of checks) {
    const mark = c.pass ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${c.name}`);
    if (c.pass) passed++;
  }
  console.log(`\n  ${passed}/${checks.length} checks passed\n`);

  if (passed !== checks.length) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  E2E TEST FAILED');
    console.log('═══════════════════════════════════════════════════════════');
    process.exit(1);
  }
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  E2E TEST PASSED');
  console.log('═══════════════════════════════════════════════════════════');
  } finally {
    try { await unlink(overridePath); } catch {}
    restoreOverrideEnv(savedEnv);
    _resetDetectorCache();
  }
}

main().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
