/**
 * Runtime TLS-fingerprint detector (direction #3 from the v3.22 roadmap).
 *
 * The Claude Code binary is a Bun-compiled standalone executable, so every
 * HTTPS request it makes goes out through Bun's BoringSSL-derived TLS stack.
 * That ClientHello (JA3/JA4 hash) is what Anthropic's TLS-layer classifier
 * actually sees on the wire.
 *
 * The proxy is a separate process holding its own TLS sessions to
 * api.anthropic.com. Anthropic sees the proxy's TLS fingerprint, not the
 * consumer client's. If the proxy runs under Node, the ClientHello is
 * OpenSSL-shaped — distinct from Bun's BoringSSL shape. That's the JA3
 * gap this module flags.
 *
 * Mitigation today: dario auto-relaunches under Bun when Bun is on PATH
 * (see top of `src/cli.ts`). When Bun isn't available the auto-relaunch
 * is a silent no-op, so proxy mode silently runs on Node's TLS stack
 * with no indication to the operator. This module makes the runtime
 * status a first-class check: `dario doctor` reports it, proxy startup
 * warns when the axis is mismatched, and `--strict-tls` hard-fails
 * instead of silently running with a divergent fingerprint.
 *
 * Pure-function: every input is passed in explicitly so tests can
 * exercise each runtime combination without spawning processes.
 */

import { execFileSync } from 'node:child_process';

/** Canonical buckets the caller pivots on. */
export type RuntimeFingerprintStatus =
  /** Running under Bun ≥ the JA3-verified floor — TLS ClientHello matches CC. */
  | 'bun-match'
  /**
   * Running under Bun, but at a version below the JA3-verified floor: being on
   * Bun is necessary but not sufficient. Older Bun ships an older BoringSSL
   * whose ClientHello is not confirmed to match CC's (measured divergent on
   * Bun 1.0.9 — see #813). Treated as a warn so an old Bun on PATH can't
   * report a false-green match while emitting a divergent JA3.
   */
  | 'bun-ja3-unverified'
  /** Running under Node, Bun available on PATH but auto-relaunch was bypassed. */
  | 'bun-bypassed'
  /** Running under Node, Bun not installed. */
  | 'node-only';

export interface RuntimeFingerprint {
  status: RuntimeFingerprintStatus;
  /** 'bun' or 'node' — which runtime this process is actually on. */
  runtime: 'bun' | 'node';
  /** Version string from the runtime (e.g. "1.1.30" or "v20.11.1"). */
  runtimeVersion: string;
  /** Bun version discovered on PATH, if any. undefined when runtime==='bun' or bun-not-found. */
  availableBunVersion?: string;
  /** Why auto-relaunch didn't fire when `status === 'bun-bypassed'`. */
  bypassReason?: 'DARIO_NO_BUN' | 'unknown';
  /** Human-readable one-line explanation for the check label. */
  detail: string;
  /** Actionable hint when status !== 'bun-match'. undefined otherwise. */
  hint?: string;
}

/**
 * Probe the Bun binary on PATH without relaunching. Returns undefined
 * when bun isn't installed or the version probe fails for any reason
 * (timeout, non-zero exit, etc.). Kept synchronous to match cli.ts's
 * pre-import flow; doctor.ts is the only other caller and is fine with
 * the (~sub-100ms) cost when Bun is installed.
 */
export function probeBunVersion(): string | undefined {
  try {
    const out = execFileSync('bun', ['--version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
      encoding: 'utf-8',
    });
    const trimmed = out.trim();
    // `bun --version` prints just the version like "1.1.30". Reject anything
    // longer than a sanity threshold so an unrelated `bun` binary can't
    // poison the detection.
    if (trimmed.length > 0 && trimmed.length < 32 && /^[0-9]/.test(trimmed)) {
      return trimmed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lowest public Bun version whose TLS ClientHello (JA3) is *measured* to match
 * the Bun/BoringSSL fingerprint Claude Code presents on the wire. Empirical
 * basis (#813, macOS arm64): CC 2.1.214 embeds the Bun canary line and hashes
 * to JA3 `e97f5146a7009cc2918b50e903b6ff8d`; bare public Bun 1.3.14 and canary
 * reproduce it byte-for-byte, while Bun 1.0.9 diverges (adds 3DES, ECH,
 * padding → `2ae7eb4b…`). The window between 1.0.9 and 1.3.14 is unmeasured,
 * so anything below this floor is reported unverified rather than a green match.
 */
export const JA3_VERIFIED_BUN_FLOOR = '1.3.14';

/**
 * True when Bun `version` is at or above `floor`. Parses the leading
 * `major.minor.patch` and ignores any pre-release/`-canary…` suffix, so Bun's
 * canary tags (e.g. `1.4.0-canary.x`) compare as their base triple. Returns
 * `undefined` when either string can't be parsed — the caller decides how to
 * treat "can't tell" (we keep those as a best-effort match rather than warn).
 */
export function bunVersionMeetsJa3Floor(
  version: string,
  floor: string = JA3_VERIFIED_BUN_FLOOR,
): boolean | undefined {
  const parse = (v: string): [number, number, number] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
  };
  const a = parse(version);
  const b = parse(floor);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true; // equal versions meet the floor
}

/**
 * Synthesize the TLS-fingerprint status from three inputs. All three are
 * passed explicitly so tests can cover every combination without touching
 * the real environment. Production callers pass
 *   `classifyRuntimeFingerprint(typeof Bun !== 'undefined', probeBunVersion(), process.env)`.
 *
 * The `env` parameter is read-only — this function never mutates it.
 */
export function classifyRuntimeFingerprint(
  runningUnderBun: boolean,
  availableBunVersion: string | undefined,
  env: Record<string, string | undefined>,
  nodeVersion: string = process.version,
): RuntimeFingerprint {
  if (runningUnderBun) {
    // When we're under Bun, we expose the Bun version if globalThis.Bun.version
    // is readable; we don't require a separate probe. The caller passes the
    // resolved version string as `availableBunVersion` in the bun case.
    const bunVer = availableBunVersion ?? 'unknown';
    // Being on Bun is necessary but NOT sufficient: only Bun ≥ the JA3-verified
    // floor is measured to reproduce CC's ClientHello (#813). A readable version
    // below the floor is the false-green case — dario auto-relaunches into an
    // old Bun on PATH and would otherwise report a match while emitting a
    // divergent JA3. An unreadable version (rare; Bun almost always exposes
    // .version) has nothing to check, so we leave it as a best-effort match.
    if (bunVer !== 'unknown' && bunVersionMeetsJa3Floor(bunVer) === false) {
      return {
        status: 'bun-ja3-unverified',
        runtime: 'bun',
        runtimeVersion: bunVer,
        detail: `Bun v${bunVer} — under Bun, but its TLS ClientHello (JA3) is not verified to match Claude Code (known-good ≥ v${JA3_VERIFIED_BUN_FLOOR})`,
        hint: `Upgrade Bun to ≥ v${JA3_VERIFIED_BUN_FLOOR} (https://bun.sh); older Bun ships an older BoringSSL whose ClientHello diverges from Claude Code's.`,
      };
    }
    return {
      status: 'bun-match',
      runtime: 'bun',
      runtimeVersion: bunVer,
      detail: `Bun v${bunVer} — TLS fingerprint matches Claude Code`,
    };
  }
  if (availableBunVersion !== undefined) {
    const reason: 'DARIO_NO_BUN' | 'unknown' =
      env.DARIO_NO_BUN ? 'DARIO_NO_BUN' : 'unknown';
    return {
      status: 'bun-bypassed',
      runtime: 'node',
      runtimeVersion: nodeVersion,
      availableBunVersion,
      bypassReason: reason,
      detail: `Node ${nodeVersion} — Bun v${availableBunVersion} on PATH but auto-relaunch bypassed (${reason})`,
      hint:
        reason === 'DARIO_NO_BUN'
          ? 'Unset DARIO_NO_BUN to auto-relaunch under Bun on the next invocation.'
          : 'Run dario fresh (no inherited DARIO_NO_BUN) so auto-relaunch can fire.',
    };
  }
  return {
    status: 'node-only',
    runtime: 'node',
    runtimeVersion: nodeVersion,
    detail: `Node ${nodeVersion} — Bun not installed; proxy-mode TLS fingerprint diverges from Claude Code`,
    hint:
      'Install Bun (https://bun.sh) so dario can auto-relaunch under it and its TLS ClientHello ' +
      'matches Claude Code\'s.',
  };
}

/**
 * Convenience wrapper that reads the current process state. doctor.ts
 * calls this once; tests do not — they exercise classifyRuntimeFingerprint
 * directly with synthetic inputs.
 */
export function detectRuntimeFingerprint(): RuntimeFingerprint {
  const bunGlobal = (globalThis as { Bun?: { version?: string } }).Bun;
  const runningUnderBun = typeof bunGlobal?.version === 'string';
  if (runningUnderBun) {
    return classifyRuntimeFingerprint(true, bunGlobal?.version, process.env);
  }
  const probed = probeBunVersion();
  return classifyRuntimeFingerprint(false, probed, process.env);
}

/**
 * One-shot Bun installer. Used by `dario doctor --bun-bootstrap` to
 * close the gap between "Bun warn surfaced" and "Bun on PATH" without
 * making the user copy-paste an install line. Picks the platform-correct
 * upstream installer:
 *
 *   - Windows: `powershell -c "irm https://bun.sh/install.ps1 | iex"`
 *   - macOS / Linux: `curl -fsSL https://bun.sh/install | bash`
 *
 * Streams installer output to the parent stdio so the user sees what's
 * happening (the install can take 10-30 s on a slow link). Returns the
 * exit code; non-zero is surfaced by the caller as a fail row.
 *
 * Pure delegation to the upstream Bun installer — dario does not vendor
 * or self-host the binary. If the user wants a pinned version or doesn't
 * want to run a curl-to-shell installer, the doctor warn line still
 * points at https://bun.sh for manual install.
 *
 * Pinned to bun.sh (not bun.com) because PowerShell's `irm` doesn't
 * follow the bun.com → bun.sh 308 redirect; piping the redirect HTML
 * to `iex` then fails parse. bun.sh serves the install script directly.
 */
export async function bunBootstrap(): Promise<{ exitCode: number; runner: string }> {
  const { spawn } = await import('node:child_process');
  const isWindows = process.platform === 'win32';
  const runner = isWindows
    ? 'powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://bun.sh/install.ps1 | iex"'
    : 'curl -fsSL https://bun.sh/install | bash';

  return await new Promise<{ exitCode: number; runner: string }>((resolve) => {
    // Single-shell invocation so the pipe stages execute the way the
    // upstream installer expects. Avoids reimplementing the curl-pipe-bash
    // sequencing in Node primitives.
    const child = isWindows
      ? spawn('powershell', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-Command', 'irm https://bun.sh/install.ps1 | iex',
        ], { stdio: 'inherit' })
      : spawn('bash', ['-lc', 'curl -fsSL https://bun.sh/install | bash'], { stdio: 'inherit' });

    child.on('error', () => resolve({ exitCode: 1, runner }));
    child.on('exit', (code) => resolve({ exitCode: code ?? 1, runner }));
  });
}
