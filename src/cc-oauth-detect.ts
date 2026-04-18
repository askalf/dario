/**
 * CC OAuth Auto-Detection
 *
 * Scans the installed Claude Code binary to extract its OAuth configuration
 * (client_id, authorize URL, token URL, scopes). Eliminates the need to
 * hardcode values that Anthropic rotates between CC releases.
 *
 * CC ships three OAuth config factories in one binary (dev/staging/prod),
 * selected at runtime by an environment switch that is hardcoded to "prod"
 * in shipped builds. Only the PROD block is live; "local" and "staging"
 * are dead code paths.
 *
 *   PROD block (the one we want):
 *     BASE_API_URL: "https://api.anthropic.com"
 *     CLAUDE_AI_AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize"
 *     TOKEN_URL: "https://platform.claude.com/v1/oauth/token"
 *     CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
 *     OAUTH_FILE_SUFFIX: ""
 *
 *   LOCAL block (dead code in shipped builds — CC pointing at localhost:8000
 *     etc. as its own dev stack, NOT about "client uses a localhost callback"):
 *     BASE_API_URL: "http://localhost:8000"
 *     CLIENT_ID: "22422756-60c9-4084-8eb7-27705fd5cf9a"
 *     OAUTH_FILE_SUFFIX: "-local-oauth"
 *
 * Dario uses CC's own automatic OAuth flow — the prod client is registered
 * with `http://localhost:${port}/callback` exactly as dario sends. (The
 * "MANUAL_REDIRECT_URL" on platform.claude.com is only used when dario's
 * local HTTP server can't bind a port; dario never hits that path.)
 *
 * Results are cached per-binary-hash at ~/.dario/cc-oauth-cache-v4.json so
 * startup only re-scans when the user upgrades Claude Code. The cache suffix
 * is bumped each time scope handling or the fallback config changes, so
 * upgrading dario picks up the new values without a manual cache clear.
 */

import { readFile, writeFile, mkdir, stat, open as openFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export interface DetectedOAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  source: 'detected' | 'cached' | 'fallback';
  ccPath?: string;
  ccHash?: string;
}

// Last-resort fallback if CC binary can't be found or scanned.
// These values are the CC v2.1.104 PROD OAuth config, extracted from
// the `nh$` object in the shipped binary.
const FALLBACK: DetectedOAuthConfig = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  // Scopes match CC v2.1.107+ interactive login: the 5-scope user-only set.
  // Between CC v2.1.104 and v2.1.107, Anthropic's authorize endpoint flipped
  // its policy on `org:create_api_key` for this client_id — the shorter list
  // is now the only accepted one, and the 6-scope form returns "Invalid
  // request format". CC's own binary dropped `org:create_api_key` from the
  // `n36` union to match. Dario #42 (tetsuco, 2026-04-17) surfaced this as
  // a fresh-login failure on macOS against CC v2.1.107.
  //
  // History: dario 3.2.7–3.4.3 once dropped this scope by mistake (misread
  // of the "Console-only" name); 3.4.4 added it back after users hit auth
  // failures with the dev client_id accepting it but prod rejecting. That
  // situation has now inverted — prod rejects the longer list.
  scopes: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  source: 'fallback',
};

// Re-export of FALLBACK for scripts/check-cc-authorize-probe.mjs. The probe
// needs the exact values the runtime uses — hardcoding them in the script
// would drift out of sync silently.
export const FALLBACK_FOR_DRIFT_CHECK: Readonly<DetectedOAuthConfig> = FALLBACK;

// -v4 suffix invalidates v3.x caches populated with the 6-scope list that
// Anthropic now rejects (dario #42). On upgrade, users regenerate the cache
// with the new FALLBACK scopes automatically — no manual clear required.
const CACHE_PATH = join(homedir(), '.dario', 'cc-oauth-cache-v4.json');

function candidatePaths(): string[] {
  const home = homedir();
  if (platform() === 'win32') {
    return [
      join(home, '.local', 'bin', 'claude.exe'),
      join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.mjs'),
      join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.mjs'),
    ];
  }
  return [
    join(home, '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.mjs',
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    join(home, '.claude', 'local', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.mjs'),
  ];
}

function findCCBinary(): string | null {
  const override = process.env['DARIO_CC_PATH'];
  if (override && existsSync(override)) return override;
  for (const p of candidatePaths()) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Fast fingerprint of a binary for caching. We hash the first 64KB plus
 * size+mtime — this discriminates CC versions without reading GBs off disk.
 */
async function fingerprintBinary(path: string): Promise<string> {
  const st = await stat(path);
  const fh = await openFile(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(65536, st.size));
    await fh.read(buf, 0, buf.length, 0);
    const h = createHash('sha256');
    h.update(buf);
    h.update(String(st.size));
    h.update(String(st.mtimeMs));
    return h.digest('hex').slice(0, 16);
  } finally {
    await fh.close();
  }
}

/**
 * Scan binary bytes for the PROD OAuth config block.
 *
 * Anchors on `BASE_API_URL:"https://api.anthropic.com"` — this literal
 * only appears inside the prod config object (`nh$`). The LOCAL-dev block
 * uses `http://localhost:8000` for the same key, and there's no staging
 * block present in shipped builds. Once we find the anchor, the CLIENT_ID,
 * CLAUDE_AI_AUTHORIZE_URL, TOKEN_URL, and scopes all live within a ~1.5KB
 * window after it.
 */
export function scanBinaryForOAuthConfig(buf: Buffer): Omit<DetectedOAuthConfig, 'source' | 'ccPath' | 'ccHash'> | null {
  const anchor = Buffer.from('BASE_API_URL:"https://api.anthropic.com"');
  const anchorIdx = buf.indexOf(anchor);
  if (anchorIdx === -1) return null;

  // The prod config object is laid out roughly as one line of minified JS.
  // Take a generous window to be safe across minifier differences.
  const windowStart = anchorIdx;
  const windowEnd = Math.min(buf.length, anchorIdx + 2048);
  const prodBlock = buf.slice(windowStart, windowEnd).toString('latin1');

  const cidMatch = /CLIENT_ID\s*:\s*"([0-9a-f-]{36})"/i.exec(prodBlock);
  if (!cidMatch || !cidMatch[1]) return null;
  const clientId = cidMatch[1];

  // Defensive: if we somehow matched the dev client_id, reject — the
  // anchor should have put us in the prod block, but this guards against
  // the block being laid out in an unexpected order across builds.
  if (clientId === '22422756-60c9-4084-8eb7-27705fd5cf9a') return null;

  let authorizeUrl = FALLBACK.authorizeUrl;
  const authMatch = /CLAUDE_AI_AUTHORIZE_URL\s*:\s*"([^"]+)"/.exec(prodBlock);
  if (authMatch && authMatch[1]) authorizeUrl = authMatch[1];

  let tokenUrl = FALLBACK.tokenUrl;
  const tokenMatch = /TOKEN_URL\s*:\s*"(https:\/\/[^"]*\/oauth\/token[^"]*)"/.exec(prodBlock);
  if (tokenMatch && tokenMatch[1]) tokenUrl = tokenMatch[1];

  // Scopes are NOT detected from the binary. Previous versions of this
  // scanner anchored on `"user:profile ` and regex-captured the first
  // contiguous quoted run of scopes, but that anchor matches an error/help
  // message string literal (used by `claude setup-token` error output) that
  // contains only 4 of the 6 actual scopes. The real scope array is stored
  // as a constant-reference array — `dY8 = [B9H, TI, "user:sessions:...", ...]`
  // — where the first two elements are minified variable references, not
  // literal strings, so no regex can reliably extract the full list. And the
  // runtime-computed union `n36` only exists after `Array.from(new Set(...))`
  // executes, which we can't evaluate from a static scan.
  //
  // Given that scopes rarely change across CC releases (Anthropic adds or
  // removes maybe one per major version), hardcoding them in FALLBACK is
  // more reliable than scanning. If Anthropic changes the scope list, the
  // fix is a one-line FALLBACK update in a dario release.
  return { clientId, authorizeUrl, tokenUrl, scopes: FALLBACK.scopes };
}

async function loadCache(): Promise<{ hash: string; config: DetectedOAuthConfig } | null> {
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { hash?: string; config?: DetectedOAuthConfig };
    if (parsed?.hash && parsed?.config?.clientId) {
      return { hash: parsed.hash, config: parsed.config };
    }
  } catch { /* no cache */ }
  return null;
}

async function saveCache(hash: string, config: DetectedOAuthConfig): Promise<void> {
  try {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify({ hash, config, savedAt: Date.now() }, null, 2));
  } catch { /* ignore cache write errors */ }
}

let memoized: DetectedOAuthConfig | null = null;

/**
 * Get the OAuth config for dario to use. Scans the installed CC binary
 * on first call, caches to disk, and memoizes in-process for subsequent
 * calls. If no binary is found or scanning fails, falls back to the
 * known-good v2.1.104 values.
 */
export async function detectCCOAuthConfig(): Promise<DetectedOAuthConfig> {
  if (memoized) return memoized;

  try {
    const ccPath = findCCBinary();
    if (!ccPath) {
      memoized = FALLBACK;
      return memoized;
    }

    const hash = await fingerprintBinary(ccPath);

    // Check cache
    const cached = await loadCache();
    if (cached && cached.hash === hash) {
      memoized = { ...cached.config, source: 'cached', ccPath, ccHash: hash };
      return memoized;
    }

    // Read binary and scan
    const buf = await readFile(ccPath);
    const scanned = scanBinaryForOAuthConfig(buf);
    if (!scanned) {
      memoized = { ...FALLBACK, ccPath, ccHash: hash };
      return memoized;
    }

    const detected: DetectedOAuthConfig = {
      ...scanned,
      source: 'detected',
      ccPath,
      ccHash: hash,
    };

    await saveCache(hash, detected);
    memoized = detected;
    return memoized;
  } catch {
    memoized = FALLBACK;
    return memoized;
  }
}

/** Test-only: reset in-process memoization. */
export function _resetDetectorCache(): void {
  memoized = null;
}
