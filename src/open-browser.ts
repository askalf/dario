/**
 * Safe URL → default-browser dispatch.
 *
 * Replaces the inline `child_process.exec` template-string patterns that
 * previously lived in `src/oauth.ts` and `src/accounts.ts`. Those used
 * shell interpolation of an external URL (`exec(\`start "" "${url}"\`)`,
 * `exec(\`xdg-open "${url}"\`)`) — defense-in-depth concern: a malicious
 * `DARIO_OAUTH_AUTHORIZE_URL` override, a backdoored `claude` binary
 * smuggling a different `CLAUDE_AI_AUTHORIZE_URL` literal through the
 * cc-oauth-detect scanner, or any future code path that lets a less-
 * trusted source reach this function would inject shell metacharacters
 * (`&`, `|`, `>`, `^`, ``$()``, backtick) and execute arbitrary commands.
 *
 * Hardened path:
 *   1. Parse the URL with WHATWG `URL` — throws on malformed input.
 *   2. Allow only `http:` and `https:` (rejects `file:`, `javascript:`,
 *      `vbscript:`, `data:`, custom schemes that route through
 *      registered URL handlers).
 *   3. Re-serialize via `parsed.toString()` so any pre-parse oddities
 *      get normalized through the URL spec.
 *   4. Spawn the platform's URL-handler binary directly with the URL as
 *      a single argv element — no shell, no template interpolation.
 *      Windows uses `explorer.exe` (System32 binary, accepts URLs as
 *      argv, no cmd hop) instead of `cmd /c start`, which would parse
 *      `&`/`|` as command separators after Node's argv → cmd quoting.
 *   5. Errors from the spawned process are swallowed: a failed browser
 *      open is non-fatal because every caller also prints the URL to
 *      stdout for manual paste.
 *
 * Tests use the `exec` option to inject a stub.
 */

import { execFile, type ExecFileException } from 'node:child_process';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export interface OpenBrowserOptions {
  /** Test hook — defaults to node:child_process execFile. */
  exec?: (
    file: string,
    args: readonly string[],
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ) => void;
}

/**
 * Build the (binary, argv) pair the current platform uses to dispatch a
 * URL to its default browser. Exported for tests.
 */
export function browserDispatchCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { bin: string; args: string[] } {
  const parsed = new URL(url);
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`openBrowser: refusing to open URL with protocol "${parsed.protocol}" (only http/https allowed)`);
  }
  const safe = parsed.toString();
  if (platform === 'win32') {
    // explorer.exe accepts a URL as a single argv element and routes it
    // through the registered URL handler. Avoids `cmd /c start "" "URL"`,
    // which re-parses cmd metacharacters even when called via execFile
    // because the cmd builtin runs *inside* cmd's parser, not Node's.
    return { bin: 'explorer.exe', args: [safe] };
  }
  if (platform === 'darwin') {
    return { bin: 'open', args: [safe] };
  }
  // Linux / BSD / other Unix.
  return { bin: 'xdg-open', args: [safe] };
}

/**
 * Open `url` in the user's default browser. See module docstring.
 *
 * @throws if the URL is malformed or has a protocol other than http/https.
 *         Browser-launch failures (handler missing, etc.) are swallowed —
 *         every caller already prints the URL for manual paste.
 */
export function openBrowser(url: string, opts: OpenBrowserOptions = {}): void {
  const { bin, args } = browserDispatchCommand(url);
  const exec = opts.exec ?? execFile;
  exec(bin, args, () => { /* non-fatal */ });
}
