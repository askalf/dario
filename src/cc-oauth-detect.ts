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
 * Results are cached per-binary-hash at ~/.dario/cc-oauth-cache-v6.json so
 * startup only re-scans when the user upgrades Claude Code. The cache suffix
 * is bumped each time scope handling or the fallback config changes, so
 * upgrading dario picks up the new values without a manual cache clear.
 *
 * Escape hatch: if Anthropic rotates OAuth metadata before the detector is
 * updated, operators can temporarily override any detected value via env vars
 * or ~/.dario/oauth-config.override.json.
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
  source: 'detected' | 'cached' | 'fallback' | 'override';
  ccPath?: string;
  ccHash?: string;
}

type OAuthFields = Pick<DetectedOAuthConfig, 'clientId' | 'authorizeUrl' | 'tokenUrl' | 'scopes'>;
type OAuthOverride = Partial<OAuthFields>;

/**
 * Normalize the authorize URL to match what CC uses at runtime.
 *
 * The CC binary ships `CLAUDE_AI_AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize"`
 * as a literal string, but at runtime CC's `/login` opens
 * `https://claude.ai/oauth/authorize` directly (empirically verified against
 * CC v2.1.116 by tetsuco in dario#71). Historically the claude.com edge
 * 307-redirected to claude.ai and the browser followed; recent Anthropic-side
 * changes made the post-redirect validation start returning "Invalid request
 * format", while direct requests to claude.ai continue to work. This normalizer
 * rewrites the legacy URL wherever it appears (binary extraction, manual
 * override, cached config) so dario matches CC's runtime behaviour.
 *
 * Intentionally narrow: only the exact legacy URL is rewritten. Any other
 * operator-supplied URL (e.g. a staging endpoint via override) passes through.
 */
export function normalizeAuthorizeUrl(url: string): string {
  if (url === 'https://claude.com/cai/oauth/authorize') {
    return 'https://claude.ai/oauth/authorize';
  }
  return url;
}

// Last-resort fallback if CC binary can't be found or scanned.
// These values are the CC v2.1.104 PROD OAuth config, extracted from
// the `nh$` object in the shipped binary. authorizeUrl is normalized —
// see normalizeAuthorizeUrl() above for why this matters (dario#71).
const FALLBACK: DetectedOAuthConfig = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  // Scopes match CC v2.1.116+ interactive login: the 6-scope set including
  // `org:create_api_key` as the FIRST scope. We previously shipped only 5
  // scopes based on dario#42's v2.1.107 observation — Anthropic had flipped
  // to rejecting the 6-scope form and CC's own binary dropped
  // `org:create_api_key` from its `n36` union. Between v2.1.107 and v2.1.116
  // Anthropic flipped BACK: v2.1.116's `/login` opens the authorize URL with
  // all 6 scopes (dario#71, tetsuco, 2026-04-23 — authorize URL diff across
  // all three scope-variant tests confirmed CC's 6-scope list is the only
  // one accepted by the current `claude.ai/oauth/authorize` endpoint for
  // this client_id).
  //
  // Scope-list history on this client_id:
  // - dario 3.2.7–3.4.3: 5 scopes (misread "Console-only" name), dropped
  //   `org:create_api_key` wrongly. Users hit auth failures.
  // - dario 3.4.4: 6 scopes restored after prod started rejecting 5.
  // - dario 3.19.5: 5 scopes again, after prod rotated to rejecting 6 on
  //   CC v2.1.107.
  // - dario 3.31.4 (this): 6 scopes again, after prod rotated back on
  //   CC v2.1.116.
  //
  // The scope list can't be extracted from the binary reliably (see
  // extractFromBinary's comment). If Anthropic flips again the fix is one
  // line here plus a cache-version bump.
  scopes: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
  source: 'fallback',
};

// Re-export of FALLBACK for scripts/check-cc-authorize-probe.mjs. The probe
// needs the exact values the runtime uses — hardcoding them in the script
// would drift out of sync silently.
export const FALLBACK_FOR_DRIFT_CHECK: Readonly<DetectedOAuthConfig> = FALLBACK;

// -v6 suffix invalidates -v5 caches populated with the 5-scope FALLBACK.
// Those caches stored scopes from the FALLBACK copy at extract time, so
// bumping FALLBACK.scopes without bumping the cache version would leave
// upgraded users still hitting "Invalid request format" until they
// manually deleted the cache file. On upgrade to v3.31.4 the cache
// regenerates automatically with the 6-scope set (dario#71). Previous
// bumps: -v3 → -v4 in v3.19.4 for 6→5 rotation (dario#42); -v4 → -v5 in
// v3.31.3 for the authorize URL normalization.
const CACHE_PATH = join(homedir(), '.dario', 'cc-oauth-cache-v6.json');
const DEFAULT_OVERRIDE_PATH = join(homedir(), '.dario', 'oauth-config.override.json');

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

function isOverrideDisabled(): boolean {
  return process.env['DARIO_OAUTH_DISABLE_OVERRIDE'] === '1';
}

function getOverridePath(): string {
  return process.env['DARIO_OAUTH_OVERRIDE_PATH']?.trim() || DEFAULT_OVERRIDE_PATH;
}

function cleanOverrideValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOverride(parsed: Record<string, unknown>): OAuthOverride | null {
  const override: OAuthOverride = {};
  const clientId = typeof parsed.clientId === 'string' ? cleanOverrideValue(parsed.clientId) : undefined;
  const authorizeUrl = typeof parsed.authorizeUrl === 'string' ? cleanOverrideValue(parsed.authorizeUrl) : undefined;
  const tokenUrl = typeof parsed.tokenUrl === 'string' ? cleanOverrideValue(parsed.tokenUrl) : undefined;
  const scopes = typeof parsed.scopes === 'string' ? cleanOverrideValue(parsed.scopes) : undefined;

  if (clientId) override.clientId = clientId;
  if (authorizeUrl) override.authorizeUrl = authorizeUrl;
  if (tokenUrl) override.tokenUrl = tokenUrl;
  if (scopes) override.scopes = scopes;

  return Object.keys(override).length > 0 ? override : null;
}

async function loadManualOverride(): Promise<OAuthOverride | null> {
  if (isOverrideDisabled()) return null;

  const envOverride = normalizeOverride({
    clientId: process.env['DARIO_OAUTH_CLIENT_ID'],
    authorizeUrl: process.env['DARIO_OAUTH_AUTHORIZE_URL'],
    tokenUrl: process.env['DARIO_OAUTH_TOKEN_URL'],
    scopes: process.env['DARIO_OAUTH_SCOPES'],
  });
  if (envOverride) return envOverride;

  try {
    const raw = await readFile(getOverridePath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeOverride(parsed);
  } catch {
    return null;
  }
}

function warnOnNonHttpsOverride(name: 'authorizeUrl' | 'tokenUrl', value: string | undefined): void {
  if (!value || /^https:\/\//i.test(value)) return;
  console.warn(
    `[dario] OAuth override ${name} is non-HTTPS (${value}). ` +
    'Allowed as an emergency escape hatch, but double-check the source before using it.',
  );
}

function applyManualOverride(config: DetectedOAuthConfig, override: OAuthOverride | null): DetectedOAuthConfig {
  if (!override) return config;
  warnOnNonHttpsOverride('authorizeUrl', override.authorizeUrl);
  warnOnNonHttpsOverride('tokenUrl', override.tokenUrl);
  // Normalize any override-supplied authorizeUrl too — users who pasted the
  // legacy claude.com URL into ~/.dario/oauth-config.override.json pre-#71
  // shouldn't be silently broken after upgrade.
  const normalizedOverride = { ...override };
  if (normalizedOverride.authorizeUrl) {
    normalizedOverride.authorizeUrl = normalizeAuthorizeUrl(normalizedOverride.authorizeUrl);
  }
  return {
    ...config,
    ...normalizedOverride,
    source: 'override',
  };
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

  const windowStart = anchorIdx;
  // The prod config object is laid out roughly as one line of minified JS.
  // Take a generous window to be safe across minifier differences.
  const windowEnd = Math.min(buf.length, anchorIdx + 2048);
  const prodBlock = buf.slice(windowStart, windowEnd).toString('latin1');

  const cidMatch = /CLIENT_ID\s*:\s*"([0-9a-f-]{36})"/i.exec(prodBlock);
  if (!cidMatch || !cidMatch[1]) return null;
  const clientId = cidMatch[1];

  // Defensive: if we somehow matched the dev client_id, reject — the
  // anchor should have put us in the prod block, but this guards against
  // the block being laid out in an unexpected order across builds. Failing
  // the scan and falling back is safer than authenticating against the
  // wrong Anthropic OAuth client.
  if (clientId === '22422756-60c9-4084-8eb7-27705fd5cf9a') return null;

  let authorizeUrl = FALLBACK.authorizeUrl;
  const authMatch = /CLAUDE_AI_AUTHORIZE_URL\s*:\s*"([^"]+)"/.exec(prodBlock);
  if (authMatch && authMatch[1]) authorizeUrl = normalizeAuthorizeUrl(authMatch[1]);

  let tokenUrl = FALLBACK.tokenUrl;
  const tokenMatch = /TOKEN_URL\s*:\s*"(https:\/\/[^"]*\/oauth\/token[^"]*)"/.exec(prodBlock);
  if (tokenMatch && tokenMatch[1]) tokenUrl = tokenMatch[1];

  // Scopes can't be EXTRACTED from the binary — the real scope array is
  // stored as a constant-reference array (`dY8 = [B9H, TI, "user:sessions:
  // ...", ...]`) where the first elements are minified variable references,
  // not literal strings, so no regex resolves the full list statically.
  //
  // But we CAN verify them: every scope CC uses does appear as a quoted
  // literal string somewhere in the binary (either in the scope array
  // itself when not minified to a variable ref, or in help-text /
  // error-message references that name scopes by literal). Scan for each
  // FALLBACK scope's quoted literal; if any go missing, drop those
  // scopes from the returned config and log a warning.
  //
  // This catches one class of drift the hardcoded FALLBACK doesn't: a
  // future CC release that REMOVES a scope from the active set — Anthropic
  // deprecates `user:file_upload` in CC v2.2.0, say — would leave dario
  // sending a stale scope that the server now rejects, same failure mode
  // as #42 / #71. Binary verification catches it at startup without
  // waiting for a user to hit the "Invalid request format" page.
  //
  // It does NOT catch the opposite direction (Anthropic starts accepting
  // a new scope CC didn't previously use) — those still require a FALLBACK
  // bump. The probe in scripts/check-cc-authorize-probe.mjs + `dario
  // doctor --probe` covers that direction.
  const expected = FALLBACK.scopes.split(/\s+/).filter(Boolean);
  const verified = filterScopesByBinaryPresence(buf, expected);
  const scopes = verified.length > 0 ? verified.join(' ') : FALLBACK.scopes;
  return { clientId, authorizeUrl, tokenUrl, scopes };
}

/**
 * Given CC's binary and a list of scope literals we expect to find,
 * return the subset that actually appear as quoted-string literals in
 * the binary. Scoping the match to `"<scope>"` (with surrounding
 * double quotes) avoids false matches on partial substrings. Pure
 * over its inputs — safe to unit-test without a real CC binary.
 *
 * Exported for unit tests.
 */
export function filterScopesByBinaryPresence(buf: Buffer, expected: readonly string[]): string[] {
  const out: string[] = [];
  for (const scope of expected) {
    const needle = Buffer.from(`"${scope}"`);
    if (buf.includes(needle)) out.push(scope);
  }
  return out;
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
    const manualOverride = await loadManualOverride();
    const ccPath = findCCBinary();
    if (!ccPath) {
      memoized = applyManualOverride(FALLBACK, manualOverride);
      return memoized;
    }

    const hash = await fingerprintBinary(ccPath);

    const cached = await loadCache();
    if (cached && cached.hash === hash) {
      memoized = applyManualOverride({ ...cached.config, source: 'cached', ccPath, ccHash: hash }, manualOverride);
      return memoized;
    }

    const buf = await readFile(ccPath);
    const scanned = scanBinaryForOAuthConfig(buf);
    if (!scanned) {
      memoized = applyManualOverride({ ...FALLBACK, ccPath, ccHash: hash }, manualOverride);
      return memoized;
    }

    const detected: DetectedOAuthConfig = {
      ...scanned,
      source: 'detected',
      ccPath,
      ccHash: hash,
    };

    await saveCache(hash, detected);
    memoized = applyManualOverride(detected, manualOverride);
    return memoized;
  } catch {
    memoized = applyManualOverride(FALLBACK, await loadManualOverride());
    return memoized;
  }
}

/** Test-only: reset in-process memoization. */
export function _resetDetectorCache(): void {
  memoized = null;
}
