/**
 * `dario config` — print effective configuration with credentials redacted.
 *
 * Different from `dario doctor`: doctor is "is it working?", config is
 * "what IS it?". The overlap is intentional — config shows *settings*
 * (port, host, DARIO_API_KEY state, model defaults) that operators
 * need to confirm when debugging a client misconfiguration. Doctor
 * shows *health* (OAuth expiry, template drift, TLS fingerprint
 * match) that operators need to confirm when debugging a routing
 * failure.
 *
 * Every output row is already safe to paste into a bug report:
 * credentials are replaced with `set`/`unset` state tags, paths are
 * left untouched because they're operationally useful, tokens never
 * appear.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ConfigSection {
  title: string;
  rows: Array<{ label: string; value: string }>;
}

export interface ConfigReport {
  generatedAt: string;
  version: string;
  sections: ConfigSection[];
}

/**
 * Collect the effective dario configuration the proxy would run with.
 * Reads env vars, filesystem state (credentials, override files, caches),
 * account pool, and configured backends. Never reads the actual
 * credential VALUES — only their presence/absence/path.
 */
export async function collectEffectiveConfig(): Promise<ConfigReport> {
  const sections: ConfigSection[] = [];
  const home = join(homedir(), '.dario');

  // ── Identity
  let version = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version?: string };
    version = pkg.version ?? 'unknown';
  } catch { /* noop */ }
  sections.push({
    title: 'Identity',
    rows: [
      { label: 'version', value: `v${version}` },
      { label: 'runtime', value: `node ${process.version} on ${process.platform} ${process.arch}` },
    ],
  });

  // ── Proxy bind
  sections.push({
    title: 'Proxy (on `dario proxy`)',
    rows: [
      { label: 'port', value: envOrDefault('DARIO_PORT', '3456') },
      { label: 'host', value: envOrDefault('DARIO_HOST', '127.0.0.1') },
      { label: 'model', value: envOrDefault('DARIO_MODEL', '(passthrough — client picks)') },
      { label: 'effort', value: envOrDefault('DARIO_EFFORT', '(CC default)') },
    ],
  });

  // ── Auth gate
  sections.push({
    title: 'Auth gate',
    rows: [
      {
        label: 'DARIO_API_KEY',
        value: process.env.DARIO_API_KEY
          ? `set (length ${process.env.DARIO_API_KEY.length}) — x-api-key / Authorization Bearer required`
          : 'unset — auth not enforced on loopback',
      },
      {
        label: 'DARIO_STRICT_TLS',
        value: process.env.DARIO_STRICT_TLS === '1' ? 'on' : 'off',
      },
    ],
  });

  // ── OAuth (Claude subscription credentials)
  const credsPath = join(home, 'credentials.json');
  const credsInfo = describeCreds(credsPath);
  sections.push({
    title: 'OAuth',
    rows: [
      { label: 'credentials', value: credsInfo },
      { label: 'path', value: credsPath },
    ],
  });

  // ── Pool
  try {
    const { listAccountAliases } = await import('./accounts.js');
    const aliases = await listAccountAliases();
    sections.push({
      title: 'Account pool',
      rows: [
        { label: 'mode', value: aliases.length === 0 ? 'single-account (no pool)' : `pool of ${aliases.length}` },
        ...(aliases.length > 0 ? [{ label: 'aliases', value: aliases.join(', ') }] : []),
      ],
    });
  } catch {
    sections.push({
      title: 'Account pool',
      rows: [{ label: 'mode', value: '(check failed)' }],
    });
  }

  // ── Backends
  try {
    const { listBackends } = await import('./openai-backend.js');
    const backends = await listBackends();
    sections.push({
      title: 'OpenAI-compat backends',
      rows: [
        { label: 'count', value: String(backends.length) },
        ...(backends.length > 0
          ? [{ label: 'names', value: backends.map((b) => b.name).join(', ') }]
          : []),
      ],
    });
  } catch {
    sections.push({
      title: 'OpenAI-compat backends',
      rows: [{ label: 'count', value: '(check failed)' }],
    });
  }

  // ── Paths (everything dario reads/writes on disk)
  sections.push({
    title: 'Paths',
    rows: [
      { label: 'home', value: home },
      { label: 'credentials', value: credsPath },
      { label: 'accounts', value: join(home, 'accounts') },
      { label: 'oauth cache', value: join(home, 'cc-oauth-cache-v6.json') },
      { label: 'oauth override', value: join(home, 'oauth-config.override.json') },
      { label: 'template cache', value: join(home, 'template-cache.json') },
    ],
  });

  return {
    generatedAt: new Date().toISOString(),
    version,
    sections,
  };
}

function envOrDefault(name: string, dflt: string): string {
  return process.env[name] ? `${process.env[name]}  (from ${name})` : dflt;
}

function describeCreds(path: string): string {
  if (!existsSync(path)) return 'not authenticated (run `dario login`)';
  try {
    const s = statSync(path);
    const mode = (s.mode & 0o777).toString(8);
    const age = formatAge(Date.now() - s.mtimeMs);
    return `present (mode ${mode}, last updated ${age} ago)`;
  } catch {
    return 'present (stat failed)';
  }
}

// Exported for unit tests.
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

/**
 * Pretty-print a ConfigReport as aligned ASCII. Same approach as
 * doctor's formatChecks — plain text, no colors, pasteable.
 */
export function formatEffectiveConfig(report: ConfigReport): string {
  const lines: string[] = [];
  for (const section of report.sections) {
    lines.push(`  ${section.title}`);
    lines.push(`  ${'─'.repeat(section.title.length)}`);
    const labelWidth = section.rows.reduce((n, r) => Math.max(n, r.label.length), 0);
    for (const r of section.rows) {
      lines.push(`    ${r.label.padEnd(labelWidth)}  ${r.value}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Structured envelope for `dario config --json`. */
export function formatEffectiveConfigJson(report: ConfigReport): string {
  return JSON.stringify(report, null, 2);
}
