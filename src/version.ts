/**
 * dario's own package version, read once from the bundled package.json.
 *
 * Surfaced on `/status` and `/health` (#640) so a headless operator can confirm
 * an auto-update actually rolled the running proxy — `curl /health | jq .version`
 * beats exec-ing into the container to read package.json.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

export function darioVersion(): string {
  if (cached !== null) return cached;
  let v = 'unknown';
  try {
    // dist/version.js → ../package.json (same layout the MCP server + CLI use).
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
    if (typeof pkg.version === 'string') v = pkg.version;
  } catch {
    // package.json missing/malformed — keep 'unknown', never throw.
  }
  cached = v;
  return v;
}

/** Test-only: clear the memoized version. */
export function _resetVersionCacheForTest(): void {
  cached = null;
}
