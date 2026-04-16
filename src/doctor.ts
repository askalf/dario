/**
 * dario doctor — health report aggregator.
 *
 * Runs every check we know how to run and returns a list of labelled
 * results. The CLI passes the result list through `formatChecks` for
 * display; `runChecks` is the I/O-heavy collector, `formatChecks` is a
 * pure function the tests exercise directly.
 *
 * Keep `runChecks` defensive: a check that throws must not take the
 * rest of the report down — every check is wrapped so a broken sub-
 * system surfaces as `fail` instead of crashing the CLI.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform, arch, release } from 'node:os';
import {
  CC_TEMPLATE,
} from './cc-template.js';
import {
  describeTemplate,
  detectDrift,
  checkCCCompat,
  findInstalledCC,
  SUPPORTED_CC_RANGE,
  CURRENT_SCHEMA_VERSION,
} from './live-fingerprint.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  /** 'ok' passes; 'warn' is advisory; 'fail' blocks (exit code 1); 'info' is neutral. */
  status: CheckStatus;
  /** Short left-column label, e.g. `"Node"`, `"CC binary"`. */
  label: string;
  /** Right-column detail — human readable, may include versions, paths, counts. */
  detail: string;
}

/**
 * Pretty-print a list of Check results as aligned ASCII. No color codes —
 * Windows cmd / CI logs render plain text reliably; colors are a downside
 * not an upside for a report that's often piped or pasted.
 */
export function formatChecks(checks: Check[]): string {
  const prefix: Record<CheckStatus, string> = {
    ok: '[ OK ]',
    warn: '[WARN]',
    fail: '[FAIL]',
    info: '[INFO]',
  };
  const labelWidth = checks.reduce((n, c) => Math.max(n, c.label.length), 0);
  const lines = checks.map((c) => `  ${prefix[c.status]}  ${c.label.padEnd(labelWidth)}  ${c.detail}`);
  return lines.join('\n');
}

/**
 * Derive a CLI exit code from a set of check results. Any `fail` → 1.
 * `warn` alone does not fail — we don't want `dario doctor` to CI-fail
 * a user's machine just because they're on an untested CC version.
 */
export function exitCodeFor(checks: Check[]): number {
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}

/**
 * Run every available health check. Never throws — each check is
 * individually try/caught so a broken subsystem (e.g. unreadable accounts
 * dir) shows up as a `fail` row instead of crashing the CLI.
 *
 * The order is curated — more fundamental checks first (Node, dario
 * version, platform) so a reader scanning the output top-down sees
 * the environment before the subsystems.
 */
export async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  // ---- dario version
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    checks.push({ status: 'info', label: 'dario', detail: `v${pkg.version}` });
  } catch {
    checks.push({ status: 'warn', label: 'dario', detail: 'package.json not readable — version unknown' });
  }

  // ---- Node
  checks.push({
    status: nodeStatus(),
    label: 'Node',
    detail: process.version,
  });

  // ---- Platform
  checks.push({
    status: 'info',
    label: 'Platform',
    detail: `${platform()} ${arch()} (${release()})`,
  });

  // ---- CC binary
  const cc = safely(() => findInstalledCC(), { path: null, version: null });
  if (cc.path && cc.version) {
    const compat = checkCCCompat(cc.version);
    const status: CheckStatus =
      compat.status === 'ok' ? 'ok' :
      compat.status === 'untested-above' ? 'warn' :
      compat.status === 'below-min' ? 'fail' :
      'warn';
    checks.push({
      status,
      label: 'CC binary',
      detail: `v${cc.version} at ${cc.path}  (range: v${SUPPORTED_CC_RANGE.min} – v${SUPPORTED_CC_RANGE.maxTested})`,
    });
  } else if (cc.path) {
    checks.push({
      status: 'warn',
      label: 'CC binary',
      detail: `found at ${cc.path} but --version didn't parse — compat unchecked`,
    });
  } else {
    checks.push({
      status: 'warn',
      label: 'CC binary',
      detail: 'not on PATH — dario falls back to bundled template',
    });
  }

  // ---- Template source
  try {
    checks.push({
      status: CC_TEMPLATE._source === 'live' ? 'ok' : 'info',
      label: 'Template',
      detail: `${describeTemplate(CC_TEMPLATE)} (schema v${CC_TEMPLATE._schemaVersion ?? '?'})`,
    });
  } catch (err) {
    checks.push({ status: 'fail', label: 'Template', detail: `load failed: ${(err as Error).message}` });
  }

  // ---- Template drift
  try {
    const drift = detectDrift(CC_TEMPLATE);
    const status: CheckStatus = drift.installedVersion === null ? 'info' : drift.drifted ? 'warn' : 'ok';
    checks.push({ status, label: 'Template drift', detail: drift.message });
  } catch (err) {
    checks.push({ status: 'warn', label: 'Template drift', detail: `check failed: ${(err as Error).message}` });
  }
  void CURRENT_SCHEMA_VERSION; // keep the import load-bearing for future schema checks

  // ---- OAuth
  try {
    const { getStatus } = await import('./oauth.js');
    const s = await getStatus();
    if (!s.authenticated) {
      checks.push({
        status: s.status === 'expired' && s.canRefresh ? 'warn' : 'fail',
        label: 'OAuth',
        detail: s.status === 'none' ? 'not authenticated — run `dario login`' : s.status,
      });
    } else {
      checks.push({ status: 'ok', label: 'OAuth', detail: `${s.status} (expires in ${s.expiresIn})` });
    }
  } catch (err) {
    checks.push({ status: 'warn', label: 'OAuth', detail: `check failed: ${(err as Error).message}` });
  }

  // ---- Account pool
  try {
    const { listAccountAliases, loadAllAccounts } = await import('./accounts.js');
    const aliases = await listAccountAliases();
    if (aliases.length === 0) {
      checks.push({ status: 'info', label: 'Pool', detail: 'single-account mode (no pool configured)' });
    } else {
      const loaded = await loadAllAccounts();
      const now = Date.now();
      const expired = loaded.filter((a) => a.expiresAt <= now).length;
      checks.push({
        status: expired > 0 ? 'warn' : aliases.length >= 2 ? 'ok' : 'info',
        label: 'Pool',
        detail: `${aliases.length} account${aliases.length === 1 ? '' : 's'}` +
          (expired > 0 ? `, ${expired} expired` : '') +
          (aliases.length < 2 ? ' (pool activates at 2+)' : ''),
      });
    }
  } catch (err) {
    checks.push({ status: 'warn', label: 'Pool', detail: `check failed: ${(err as Error).message}` });
  }

  // ---- Secondary backends
  try {
    const { listBackends } = await import('./openai-backend.js');
    const backends = await listBackends();
    checks.push({
      status: 'info',
      label: 'Backends',
      detail: backends.length === 0
        ? 'none configured (Claude subscription is the only route)'
        : `${backends.length} configured: ${backends.map((b) => b.name).join(', ')}`,
    });
  } catch (err) {
    checks.push({ status: 'warn', label: 'Backends', detail: `check failed: ${(err as Error).message}` });
  }

  // ---- ~/.dario dir
  try {
    const home = join(homedir(), '.dario');
    checks.push({ status: 'info', label: 'Home', detail: home });
  } catch {
    // never fails in practice — homedir() is always defined on supported platforms
  }

  return checks;
}

function nodeStatus(): CheckStatus {
  const m = /^v(\d+)\./.exec(process.version);
  const major = m ? parseInt(m[1]!, 10) : 0;
  // engines: >=18 (see package.json). 18/20 are current supported Node LTS
  // lines — anything below 18 fails; above is ok.
  if (major >= 18) return 'ok';
  if (major === 0) return 'warn';
  return 'fail';
}

function safely<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}
