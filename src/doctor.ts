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
import { execFileSync } from 'node:child_process';
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
  compareVersions,
} from './live-fingerprint.js';
import { detectCCOAuthConfig } from './cc-oauth-detect.js';
import { runAuthorizeProbe } from './cc-authorize-probe.js';

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
 * Serialize a check report as structured JSON. Lets other tools
 * (claude-bridge's /status command, deepdive, CI scripts) consume
 * dario's health programmatically instead of scraping the formatted
 * text. Emitted by `dario doctor --json`.
 */
export function formatChecksJson(checks: Check[]): string {
  const summary = {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    info: checks.filter((c) => c.status === 'info').length,
  };
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      exitCode: exitCodeFor(checks),
      summary,
      checks,
    },
    null,
    2,
  );
}

/**
 * Ask npm for the latest @anthropic-ai/claude-code version. One 3s
 * timeout; failures return null so doctor silently drops the check.
 * Result is cached module-scoped so back-to-back doctor invocations
 * (e.g. from a wrapping script) don't hammer the npm registry.
 */
let _npmLatestCache: { value: string | null; at: number } | null = null;
const NPM_CACHE_TTL_MS = 60 * 1000;

export function probeNpmLatestCC(): string | null {
  if (_npmLatestCache && Date.now() - _npmLatestCache.at < NPM_CACHE_TTL_MS) {
    return _npmLatestCache.value;
  }
  let value: string | null = null;
  try {
    // `npm view <pkg> version` prints the version as a single line.
    // 3s timeout keeps doctor responsive even with flaky network /
    // corporate proxies; stdio ignores stderr so "npm notice" banners
    // don't pollute stdout parsing.
    const out = execFileSync('npm', ['view', '@anthropic-ai/claude-code', 'version'], {
      encoding: 'utf-8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      // npm ships as .cmd on Windows; execFile can't spawn it directly
      // without shell:true. `npm` is not user-overridable here so the
      // command-injection risk is nil.
      shell: process.platform === 'win32',
    });
    const m = /(\d+\.\d+\.\d+(?:[.\-][\w.\-]+)?)/.exec(out);
    value = m ? m[1] : null;
  } catch {
    value = null;
  }
  _npmLatestCache = { value, at: Date.now() };
  return value;
}

export interface RunChecksOptions {
  /**
   * Opt-in: hit Anthropic's authorize endpoint with the scope set dario
   * would use on `accounts add`, and surface the server's verdict as a
   * check row. Default off — `dario doctor` without `--probe` is a
   * read-only local scan, no outbound traffic beyond what the other
   * checks already make (OAuth token refresh, CC binary version probe,
   * npm drift check). Enable with `dario doctor --probe`; costs one
   * GET to `claude.ai` and runs in parallel with the other checks.
   */
  probe?: boolean;
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
export async function runChecks(opts: RunChecksOptions = {}): Promise<Check[]> {
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

  // ---- Runtime TLS fingerprint (v3.23, direction #3)
  // Proxy mode terminates TLS in this process, so Bun-vs-Node is a
  // fingerprint axis Anthropic can read directly off the wire.
  try {
    const { detectRuntimeFingerprint } = await import('./runtime-fingerprint.js');
    const rt = detectRuntimeFingerprint();
    const status: CheckStatus = rt.status === 'bun-match' ? 'ok' : 'warn';
    checks.push({
      status,
      label: 'Runtime / TLS',
      detail: rt.hint ? `${rt.detail}. ${rt.hint}` : rt.detail,
    });
  } catch (err) {
    checks.push({
      status: 'warn',
      label: 'Runtime / TLS',
      detail: `check failed: ${(err as Error).message}`,
    });
  }

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

    // Stale-upstream probe: compare installed against npm's @latest.
    // One network hop (3s timeout, 60s in-process cache). Silent on
    // failure — no check row emitted — since a flaky network
    // shouldn't turn doctor's output noisy. Only emits when the
    // installed CC is strictly older than the npm latest.
    try {
      const npmLatest = probeNpmLatestCC();
      if (npmLatest && compareVersions(cc.version, npmLatest) < 0) {
        checks.push({
          status: 'info',
          label: 'CC upstream',
          detail:
            `npm latest is v${npmLatest} — installed is v${cc.version}. ` +
            `Run \`npm install -g @anthropic-ai/claude-code@latest\` to upgrade; ` +
            `dario's template will re-capture automatically on next startup.`,
        });
      }
    } catch { /* silent */ }
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

  // ---- Authorize-URL probe (opt-in, --probe).
  // One GET to the authorize endpoint with dario's effective OAuth config.
  // This is the single reliable signal for the class of bug that broke
  // #42 / #71 — Anthropic flipping server-side scope policy without
  // changing the CC binary. The nightly probe in check-cc-authorize-
  // probe.mjs hits Cloudflare challenges from CI IPs; running from a
  // user's machine bypasses that. No PII leaves: the probe uses a
  // fresh PKCE challenge and a dummy redirect_uri, and only reads the
  // status code / Location header / response body markers.
  if (opts.probe) {
    try {
      const cfg = await detectCCOAuthConfig();
      const result = await runAuthorizeProbe({
        clientId: cfg.clientId,
        authorizeUrl: cfg.authorizeUrl,
        scopes: cfg.scopes,
      });
      const status: CheckStatus =
        result.verdict === 'accepted'
          ? 'ok'
          : result.verdict === 'rejected'
          ? 'fail'
          : 'warn';
      const label = 'Authorize probe';
      const summary = `${result.scopeCount}-scope ${result.verdict} — ${result.reason}`;
      checks.push({ status, label, detail: summary });
      if (result.verdict !== 'accepted') {
        // On rejection: the URL is the one `accounts add` would open —
        // surface it so the user can paste and diff against `claude
        // /login`'s URL. On inconclusive (often Cloudflare from our
        // fetch-based probe — CF challenges non-browser clients
        // regardless of IP): the same URL pasted into the user's
        // browser bypasses CF since a real browser passes the
        // challenge. Either way, the URL is the actionable artifact.
        checks.push({ status: 'info', label: 'Probe URL', detail: result.probedUrl });
      }
    } catch (err) {
      checks.push({
        status: 'warn',
        label: 'Authorize probe',
        detail: `check failed: ${(err as Error).message}`,
      });
    }
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

  // ---- CC sub-agent (v3.26, direction #2)
  try {
    const { loadSubagentStatus } = await import('./subagent.js');
    const s = loadSubagentStatus();
    if (!s.agentsDirExists) {
      checks.push({ status: 'info', label: 'Sub-agent', detail: 'not installed (~/.claude/agents missing — Claude Code not installed?)' });
    } else if (!s.installed) {
      checks.push({ status: 'info', label: 'Sub-agent', detail: 'not installed — run `dario subagent install` to enable CC integration' });
    } else if (!s.current) {
      checks.push({
        status: 'warn',
        label: 'Sub-agent',
        detail: `installed v${s.fileVersion ?? 'unknown'}, does not match this dario — run \`dario subagent install\` to refresh`,
      });
    } else {
      checks.push({ status: 'ok', label: 'Sub-agent', detail: `installed v${s.fileVersion} at ${s.path}` });
    }
  } catch (err) {
    checks.push({ status: 'warn', label: 'Sub-agent', detail: `check failed: ${(err as Error).message}` });
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
