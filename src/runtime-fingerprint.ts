/**
 * Runtime TLS-fingerprint detector (direction #3 from the v3.22 roadmap).
 *
 * The Claude Code binary is a Bun-compiled standalone executable, so every
 * HTTPS request it makes goes out through Bun's BoringSSL-derived TLS stack.
 * That ClientHello (JA3/JA4 hash) is what Anthropic's TLS-layer classifier
 * actually sees on the wire.
 *
 * Dario has two transports with different exposure to this axis:
 *
 *   - **Shim mode** runs inside CC's own process (NODE_OPTIONS=--require),
 *     so its outbound fetch rides on CC's TLS stack by construction.
 *     Nothing to reconcile — the shim is always TLS-matched to CC.
 *
 *   - **Proxy mode** is a separate process holding its own TLS sessions
 *     to api.anthropic.com. Anthropic sees the proxy's TLS fingerprint,
 *     not the consumer client's. If the proxy runs under Node, the
 *     ClientHello is OpenSSL-shaped — distinct from Bun's BoringSSL shape.
 *     That's the JA3 gap this module flags.
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
  /** Running under Bun — TLS stack matches CC. */
  | 'bun-match'
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
      'Install Bun (https://bun.sh) so dario can auto-relaunch under it, or use shim mode ' +
      '(`dario shim -- claude …`) which runs inside CC\'s own process and inherits its TLS stack.',
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
