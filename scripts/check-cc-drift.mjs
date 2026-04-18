#!/usr/bin/env node
/**
 * CC-binary drift watcher.
 *
 * Pulls @anthropic-ai/claude-code@latest from npm, runs dario's own scanner
 * against it, and compares the scanned values + probed signals against the
 * pinned constants this dario release was built on. Emits a JSON report
 * to stdout and exits 1 on any drift (0 on clean).
 *
 * The goal is to catch Anthropic-shipped changes (client_id rotation, URL
 * move, tool-set additions/removals, version past our tested range) the
 * day CC ships — not two weeks later when a user files an issue.
 *
 * Scope-ARRAY recovery is not possible from the binary: the scope list is
 * stored as a variable-reference tuple (e.g. `n36 = [A, B, C]` where A..C
 * are named constants defined far away) that no regex can resolve in order.
 * Individual scope LITERALS ("user:inference" etc.) do appear as plain
 * quoted strings, so we detect drift in the direction that matters —
 * disappearance of an expected scope. The reverse (unexpected scope
 * appears) is NOT checked here: a string constant can exist in the binary
 * without CC actually using it in the active scope array (confirmed in
 * v2.1.114, where org:create_api_key is still present as a string even
 * though the live server rejects it).
 *
 * CC v2.1.114+ dropped the JS cli bundle in favor of a native binary that
 * lives in a platform-specific sibling package (@anthropic-ai/claude-
 * code-linux-x64 etc.). This watcher follows the package layout: if the
 * wrapper has no cli.js, it reads optionalDependencies, fetches the
 * linux-x64 tarball (~73MB compressed, ~236MB uncompressed), and scans
 * that instead. Bun compiles the binary by embedding the JS source
 * verbatim, so scanBinaryForOAuthConfig's regex anchors still match.
 *
 * Live authorize-URL probing (scripts/check-cc-authorize-probe.mjs) is a
 * separate, complementary check. It's more authoritative (talks to the
 * actual policy engine) but CF-challenges block it from CI — it's useful
 * for a maintainer to run locally when the scope-literal scan flags drift.
 */

import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { scanBinaryForOAuthConfig } from '../dist/cc-oauth-detect.js';
import { SUPPORTED_CC_RANGE, compareVersions } from '../dist/live-fingerprint.js';
import { findUserPathHits } from '../dist/scrub-template.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const PINNED_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
};

// Scope literals we expect the CC binary to reference. This is the set of
// scopes CC v2.1.107+ uses for the interactive login flow (matches
// FALLBACK.scopes in src/cc-oauth-detect.ts). If a scope disappears from
// the binary, Anthropic removed the constant — usually tracks a server-
// side policy change (dario #42 pattern).
//
// There's no symmetric "forbidden scopes" binary check: `org:create_api_key`
// is present as a string in the v2.1.114 binary even though the live server
// rejects it with "Invalid request format". Presence of a string literal
// doesn't prove CC uses it in the active scope array (that's the whole point
// of the "scope array is variable-reference" comment in cc-oauth-detect.ts).
// The authoritative "is this scope currently accepted?" signal lives in the
// live authorize-probe only.
const OAUTH_SCOPES_EXPECTED = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];

// Preferred platform package for CI. Ubuntu runners, and the strings we
// care about are platform-independent (they come from the shared JS
// source that Bun bundles). Override via DARIO_CC_PLATFORM for local runs
// on non-Linux machines.
const PREFERRED_PLATFORM = process.env['DARIO_CC_PLATFORM'] || 'linux-x64';

const templateData = JSON.parse(
  readFileSync(join(repoRoot, 'src/cc-template-data.json'), 'utf-8'),
);
const PINNED_TEMPLATE_VERSION = templateData._version;
const PINNED_TOOL_NAMES = templateData.tools.map((t) => t.name).sort();

function log(msg) {
  console.error(`[cc-drift] ${msg}`);
}

/**
 * Resolve the platform-specific package name from the wrapper's
 * optionalDependencies, pack and extract it, return the path to the
 * native binary inside. Returns null if the platform isn't supported or
 * the fetch failed.
 *
 * We prefer linux-x64 (what CI runs) but honor DARIO_CC_PLATFORM for
 * local runs. The strings we scan are platform-independent — they all
 * come from the Bun-bundled JS source inside the compiled binary — so
 * picking a different platform gives the same drift signals.
 */
function fetchNativeBinary(optionalDependencies, ccVersion, scratchRoot) {
  const targetPkg = `@anthropic-ai/claude-code-${PREFERRED_PLATFORM}`;
  if (!optionalDependencies[targetPkg]) {
    log(`native binary: ${targetPkg} not in optionalDependencies (platforms listed: ${Object.keys(optionalDependencies).join(', ')})`);
    return null;
  }
  const pinnedVersion = optionalDependencies[targetPkg];
  // Version pin should match the wrapper exactly — flag if it doesn't.
  if (pinnedVersion !== ccVersion) {
    log(`native binary: wrapper v${ccVersion} pins ${targetPkg}@${pinnedVersion} — versions disagree, using wrapper version`);
  }

  const nativeDir = join(scratchRoot, 'native');
  mkdirSync(nativeDir, { recursive: true });

  log(`fetching ${targetPkg}@${ccVersion} tarball via npm pack... (~73MB compressed)`);
  try {
    execSync(`npm pack ${targetPkg}@${ccVersion} --silent`, {
      cwd: nativeDir,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch (err) {
    log(`native binary: npm pack failed: ${err.message}`);
    return null;
  }

  const tarballs = readdirSync(nativeDir).filter((f) => f.endsWith('.tgz'));
  if (tarballs.length === 0) {
    log('native binary: npm pack produced no tarball');
    return null;
  }

  log(`extracting ${tarballs[0]}... (~236MB uncompressed)`);
  try {
    execSync(`tar -xf "${tarballs[0]}"`, { cwd: nativeDir, stdio: 'inherit' });
  } catch (err) {
    log(`native binary: tar failed: ${err.message}`);
    return null;
  }

  // The platform package contains package/<binary-name>. On linux the
  // binary is named "claude"; on win32 it's "claude.exe". Pick whichever
  // file exists and is >1MB (rules out stubs, package.json, readme).
  const pkgDir = join(nativeDir, 'package');
  if (!existsSync(pkgDir)) {
    log(`native binary: no package/ inside tarball`);
    return null;
  }
  const binaryCandidate = readdirSync(pkgDir)
    .map((f) => join(pkgDir, f))
    .find((p) => {
      try { return statSync(p).size > 1_000_000; }
      catch { return false; }
    });
  if (!binaryCandidate) {
    log(`native binary: no file >1MB in package/`);
    return null;
  }
  return binaryCandidate;
}

const scratch = join(tmpdir(), `cc-drift-watch-${process.pid}-${Date.now()}`);
mkdirSync(scratch, { recursive: true });

const items = [];
let ccVersion = null;
let scanned = null;

try {
  log(`scratch: ${scratch}`);
  log('fetching @anthropic-ai/claude-code@latest tarball via npm pack...');
  execSync('npm pack @anthropic-ai/claude-code@latest --silent', {
    cwd: scratch,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const tarballs = readdirSync(scratch).filter((f) => f.endsWith('.tgz'));
  if (tarballs.length === 0) throw new Error('npm pack produced no tarball');

  log(`extracting ${tarballs[0]}...`);
  execSync(`tar -xf "${tarballs[0]}"`, { cwd: scratch, stdio: 'inherit' });

  const pkgDir = join(scratch, 'package');
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));
  ccVersion = pkg.version;
  log(`latest CC on npm: v${ccVersion}`);

  // CC v2.1.114+ dropped the bundled cli.js in favor of a native binary.
  // The wrapper package (@anthropic-ai/claude-code) now ships a 500-byte
  // stub that gets replaced at install time by install.cjs, which copies
  // the real ~236MB binary out of a platform-specific sibling package
  // (@anthropic-ai/claude-code-linux-x64 etc., pinned via
  // optionalDependencies). Older CC versions had cli.js inline in the
  // wrapper and scanned fine without this detour.
  //
  // For drift scanning it's the same deal either way: the native binary
  // is a Bun-compiled bundle that still embeds the original JS source
  // verbatim, so scanBinaryForOAuthConfig's regex anchors (BASE_API_URL,
  // CLIENT_ID, etc.) match against the native binary too. We just need
  // to resolve where the real bytes live.
  const jsCandidates = ['cli.js', 'cli.mjs', 'dist/cli.js', 'dist/cli.mjs'];
  let cliPath = null;
  let cliSource = 'none'; // 'wrapper-js' | 'platform-native' | 'none'

  for (const c of jsCandidates) {
    const p = join(pkgDir, c);
    if (existsSync(p)) { cliPath = p; cliSource = 'wrapper-js'; break; }
  }

  if (!cliPath && pkg.optionalDependencies) {
    const nativePath = fetchNativeBinary(pkg.optionalDependencies, ccVersion, scratch);
    if (nativePath) {
      cliPath = nativePath;
      cliSource = 'platform-native';
    }
  }

  if (!cliPath) {
    items.push({
      category: 'scanner.layout',
      severity: 'high',
      message:
        `No scannable CC binary found for v${ccVersion}. ` +
        `Wrapper has no cli.js/cli.mjs and no @anthropic-ai/claude-code-${PREFERRED_PLATFORM} ` +
        `entry in optionalDependencies was fetchable. Inspect the tarball layout and update ` +
        `jsCandidates or fetchNativeBinary in scripts/check-cc-drift.mjs.`,
    });
  } else {
    log(`scanning ${cliPath.replace(scratch, '<scratch>')} (source: ${cliSource})`);
  }

  const buf = cliPath ? readFileSync(cliPath) : Buffer.alloc(0);
  scanned = cliPath ? scanBinaryForOAuthConfig(buf) : null;

  if (!scanned && cliPath) {
    // Only emit this if we actually tried the JS scanner and it failed —
    // if cliPath was null we already emitted scanner.js_entry above.
    items.push({
      category: 'scanner',
      severity: 'high',
      message:
        `scanner returned null for CC v${ccVersion}. The PROD anchor (BASE_API_URL) or CLIENT_ID regex missed — either Anthropic reshuffled the config block or minifier changed. Investigate src/cc-oauth-detect.ts:scanBinaryForOAuthConfig.`,
    });
  } else if (scanned) {
    if (scanned.clientId !== PINNED_OAUTH.clientId) {
      items.push({
        category: 'oauth.clientId',
        severity: 'high',
        message:
          `clientId changed: ${PINNED_OAUTH.clientId} -> ${scanned.clientId}. Update FALLBACK.clientId (src/cc-oauth-detect.ts) and re-verify the prod-config block anchor.`,
      });
    }
    if (scanned.authorizeUrl !== PINNED_OAUTH.authorizeUrl) {
      items.push({
        category: 'oauth.authorizeUrl',
        severity: 'high',
        message:
          `authorizeUrl changed: ${PINNED_OAUTH.authorizeUrl} -> ${scanned.authorizeUrl}. Update FALLBACK.authorizeUrl (src/cc-oauth-detect.ts).`,
      });
    }
    if (scanned.tokenUrl !== PINNED_OAUTH.tokenUrl) {
      items.push({
        category: 'oauth.tokenUrl',
        severity: 'high',
        message:
          `tokenUrl changed: ${PINNED_OAUTH.tokenUrl} -> ${scanned.tokenUrl}. Update FALLBACK.tokenUrl (src/cc-oauth-detect.ts).`,
      });
    }
  }

  if (ccVersion && compareVersions(ccVersion, SUPPORTED_CC_RANGE.maxTested) > 0) {
    items.push({
      category: 'compat.range',
      severity: 'medium',
      message:
        `CC v${ccVersion} is beyond SUPPORTED_CC_RANGE.maxTested (v${SUPPORTED_CC_RANGE.maxTested}). Run the e2e suite against the new CC and bump maxTested in src/live-fingerprint.ts — users on the new CC currently get a soft "untested-above" warning from dario doctor.`,
    });
  }

  if (ccVersion && ccVersion !== PINNED_TEMPLATE_VERSION) {
    items.push({
      category: 'template.version',
      severity: 'low',
      message:
        `baked cc-template-data.json is v${PINNED_TEMPLATE_VERSION}; npm latest is v${ccVersion}. Re-capture the template (MITM a real CC v${ccVersion} request) if any fingerprint-sensitive field (system prompt, header order, metadata shape, beta flags) changed.`,
    });
  }

  // Quoted-string set checks. Work against either the wrapper-js cli.js
  // or the Bun-compiled native binary (which embeds the same JS source
  // with its string literals intact).
  if (cliPath) {
    const binText = buf.toString('latin1');

    const missingTools = PINNED_TOOL_NAMES.filter((name) => !binText.includes(`"${name}"`));
    if (missingTools.length > 0) {
      items.push({
        category: 'tools.removed',
        severity: 'high',
        message:
          `Tools expected by dario but absent from CC v${ccVersion} binary: ${missingTools.join(', ')}. Update TOOL_MAP / CC_TOOL_DEFINITIONS (src/cc-template.ts) and re-capture cc-template-data.json before the next dario release.`,
      });
    }

    // Scope-literal scan. Each expected scope appears as a quoted literal
    // where the constant is defined (e.g. `"user:inference"` shows up in
    // the OAuth config block). The reverse direction — "forbidden scopes
    // must not appear" — is NOT checked: org:create_api_key is still a
    // string in the v2.1.114 binary even though the live server rejects
    // it, because the string constant can exist without CC actually using
    // it in the active scope array. That's the whole point of the comment
    // in cc-oauth-detect.ts. The authorize-probe is the only source of
    // truth for "which scopes does the server currently accept".
    const missingScopes = OAUTH_SCOPES_EXPECTED.filter(
      (s) => !binText.includes(`"${s}"`),
    );
    if (missingScopes.length > 0) {
      items.push({
        category: 'oauth.scopes.removed',
        severity: 'high',
        message:
          `Scope literals expected by dario's FALLBACK.scopes but absent from CC v${ccVersion} binary: ${missingScopes.join(', ')}. ` +
          `This is the dario #42 pattern — Anthropic drops a scope from CC's binary to match a server-side policy change. ` +
          `Run scripts/check-cc-authorize-probe.mjs locally to confirm against the live authorize endpoint, ` +
          `then update FALLBACK.scopes in src/cc-oauth-detect.ts and bump the CACHE_PATH suffix so existing users regenerate.`,
      });
    }
  }

  // dario#45: baked template must not carry host-identifying paths or
  // user-specific MCP tools. Run the same scrub-detector findUserPathHits
  // uses and flag the bundled file if anything leaks through.
  const scrubHits = findUserPathHits(JSON.stringify(templateData));
  if (scrubHits.length > 0) {
    items.push({
      category: 'template.user_paths',
      severity: 'high',
      message:
        `Baked cc-template-data.json contains user-identifying paths (${scrubHits.length} hit${scrubHits.length === 1 ? '' : 's'}; first: ${JSON.stringify(scrubHits[0])}). Re-run scripts/capture-and-bake.mjs — the scrub pipeline should strip these automatically.`,
    });
  }
  const mcpTools = (templateData.tools ?? []).filter((t) => typeof t?.name === 'string' && t.name.startsWith('mcp__'));
  if (mcpTools.length > 0) {
    items.push({
      category: 'template.mcp_tools',
      severity: 'high',
      message:
        `Baked cc-template-data.json contains ${mcpTools.length} mcp__* tool${mcpTools.length === 1 ? '' : 's'} (${mcpTools.map((t) => t.name).slice(0, 5).join(', ')}${mcpTools.length > 5 ? ', ...' : ''}). These are the capturing user's MCP server tools, not CC-canonical — re-run scripts/capture-and-bake.mjs to drop them.`,
    });
  }
} finally {
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort */ }
}

const report = {
  drift: items.length > 0,
  checkedAt: new Date().toISOString(),
  ccVersion,
  pinned: {
    ...PINNED_OAUTH,
    templateVersion: PINNED_TEMPLATE_VERSION,
    maxTested: SUPPORTED_CC_RANGE.maxTested,
    toolCount: PINNED_TOOL_NAMES.length,
    scopesExpected: OAUTH_SCOPES_EXPECTED,
  },
  scanned: scanned ?? null,
  items,
};

console.log(JSON.stringify(report, null, 2));
process.exit(items.length > 0 ? 1 : 0);
