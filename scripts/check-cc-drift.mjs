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
 * Scopes are deliberately NOT checked here: scanBinaryForOAuthConfig
 * returns FALLBACK.scopes verbatim because the scope array in the binary
 * is stored as a variable-reference list that no regex can resolve.
 * Server-side scope policy flips (dario #42's actual root cause) are
 * caught by a live authorize-URL probe — separate follow-up.
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

  const cliCandidates = ['cli.js', 'cli.mjs', 'dist/cli.js', 'dist/cli.mjs'];
  let cliPath = null;
  for (const c of cliCandidates) {
    const p = join(pkgDir, c);
    if (existsSync(p)) { cliPath = p; break; }
  }
  if (!cliPath) throw new Error(`no cli entry in package; looked for ${cliCandidates.join(', ')}`);
  log(`scanning ${cliPath.replace(scratch, '<scratch>')}...`);

  const buf = readFileSync(cliPath);
  scanned = scanBinaryForOAuthConfig(buf);

  if (!scanned) {
    items.push({
      category: 'scanner',
      severity: 'high',
      message:
        `scanner returned null for CC v${ccVersion}. The PROD anchor (BASE_API_URL) or CLIENT_ID regex missed — either Anthropic reshuffled the config block or minifier changed. Investigate src/cc-oauth-detect.ts:scanBinaryForOAuthConfig.`,
    });
  } else {
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
  },
  scanned: scanned ?? null,
  items,
};

console.log(JSON.stringify(report, null, 2));
process.exit(items.length > 0 ? 1 : 0);
