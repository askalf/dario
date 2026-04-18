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
 * But the individual scope LITERALS ("user:inference" etc.) do appear as
 * plain strings in the binary, so we detect drift at the set level: which
 * scopes does CC reference? If Anthropic drops a scope (like they did with
 * `org:create_api_key` between CC v2.1.104 and v2.1.107 — dario #42), the
 * literal string disappears from the binary, and we catch it.
 *
 * Live authorize-URL probing (scripts/check-cc-authorize-probe.mjs) is a
 * separate, complementary check. It's more authoritative (talks to the
 * actual policy engine) but CF-challenges block it from CI — it's useful
 * for a maintainer to run locally when the scope-literal scan flags drift.
 */

import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
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
// FALLBACK.scopes in src/cc-oauth-detect.ts). If CC adds or drops any of
// these, that's drift worth a maintainer's attention — it usually tracks
// a server-side policy change (dario #42 pattern).
//
// `org:create_api_key` is intentionally absent: Anthropic dropped it from
// CC between v2.1.104 and v2.1.107. If it reappears, the probe classifier
// will flag it under OAUTH_SCOPES_FORBIDDEN below.
const OAUTH_SCOPES_EXPECTED = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];

// Scopes we expect to be absent from the shipped CC binary. If one reappears,
// Anthropic reversed a prior removal — worth a human look (might mean the
// policy flipped back and we can restore it in FALLBACK.scopes).
const OAUTH_SCOPES_FORBIDDEN = [
  'org:create_api_key',
];

const templateData = JSON.parse(
  readFileSync(join(repoRoot, 'src/cc-template-data.json'), 'utf-8'),
);
const PINNED_TEMPLATE_VERSION = templateData._version;
const PINNED_TOOL_NAMES = templateData.tools.map((t) => t.name).sort();

function log(msg) {
  console.error(`[cc-drift] ${msg}`);
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

  // CC v2.1.114+ dropped the bundled cli.js in favor of a native binary
  // in bin/ plus a tiny cli-wrapper.cjs that launches it. Older layouts
  // shipped cli.js (or cli.mjs) at the package root. Handle both: find
  // the JS-like file for scanBinaryForOAuthConfig (which has regex tuned
  // to the minified JS layout), and separately collect every scannable
  // artifact's bytes for the plain-string set checks (tools, scopes) —
  // those work equally well against a native binary.
  const jsCandidates = ['cli.js', 'cli.mjs', 'dist/cli.js', 'dist/cli.mjs'];
  let cliPath = null;
  for (const c of jsCandidates) {
    const p = join(pkgDir, c);
    if (existsSync(p)) { cliPath = p; break; }
  }

  const scanTargets = [];
  if (cliPath) scanTargets.push(cliPath);
  for (const extra of ['cli-wrapper.cjs', 'install.cjs']) {
    const p = join(pkgDir, extra);
    if (existsSync(p)) scanTargets.push(p);
  }
  const binDir = join(pkgDir, 'bin');
  if (existsSync(binDir)) {
    for (const f of readdirSync(binDir)) scanTargets.push(join(binDir, f));
  }
  if (scanTargets.length === 0) {
    items.push({
      category: 'scanner.layout',
      severity: 'high',
      message:
        `No scannable artifacts found in CC v${ccVersion} package (looked for ${jsCandidates.join(', ')}, cli-wrapper.cjs, bin/*). ` +
        `The npm package layout may have changed again — inspect the tarball and update the candidate lists in scripts/check-cc-drift.mjs.`,
    });
  } else {
    log(`scanning ${scanTargets.map((p) => p.replace(scratch, '<scratch>')).join(', ')}...`);
  }

  if (!cliPath && scanTargets.length > 0) {
    items.push({
      category: 'scanner.js_entry',
      severity: 'high',
      message:
        `CC v${ccVersion} has no JS cli entry (cli.js/cli.mjs) — the package now ships a native binary in bin/ ` +
        `plus a small cli-wrapper.cjs launcher. The watcher's binary scanner (scanBinaryForOAuthConfig) and the ` +
        `plain-string set checks (tool names, scope literals) are both tuned to the minified-JS layout where ` +
        `strings appear as quoted "name" forms. In the native binary they likely appear as length-prefixed or ` +
        `otherwise-packed bytes, so those checks are skipped this run. Adapt the scanner and set-checks to the ` +
        `new layout, or re-point them at whichever file in the tarball still carries the JS config block.`,
    });
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

  // Quoted-string set checks only make sense against the minified-JS
  // layout. The native-binary layout packs strings differently (length-
  // prefixed, likely not wrapped in quotes), so a quoted search produces
  // false positives. Gate on cliPath — when Anthropic's package layout
  // gets adapted to, these become useful again.
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

    // Scope-literal scan. The binary references each scope string at the
    // point where the constant is defined (e.g. `user:inference` appears
    // as a quoted literal in the OAuth config block). We check both the
    // expected set (must be present) and the forbidden set (must be absent).
    // Quoted form — `"user:inference"` — to avoid accidental matches inside
    // URL paths or user-visible error strings.
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

    const reappearedScopes = OAUTH_SCOPES_FORBIDDEN.filter(
      (s) => binText.includes(`"${s}"`),
    );
    if (reappearedScopes.length > 0) {
      items.push({
        category: 'oauth.scopes.reappeared',
        severity: 'medium',
        message:
          `Previously-removed scopes are back in CC v${ccVersion} binary: ${reappearedScopes.join(', ')}. ` +
          `Anthropic may have reversed a prior removal — not a user-facing breakage, but investigate whether ` +
          `FALLBACK.scopes should restore them. Update OAUTH_SCOPES_FORBIDDEN in scripts/check-cc-drift.mjs ` +
          `once you've decided.`,
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
    scopesForbidden: OAUTH_SCOPES_FORBIDDEN,
  },
  scanned: scanned ?? null,
  items,
};

console.log(JSON.stringify(report, null, 2));
process.exit(items.length > 0 ? 1 : 0);
