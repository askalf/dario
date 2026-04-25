/**
 * Secret redaction for free-form strings emitted by dario.
 *
 * Used wherever an externally-sourced string (an upstream HTTP response
 * body, an exception message, a verbose log line) might transit through
 * to a place a user can see (stderr, an Error message, a JSON response).
 * Even though Anthropic's documented API is not known to echo tokens in
 * error responses, defense-in-depth: a future API change, a CDN error
 * page that captures the request headers, or an intermediary's debug
 * dump could surface a token, and we'd rather redact in transit than
 * audit every call site for novel leak shapes.
 *
 * Patterns match formats actually seen in the Anthropic ecosystem:
 *   - `sk-ant-…`     — long-lived API keys
 *   - JWT triple     — OAuth access tokens (`eyJhdr.eyJpyld.sig`)
 *   - `Bearer <…>`   — auth headers, raw or quoted
 *
 * Re-exported by `proxy.ts:sanitizeError` so the proxy's existing leak-
 * shield benefits from any new patterns added here, and consumed
 * directly by the OAuth code paths in `oauth.ts` / `accounts.ts` for
 * sanitizing upstream error bodies before they hit `throw new Error`.
 */

export const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-ant-[a-zA-Z0-9_-]+/g, '[REDACTED]'],
  [/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED_JWT]'],
  [/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]'],
];

/**
 * Apply every redaction pattern to a string. Idempotent — running a
 * pre-redacted string through this is a no-op.
 */
export function redactSecrets(s: string): string {
  let out = s;
  for (const [pat, repl] of SECRET_PATTERNS) {
    out = out.replace(pat, repl);
  }
  return out;
}
