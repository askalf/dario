/**
 * dario's own package version, bound at module load.
 *
 * Surfaced on `/status` and `/health` (#640) so a headless operator can confirm
 * an auto-update actually rolled the running proxy — `curl /health | jq .version`
 * beats exec-ing into the container to read package.json.
 *
 * WHY AT MODULE LOAD, NOT ON FIRST CALL. This used to read package.json lazily
 * the first time someone asked, and cache that. `npm i -g` rewrites
 * package.json under the running install without touching the process, so a
 * proxy that had not served `/status` before an upgrade answered its first one
 * with the NEW version while still executing the OLD code — precisely the
 * opposite of what the field exists to report. It cost the reporter on #1244 a
 * round trip: `/status` read 6.0.34 while `GET /admin/accounts` was still
 * emitting the 6.0.33 field set, so the advice he had been given ("upgrade,
 * then read `organization_id`") looked already done.
 *
 * Reading at import binds the value to the process. proxy.ts imports this at
 * startup, so `/status` reports the build that is actually answering until it
 * restarts — the only claim the field can honestly make.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function readVersion(): string {
  try {
    // dist/version.js → ../package.json (same layout the MCP server + CLI use).
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
    if (typeof pkg.version === 'string') return pkg.version;
  } catch {
    // package.json missing/malformed — report 'unknown', never throw.
  }
  return 'unknown';
}

/** Read once, at import. See the note above for why not on first call. */
const VERSION = readVersion();

export function darioVersion(): string {
  return VERSION;
}
