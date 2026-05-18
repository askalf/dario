/**
 * Config file foundation — v4.
 *
 * Persists user-tunable settings to `~/.dario/config.json` so the TUI
 * can read + write them without having to manage shell scripts. Establishes
 * the precedence chain that every effective value passes through:
 *
 *   defaults  <  config.json  <  env var  <  CLI flag
 *
 * Existing CLI flags + env vars continue to work unchanged. The config
 * file is purely additive — a missing file resolves to defaults, exactly
 * as v3 already behaved (since v3 had no config file).
 *
 * Atomic write: write to `config.json.tmp`, fsync, rename. Same primitive
 * shape `atomicWriteJson` in src/live-fingerprint.ts uses for the
 * captured CC template.
 *
 * Unknown keys in the loaded file are preserved (forward-compat for
 * future schema versions); validation is best-effort, not strict — a
 * corrupt or partial file falls back to defaults rather than aborting
 * the process.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Bumped on any incompatible shape change. v4.0.0 ships schema v1. A
 * future shape change would either add a new optional field (no bump)
 * or rename / restructure (bump to v2 with a migration in `loadConfig`).
 */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * Default `~/.dario/config.json` location. Override in tests via
 * `loadConfig(path)` / `saveConfig(path, …)`.
 */
export const DEFAULT_CONFIG_PATH = join(homedir(), '.dario', 'config.json');

/**
 * Every user-tunable setting. Grouped into sub-objects when the knobs
 * cluster naturally (pacing, thinkTime, session, queue) so the TUI's
 * Config tab can render each cluster as a folder without extra glue.
 *
 * Optional everywhere — a partially-populated config file is valid; the
 * proxy fills in defaults for whatever's absent.
 */
export interface DarioConfig {
  /** Schema version of this file. Required for forward-compat. */
  version: number;

  // Networking
  port?: number;
  host?: string;

  // Mode selectors
  model?: string | null;
  passthrough?: boolean;
  preserveTools?: boolean;
  hybridTools?: boolean;
  mergeTools?: boolean;
  noAutoDetect?: boolean;

  // Fingerprint / TLS
  strictTls?: boolean;
  strictTemplate?: boolean;
  noLiveCapture?: boolean;
  drainOnClose?: boolean;

  // Behavioral stealth — single-flag preset that nudges the clusters
  // below away from zero
  stealth?: boolean;

  // Pacing — floor + jitter between upstream requests
  pacing?: {
    minMs?: number;
    jitterMs?: number;
  };

  // Think time — post-response read-time before the next request
  thinkTime?: {
    baseMs?: number;
    perTokenMs?: number;
    jitterMs?: number;
    maxMs?: number;
  };

  // Session start — one-shot startup latency
  sessionStart?: {
    minMs?: number;
    jitterMs?: number;
  };

  // Session lifecycle
  session?: {
    idleRotateMs?: number;
    rotateJitterMs?: number;
    maxAgeMs?: number | null;
    perClient?: boolean;
  };

  // Request queue
  queue?: {
    maxConcurrent?: number | null;
    maxQueued?: number | null;
    timeoutMs?: number | null;
  };

  // Per-request overrides
  effort?: string | null;
  maxTokens?: number | 'client' | null;

  // Beta flag allow-list (always-forward)
  passthroughBetas?: string[];

  // Custom system prompt resolver — verbatim | partial | aggressive | <file path>
  systemPrompt?: string | null;

  preserveOrchestrationTags?: boolean;

  // Diagnostics
  logFile?: string | null;

  /**
   * Overage-guard — halt the proxy on the first response carrying
   * `representative-claim: overage`. Subscribers should never see a
   * single overage hit during normal operation; one means something
   * is wrong (wire-shape drift, classifier change, account misconfig)
   * and continuing to forward requests bleeds against per-token
   * billing. See dario#288.
   *
   * `behavior: 'halt'`  — return 503 with an Anthropic-shaped error
   *                       body until cooldown expires or `dario resume`
   *                       runs. Default.
   * `behavior: 'warn'`  — emit the SSE event + OS notification but
   *                       leave proxy behavior unchanged.
   *
   * `cooldownMs` — auto-resume delay after a halt. 30 min default.
   *
   * `notifyOs` — best-effort native desktop notification on halt
   *              (osascript/notify-send/BurntToast); terminal BEL is
   *              the unconditional floor.
   */
  overageGuard?: {
    enabled?: boolean;
    behavior?: 'halt' | 'warn';
    cooldownMs?: number;
    notifyOs?: boolean;
  };
}

/**
 * Defaults match the v3.x CLI flag defaults exactly. Any value not
 * specified in config.json resolves to its corresponding default here.
 * Updates to a flag default MUST land here too so they stay in sync.
 */
export function defaultConfig(): DarioConfig {
  return {
    version: CONFIG_SCHEMA_VERSION,
    port: 3456,
    host: '127.0.0.1',
    model: null,
    passthrough: false,
    preserveTools: false,
    hybridTools: false,
    mergeTools: false,
    noAutoDetect: false,
    strictTls: false,
    strictTemplate: false,
    noLiveCapture: false,
    drainOnClose: false,
    stealth: false,
    pacing: { minMs: 500, jitterMs: 0 },
    thinkTime: { baseMs: 0, perTokenMs: 0, jitterMs: 0, maxMs: 30_000 },
    sessionStart: { minMs: 0, jitterMs: 0 },
    session: {
      idleRotateMs: 900_000,
      rotateJitterMs: 0,
      maxAgeMs: null,
      perClient: false,
    },
    queue: { maxConcurrent: null, maxQueued: null, timeoutMs: null },
    effort: null,
    maxTokens: null,
    passthroughBetas: [],
    systemPrompt: null,
    preserveOrchestrationTags: false,
    logFile: null,
    overageGuard: {
      enabled: true,
      behavior: 'halt',
      cooldownMs: 30 * 60 * 1000,
      notifyOs: true,
    },
  };
}

/**
 * Load the config file at `path` (default ~/.dario/config.json).
 *
 * Returns `{ config, source }` where `source` describes the load outcome
 * for the caller's UI:
 *
 *   - 'file'    — successfully loaded
 *   - 'missing' — file doesn't exist; defaults returned (not an error)
 *   - 'invalid' — file exists but parse / shape check failed; defaults
 *                 returned. The TUI surfaces this so the user knows
 *                 their saved settings were ignored.
 *
 * The loaded shape is type-checked field-by-field: unknown keys pass
 * through (forward-compat), known keys with wrong types are dropped.
 * Strict validation would force a config migration on every shape
 * tweak; loose-but-typed lets the file evolve without breaking older
 * dario installs that haven't been restarted.
 */
export function loadConfig(path: string = DEFAULT_CONFIG_PATH): {
  config: DarioConfig;
  source: 'file' | 'missing' | 'invalid';
  error?: string;
} {
  if (!existsSync(path)) {
    return { config: defaultConfig(), source: 'missing' };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return {
      config: defaultConfig(),
      source: 'invalid',
      error: `read failed: ${(err as Error).message}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      config: defaultConfig(),
      source: 'invalid',
      error: `JSON parse failed: ${(err as Error).message}`,
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      config: defaultConfig(),
      source: 'invalid',
      error: `top-level value is not an object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
    };
  }
  // Future schema bumps: dispatch on parsed.version here and run the
  // appropriate migration. For now we accept any version field but
  // pass the rest through field-by-field validation.
  const typed = sanitize(parsed as Record<string, unknown>);
  // Merge over defaults so callers always get a fully-populated shape.
  return {
    config: mergeOver(defaultConfig(), typed),
    source: 'file',
  };
}

/**
 * Atomically write `config` to `path`. Writes to `<path>.tmp`, then
 * renames into place — guarantees a reader never observes a half-written
 * file. Creates parent directories if missing.
 *
 * Throws on permission / disk failures (caller handles + surfaces to
 * the TUI's status line). Does NOT throw on a no-op rewrite of the
 * same content; that's a cheap idempotent path.
 */
export function saveConfig(
  path: string = DEFAULT_CONFIG_PATH,
  config: DarioConfig,
): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  const json = JSON.stringify(
    { ...config, version: CONFIG_SCHEMA_VERSION },
    null,
    2,
  ) + '\n';
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, json, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the temp file so we don't leave debris.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Deep-merge `over` into `base`, preferring `over` values where defined.
 * Nested objects are merged recursively; arrays and primitives are
 * replaced wholesale (no array-element merge — that'd be surprising).
 *
 * `undefined` in `over` is treated as "absent" and falls through to
 * the `base` value. `null` is a real value and overrides.
 */
export function mergeOver<T extends object>(base: T, over: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) {
      // Recurse into nested object groups (pacing, thinkTime, …) so a
      // partial override on one sub-field doesn't wipe siblings.
      out[k] = mergeOver(
        out[k] as Record<string, unknown>,
        v as Partial<Record<string, unknown>>,
      );
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * Resolve the effective config: load file, layer env vars on top, layer
 * CLI flags on top.
 *
 *   defaults  <  config.json  <  env  <  cli
 *
 * `cliOverrides` and `envOverrides` are partial — only the keys the
 * caller actually wants to override should be set. `undefined` keys
 * are skipped, so the existing flag parsers in cli.ts can pass through
 * their normalized output without filtering nulls.
 */
export function resolveConfig(opts: {
  path?: string;
  envOverrides?: Partial<DarioConfig>;
  cliOverrides?: Partial<DarioConfig>;
}): { config: DarioConfig; source: 'file' | 'missing' | 'invalid'; error?: string } {
  const fromFile = loadConfig(opts.path);
  const withEnv = mergeOver(fromFile.config, opts.envOverrides ?? {});
  const withCli = mergeOver(withEnv, opts.cliOverrides ?? {});
  return { ...fromFile, config: withCli };
}

// ── internals ────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Field-by-field type-check. Drops keys whose values don't match the
 * expected type — better to silently fall back to a default than to
 * abort startup on a stray manually-edited typo. Unknown top-level
 * keys pass through unchanged (forward-compat for future fields).
 */
function sanitize(parsed: Record<string, unknown>): DarioConfig {
  const out: DarioConfig = { version: CONFIG_SCHEMA_VERSION };
  const pickNumber = (k: string) => typeof parsed[k] === 'number' && Number.isFinite(parsed[k]) ? (parsed[k] as number) : undefined;
  const pickBool = (k: string) => typeof parsed[k] === 'boolean' ? (parsed[k] as boolean) : undefined;
  const pickString = (k: string) => typeof parsed[k] === 'string' ? (parsed[k] as string) : undefined;
  const pickStringOrNull = (k: string) => {
    if (parsed[k] === null) return null;
    if (typeof parsed[k] === 'string') return parsed[k] as string;
    return undefined;
  };
  const pickNumberOrNull = (k: string) => {
    if (parsed[k] === null) return null;
    if (typeof parsed[k] === 'number' && Number.isFinite(parsed[k])) return parsed[k] as number;
    return undefined;
  };

  if (typeof parsed.version === 'number') out.version = parsed.version;
  if (pickNumber('port') !== undefined) out.port = pickNumber('port');
  if (pickString('host') !== undefined) out.host = pickString('host');

  const model = pickStringOrNull('model');
  if (model !== undefined) out.model = model;

  for (const k of ['passthrough', 'preserveTools', 'hybridTools', 'mergeTools',
                   'noAutoDetect', 'strictTls', 'strictTemplate', 'noLiveCapture',
                   'drainOnClose', 'stealth', 'preserveOrchestrationTags'] as const) {
    const v = pickBool(k);
    // Each `k` is a literal boolean-typed field on DarioConfig (verified
    // by the `as const` tuple type above), so the assignment is sound
    // — we route through `unknown` because TS can't narrow the union
    // of literal keys to a single typed assignment at compile time.
    if (v !== undefined) (out as unknown as Record<string, boolean>)[k] = v;
  }

  // Nested groups — sanitize each, drop if not an object
  if (isPlainObject(parsed.pacing)) {
    out.pacing = {};
    if (typeof parsed.pacing.minMs === 'number') out.pacing.minMs = parsed.pacing.minMs;
    if (typeof parsed.pacing.jitterMs === 'number') out.pacing.jitterMs = parsed.pacing.jitterMs;
  }
  if (isPlainObject(parsed.thinkTime)) {
    out.thinkTime = {};
    for (const k of ['baseMs', 'perTokenMs', 'jitterMs', 'maxMs'] as const) {
      if (typeof parsed.thinkTime[k] === 'number') {
        out.thinkTime[k] = parsed.thinkTime[k] as number;
      }
    }
  }
  if (isPlainObject(parsed.sessionStart)) {
    out.sessionStart = {};
    if (typeof parsed.sessionStart.minMs === 'number') out.sessionStart.minMs = parsed.sessionStart.minMs;
    if (typeof parsed.sessionStart.jitterMs === 'number') out.sessionStart.jitterMs = parsed.sessionStart.jitterMs;
  }
  if (isPlainObject(parsed.session)) {
    out.session = {};
    if (typeof parsed.session.idleRotateMs === 'number') out.session.idleRotateMs = parsed.session.idleRotateMs;
    if (typeof parsed.session.rotateJitterMs === 'number') out.session.rotateJitterMs = parsed.session.rotateJitterMs;
    if (parsed.session.maxAgeMs === null || typeof parsed.session.maxAgeMs === 'number') {
      out.session.maxAgeMs = parsed.session.maxAgeMs as number | null;
    }
    if (typeof parsed.session.perClient === 'boolean') out.session.perClient = parsed.session.perClient;
  }
  if (isPlainObject(parsed.queue)) {
    out.queue = {};
    for (const k of ['maxConcurrent', 'maxQueued', 'timeoutMs'] as const) {
      const v = parsed.queue[k];
      if (v === null || (typeof v === 'number' && Number.isFinite(v))) {
        out.queue[k] = v as number | null;
      }
    }
  }

  const effort = pickStringOrNull('effort');
  if (effort !== undefined) out.effort = effort;

  // maxTokens is special — it's a number, the string 'client', or null
  if (parsed.maxTokens === null) out.maxTokens = null;
  else if (parsed.maxTokens === 'client') out.maxTokens = 'client';
  else {
    const n = pickNumber('maxTokens');
    if (n !== undefined) out.maxTokens = n;
  }

  if (Array.isArray(parsed.passthroughBetas)) {
    out.passthroughBetas = (parsed.passthroughBetas as unknown[])
      .filter((x): x is string => typeof x === 'string');
  }

  const sysPrompt = pickStringOrNull('systemPrompt');
  if (sysPrompt !== undefined) out.systemPrompt = sysPrompt;

  const logFile = pickStringOrNull('logFile');
  if (logFile !== undefined) out.logFile = logFile;

  if (isPlainObject(parsed.overageGuard)) {
    out.overageGuard = {};
    if (typeof parsed.overageGuard.enabled === 'boolean') {
      out.overageGuard.enabled = parsed.overageGuard.enabled;
    }
    if (parsed.overageGuard.behavior === 'halt' || parsed.overageGuard.behavior === 'warn') {
      out.overageGuard.behavior = parsed.overageGuard.behavior;
    }
    if (typeof parsed.overageGuard.cooldownMs === 'number'
        && Number.isFinite(parsed.overageGuard.cooldownMs)
        && parsed.overageGuard.cooldownMs >= 0) {
      out.overageGuard.cooldownMs = parsed.overageGuard.cooldownMs;
    }
    if (typeof parsed.overageGuard.notifyOs === 'boolean') {
      out.overageGuard.notifyOs = parsed.overageGuard.notifyOs;
    }
  }

  // Silence unused-warning helper.
  void pickNumberOrNull;

  return out;
}
