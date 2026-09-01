/**
 * Live fingerprint extraction.
 *
 * At dario startup, spawn the user's actual `claude` binary against a
 * loopback MITM endpoint, capture the outbound /v1/messages request, and
 * use the captured system prompt / tools / agent identity as the template
 * replay source — instead of shipping a stale snapshot in
 * `cc-template-data.json`.
 *
 * The bundled snapshot remains as a fallback for users without CC installed
 * or when live capture fails. Template replay auto-heals on CC updates
 * without any user action.
 *
 * Security: the MITM endpoint only accepts connections from 127.0.0.1 and
 * only runs long enough to capture a single request. CC's OAuth token
 * never leaves the machine — we send CC to a loopback URL that CC itself
 * trusts because we set ANTHROPIC_BASE_URL in the child's environment.
 *
 * --------------------------------------------------------------------
 * "Hide in the population" roadmap (v3.13 → ?)
 * --------------------------------------------------------------------
 *
 * The fingerprint pipeline has historically cared about one axis: what
 * goes INSIDE the /v1/messages body (agent identity, system prompt, tool
 * list). That's only one fingerprint vector. Anthropic can (and likely
 * does) look at several others:
 *
 *   1. Header ORDER. Node's http module emits headers in alphabetical
 *      order via setHeader(). Undici preserves insertion order. Real CC
 *      uses undici with a specific insertion pattern. If dario sends
 *      headers in a different order than CC, the difference is trivially
 *      observable on the server side via the raw header array.
 *      → Captured as `header_order` below. Outbound proxy paths should
 *        use the captured order when rebuilding fetch() headers.
 *
 *   2. TLS ClientHello (JA3 / JA4 fingerprint). The cipher list, elliptic
 *      curves, extension order, and ALPN negotiation are determined by
 *      the TLS library, and Node's TLS (OpenSSL) produces a distinctive
 *      fingerprint that differs from any browser or from curl. Real CC
 *      running on top of Node has the Node JA3 — so we already match,
 *      provided both run on the same Node major. A cross-runtime worry
 *      surfaces when Anthropic ships Bun- or bundled-binary CC: at that
 *      point Node-dario and Bun-CC would JA-differ.
 *      → Mitigation: dario auto-relaunches under Bun when it's on PATH so
 *        the proxy's ClientHello matches CC's Bun/BoringSSL shape;
 *        `--strict-tls` refuses to start otherwise.
 *
 *   3. HTTP/2 frame ordering + SETTINGS parameters. Similar to TLS, this
 *      is controlled by the HTTP library. Node and undici produce a
 *      consistent H2 fingerprint. Matches as long as both ends run the
 *      same library.
 *
 *   4. Request timing distribution. Real CC sends requests with jitter
 *      driven by user typing, tool-call sequencing, and internal retry
 *      logic. Dario-through-a-client sends requests with jitter driven
 *      by WHATEVER client is on the other end (OpenClaw, Hermes, curl).
 *      That distribution differs from CC's. Anthropic could pattern-match
 *      "no inter-request jitter" as a fingerprint for automated usage.
 *      → Deferred. Adds latency for debatable gain. Analytics already
 *        tracks per-request timing — could drive a replay distribution
 *        later.
 *
 *   5. sessionId rotation cadence. CC rotates its internal session id
 *      on a specific cadence (observed: roughly once per conversation
 *      start, not per-request). Dario today uses a static session id
 *      from loadClaudeIdentity. A proxy that kept rotating sessionId
 *      randomly would stand out; a proxy that never rotates also stands
 *      out. Matching CC's cadence requires observing CC over a longer
 *      period than a single capture session.
 *      → Deferred. Requires a longer-running capture mode.
 *
 *   6. Request body field ordering. JSON is unordered, but the wire
 *      serialization IS ordered. Real CC uses a specific field order
 *      for /v1/messages (e.g., `model` before `messages` before
 *      `system` before `tools`). A proxy that serializes in a different
 *      order leaks its origin.
 *      → Worth matching. Cheap to implement — the template capture
 *        already produces a body we can walk to recover field order.
 *        Deferred to a follow-up.
 *
 * The concrete v3.13 move is (1): capture header_order and make it
 * available on the template so the outbound proxy paths can reproduce
 * it. Everything else is documented here as a roadmap so the next
 * contributor — or dario maintainer six months from now — can pick up
 * the right piece without re-deriving the threat model.
 */

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Cache-file schema version. Bump when `TemplateData` gains a required
 * field or changes shape in a way that would make older caches produce
 * wrong behavior if loaded verbatim. Mismatched caches are rejected at
 * load time so the fallback + next background refresh write a fresh one.
 */
export const CURRENT_SCHEMA_VERSION = 3;

export interface TemplateData {
  _version: string;
  _captured: string;
  _source?: 'bundled' | 'live';
  _schemaVersion?: number;
  /**
   * Every DISTINCT per-model system-prompt shape ever observed per variant
   * family, as full sha256 hex of the scrubbed text — the fix for the A/B
   * ping-pong (dario#1095). Anthropic serves alternative prompt arms for the
   * same model at the same CC version (fable flip-flopped between two
   * byte-stable shapes across four rebakes in 25h, 2026-08-23/24), so "the
   * capture differs from the baked arm" is NOT drift — only a shape absent
   * from this set is. The canonical arm dario replays stays in
   * system_prompt_variants; this set exists solely so the drift check and the
   * bake can tell a re-served known arm from a genuinely new prompt.
   */
  _variantShapeHashes?: Record<string, string[]>;
  agent_identity: string;
  system_prompt: string;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  tool_names: string[];
  /**
   * The exact order CC emitted HTTP headers in when it hit the capture
   * endpoint. Lowercased. Populated only from live captures — bundled
   * snapshots leave this undefined and callers fall back to their own
   * default order. Used by outbound proxy paths to reproduce CC's
   * header ordering instead of Node's alphabetical default.
   */
  header_order?: string[];
  /**
   * The `anthropic-beta` flag set CC sent on the captured request, verbatim.
   * Schema v2 (v3.19). Previously the proxy path hardcoded this — bumping
   * CC's beta list required a dario release. Now the proxy replays
   * whatever the live capture recorded. Falls back to
   * `'claude-code-20250219'` when undefined (bundled snapshots, older caches).
   */
  anthropic_beta?: string;
  /**
   * Selected static headers CC sent on the captured request. Scoped to
   * fingerprint-relevant keys — values that CC sets identically on every
   * request and that don't change per session (user-agent, anthropic-version,
   * x-app, x-stainless-*). Excludes auth (authorization), body-framing
   * (content-type, content-length, host), and session-scoped identifiers
   * (x-claude-code-session-id, x-client-request-id). Schema v2.
   */
  header_values?: Record<string, string>;
  /**
   * Top-level JSON key order from the captured /v1/messages body, in the
   * order CC emitted them. JSON is unordered as a type but the wire
   * serialization IS ordered — every field in the body is a potential
   * fingerprint if the order differs from CC's. Schema v3 (v3.22).
   *
   * Previously the proxy hardcoded the order as a comment in buildCCRequest;
   * replaying from the live capture means bumping CC's field order (or
   * adding a new field like `output_config`) no longer requires a dario
   * release. Falls back to the hardcoded build order when undefined.
   */
  body_field_order?: string[];
  /**
   * The newest installed-CC version this template snapshot has been verified
   * against. Present only on bundled snapshots (set by scripts/capture-and-bake.mjs
   * at bake time); absent on live captures (the live `_version` is already
   * the installed CC's version by construction). When a user runs a dario
   * release whose bundled fallback is meaningfully older than their installed
   * CC and live capture fails, loadTemplate warns using this field so the
   * operator knows they're on a stale shape. dario#76.
   */
  _supportedMaxTested?: string;
  /**
   * Per-model system-prompt variants, keyed by family token (`fable`,
   * `opus-5`, `sonnet-5`). CC ships several models a materially different
   * prompt than the shared base — measured on CC 2.1.220 (2026-07-25),
   * two byte-identical passes each: base (opus-4-8) 6664 chars, opus-5
   * 9990, sonnet-5 28156, fable-5 11084. Only variants that DIFFER from
   * the base are stored; a missing key falls back to the base.
   *
   * Populated by the bake only. A live capture is a single request on a
   * single model and can never produce this map, which is why loadTemplate
   * carries it forward from the bundle instead of letting the live cache
   * shadow it.
   */
  system_prompt_variants?: Record<string, string>;
  /**
   * Legacy single-variant slot, pre-variants-map bundles and any live cache
   * file written by an older dario. Folded into the map by promptVariantsOf().
   */
  system_prompt_fable?: string;
}

/**
 * The model both the bake and the runtime capture pin for the SHARED BASE
 * prompt. Without a pin, `claude --print` uses whichever model the user
 * configured as their default, so the captured "base" varied per machine
 * (this box defaults to Opus 5, whose prompt is ~50% larger than
 * opus-4-8's). Per-model divergence belongs in system_prompt_variants,
 * not in an uncontrolled base. capture-and-bake imports this so the two
 * paths cannot drift apart.
 */
export const TEMPLATE_BASE_MODEL = 'claude-opus-4-8';

/**
 * One model family CC ships a distinct system prompt to (dario#lock-step).
 */
export interface VariantFamily {
  /** Key into `system_prompt_variants`. */
  key: string;
  /** Model id the bake pins (via ANTHROPIC_MODEL) to capture this family. */
  captureModel: string;
  /** True when a lowercased model id belongs to this family. */
  matches: (model: string) => boolean;
}

/**
 * The model families CC ships a DIFFERENT system prompt than the shared
 * base, in matcher-precedence order (first match wins — fable stays ahead
 * of the `-5` arms so a hypothetical fable-5 never falls into them).
 *
 * This table is the single source of truth for dario#lock-step: the
 * runtime selection (cc-template.ts:systemPromptForModel), the bake's
 * capture loop (scripts/capture-and-bake.mjs), the doctor's coverage row,
 * and the template invariants all derive from it — the same reason
 * TEMPLATE_BASE_MODEL lives here. Before this table, the bake's model
 * list and the selection arms were maintained by hand in two files, the
 * exact divergence class that shipped tool_names ≠ tools twice.
 *
 * Adding a family here is safe even if it turns out to share the base
 * prompt: the bake stores a variant only when the capture differs.
 */
export const VARIANT_FAMILIES: readonly VariantFamily[] = [
  { key: 'fable', captureModel: 'claude-fable-5', matches: (m) => m.includes('fable') },
  // `-5` bounded so a future opus-50 doesn't match, and so the `[1m]` tag
  // (which is not a digit) still does.
  { key: 'opus-5', captureModel: 'claude-opus-5', matches: (m) => /opus-5(?!\d)/.test(m) },
  { key: 'sonnet-5', captureModel: 'claude-sonnet-5', matches: (m) => /sonnet-5(?!\d)/.test(m) },
];

/**
 * Families from VARIANT_FAMILIES that `t` carries no variant for — i.e.
 * models that would silently get the shared BASE prompt instead of CC's
 * model-specific one. Non-empty on a healthy current bundle means the
 * lock-step is degraded: a bad bake, an unreadable bundle behind a live
 * capture, or a pre-variants live cache shadowing the bundle.
 */
export function missingVariantFamilies(t: TemplateData): string[] {
  const have = promptVariantsOf(t);
  return VARIANT_FAMILIES.filter((f) => !(typeof have[f.key] === 'string' && have[f.key].length > 0))
    .map((f) => f.key);
}

/**
 * A template's prompt variants, with the legacy `system_prompt_fable` slot
 * folded in under the `fable` key. Callers should always go through this
 * rather than reading either field directly.
 */
/** Full sha256 hex of one prompt-variant shape — the identity the A/B shape
 *  memory (`_variantShapeHashes`) is keyed on. Full digest on purpose: these
 *  are long-lived identifiers in a committed file. */
export function variantShapeHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Classify a freshly captured variant shape against the baked canonical and
 * the known-shape memory. 'canonical' = byte-equal to what is baked;
 * 'known-alt' = a previously observed A/B arm being re-served (NOT drift —
 * rebaking onto it is what caused the #1095 ping-pong); 'new' = a shape this
 * bundle has never seen, i.e. real drift worth a rebake.
 */
export function classifyVariantShape(
  capturedText: string,
  canonicalText: string | undefined,
  knownHashes: string[] | undefined,
): 'canonical' | 'known-alt' | 'new' {
  if (canonicalText !== undefined && capturedText === canonicalText) return 'canonical';
  if ((knownHashes ?? []).includes(variantShapeHash(capturedText))) return 'known-alt';
  return 'new';
}

export function promptVariantsOf(t: TemplateData): Record<string, string> {
  const out: Record<string, string> = { ...(t.system_prompt_variants ?? {}) };
  if (out.fable === undefined && typeof t.system_prompt_fable === 'string' && t.system_prompt_fable.length > 0) {
    out.fable = t.system_prompt_fable;
  }
  return out;
}

/**
 * Carry the bundle's prompt variants onto a live-captured template.
 *
 * loadTemplate used to return the live cache verbatim, and a live capture
 * carries no variants — so a fresh cache silently reverted every
 * model-specific prompt to the base. That made the baked fable variant
 * inert on exactly the machines that have CC installed (verified live:
 * CC_SYSTEM_PROMPT_FABLE === CC_SYSTEM_PROMPT with a fresh cache present).
 * Variants the live template already has win, so a future per-model live
 * capture supersedes the bake without another change here.
 */
/**
 * Tools CC only ships on a specific platform. A capture sees only the host it
 * ran on, so both the bundle and any live capture must be re-unioned against
 * the other platforms' names before use. Filtered back down to the running
 * platform at request time by filterToolsForPlatform().
 *
 * PowerShell shipped in CC v2.1.116 on Windows; POSIX CC installs do not
 * advertise it. As of CC v2.1.162 Glob/Grep are the same shape: Windows CC
 * advertises them, POSIX CC drops them and steers the agent to shell
 * `find`/`grep` instead. Registering them here filters them to win32 clients
 * AND keeps a POSIX capture from dropping them out of the union — the v4.8.28
 * regression, where a Linux runner re-baked the bundle down to 28 tools.
 * Add new platform-scoped tools here as CC adds them.
 */
export const PLATFORM_ONLY_TOOLS: Record<string, Set<string>> = {
  win32: new Set(['PowerShell', 'Glob', 'Grep']),
};

/**
 * Tools CC only advertises in an INTERACTIVE session. Captures spawn CC
 * headlessly (`claude --print -p hi`), and CC v2.1.187 dropped these plan-mode /
 * clarification tools in `--print` mode — so a fresh headless capture no longer
 * carries them even though every real interactive CC client still advertises
 * them. Unlike PLATFORM_ONLY_TOOLS these are NOT platform-filtered: they stay in
 * the tool set on every host so a client that declares them is always honored.
 * Add new interactive-only tools here as CC adds them.
 */
export const INTERACTIVE_ONLY_TOOLS: Set<string> = new Set([
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
]);

/**
 * Tools CC advertises only under some runtime configurations. Unlike
 * INTERACTIVE_ONLY_TOOLS (absent because the capture is headless), these come
 * and go with CC's REMOTE config for the same capture mode: the 2026-08-11 bake
 * on CC v2.1.232 captured all four headlessly, and the 2026-08-15 bake on
 * v2.1.233 captured none of them — while TaskOutput/TaskStop, the rest of the
 * task subsystem, stayed put. That is the v4.2.1 drift class (same binary,
 * different wire shape via remote configuration), not a signal that CC retired
 * the tools.
 *
 * Removing a name here is a deliberate act: it means CC genuinely retired the
 * tool, and it should be paired with the capture evidence that says so.
 */
export const CONFIG_SCOPED_TOOLS: Set<string> = new Set([
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
]);

/** Why a given tool was preserved — used for logging at bake time. */
export type PreservedToolReason = 'platform' | 'interactive' | 'config-scoped';

/**
 * Decide whether `name` must be preserved into a capture taken on `platform`,
 * and say why. The single definition of the superset rule.
 *
 * The cost of the two directions is asymmetric, which is what settles it. A
 * stale entry is INERT: buildCCRequest advertises the intersection of the tool
 * set with what the CLIENT declared, so an entry no client declares is never
 * sent. Dropping one is NOT inert — CC_NATIVE_NAMES_UNION is derived from the
 * loaded template, so a client that does declare the tool stops identity-
 * mapping, falls into the unmapped round-robin, and has its history tool_use
 * blocks renamed onto a fallback slot with junk arguments (the v4.8.93
 * regression).
 */
export function preservedToolReason(name: string, platform: string): PreservedToolReason | null {
  for (const [plat, names] of Object.entries(PLATFORM_ONLY_TOOLS)) {
    if (names.has(name) && plat !== platform) return 'platform';
  }
  if (INTERACTIVE_ONLY_TOOLS.has(name)) return 'interactive';
  if (CONFIG_SCOPED_TOOLS.has(name)) return 'config-scoped';
  return null;
}

/**
 * Names the fallback bundle carries that `captureTools` lacks and NO
 * preservation set classifies. Empty on every capture measured so far
 * (win32 + linux, CC 2.1.236 and 2.1.241 — dario#1062's report did not
 * reproduce), but the roster is remote-config-shaped: the config-scoped four
 * flipped between the 8/11 and 8/15 bakes, and WaitForMcpServers appeared in
 * one capture and vanished in the next, minutes apart, same binary. So the
 * day this goes non-empty must be LOUD, not a silent shrink of
 * CC_NATIVE_NAMES_UNION: capture-and-bake refuses to write the bundle, and
 * the live path logs it. Note the win32 subtlety: a win32-only tool missing
 * from a WIN32 capture is unclassified (it was expected there) — that is a
 * real drop, not a platform artifact.
 */
export function unclassifiedToolDrops<T extends { name: string }>(
  captureTools: T[],
  fallbackTools: T[],
  platform: string,
): string[] {
  const have = new Set(captureTools.map((t) => t.name));
  return fallbackTools
    .filter((t) => !have.has(t.name) && preservedToolReason(t.name, platform) === null)
    .map((t) => t.name);
}

/**
 * Re-union `capture.tools` with any tool `fallback` carries that the capture is
 * required to keep (see preservedToolReason). Returns the merged tool array,
 * CC's alphabetical wire order restored, plus what was preserved and why.
 *
 * This is the rule the bake has always applied to the previous bundle. It must
 * apply to a LIVE capture too: `loadTemplate` prefers a fresh live cache, the
 * cache refreshes on a 24h TTL, and the capture is headless — so without this,
 * every dario install with CC present degrades its own tool set within a day
 * of running, and CI never sees it because CI has no live cache (#1035).
 */
export function mergePreservedTools<T extends { name: string }>(
  captureTools: T[],
  fallbackTools: T[],
  platform: string,
): { tools: T[]; preserved: Array<{ name: string; reason: PreservedToolReason }> } {
  const have = new Set(captureTools.map((t) => t.name));
  const preserved: Array<{ name: string; reason: PreservedToolReason }> = [];
  const additions: T[] = [];
  for (const tool of fallbackTools) {
    if (have.has(tool.name)) continue;
    const reason = preservedToolReason(tool.name, platform);
    if (!reason) continue;
    additions.push(tool);
    preserved.push({ name: tool.name, reason });
    have.add(tool.name);
  }
  if (additions.length === 0) return { tools: captureTools, preserved };
  // CC sends tools alphabetically by name — sort after merge so preserved tools
  // insert at their natural position rather than appending at the end.
  return {
    tools: [...captureTools, ...additions].sort((a, b) => a.name.localeCompare(b.name)),
    preserved,
  };
}

export function withBundledVariants(live: TemplateData): TemplateData {
  let bundled: TemplateData;
  try {
    bundled = loadBundledTemplate({ silent: true });
  } catch {
    return live; // bundle unreadable — better the base prompt than a throw
  }
  const merged = { ...promptVariantsOf(bundled), ...promptVariantsOf(live) };
  if (Object.keys(merged).length === 0) return live;
  return { ...live, system_prompt_variants: merged };
}

/**
 * Where the live fingerprint cache lives. Resolved per call and overridable
 * with DARIO_LIVE_TEMPLATE_CACHE.
 *
 * The override exists because test/live-fingerprint.mjs writes FAKE templates
 * here to exercise loadTemplate's accept/reject rules, and it was writing to the
 * REAL path. Two consequences, one intermittent and one dangerous:
 *
 *  1. Under --test-concurrency=8 the other suites are concurrent PROCESSES, and
 *     any that imports cc-template.js reads this file at module init. So
 *     issue-29-tool-translation.mjs intermittently initialised against a 1-tool
 *     fake and failed ~1 run in 5. Reproduced deterministically: 54 pass / 0 fail
 *     with no cache, 48 pass / 6 fail with the fake on disk.
 *  2. The test backs up and restores on exit, so a crash between its write and
 *     its restore leaves the operator's own dario serving
 *     'FAKE LIVE SYSTEM PROMPT' until someone deletes the file by hand.
 *
 * Resolved per call, NOT captured in a module-level const: ESM imports are
 * hoisted, so a test setting the env var in its body would run after a const had
 * already read the real path.
 */
function liveCachePath(): string {
  const override = process.env['DARIO_LIVE_TEMPLATE_CACHE'];
  return override && override.length > 0
    ? override
    : join(homedir(), '.dario', 'cc-template.live.json');
}
const LIVE_TTL_MS = 24 * 60 * 60 * 1000; // re-extract once a day

/**
 * Load the template synchronously. Prefers the live cache (fresh capture
 * from the user's own CC install) and falls back to the bundled snapshot.
 *
 * This is intentionally sync and fast — it runs at module init on every
 * dario request handler. The actual capture is async and runs in the
 * background via refreshLiveFingerprintAsync(); its results are written
 * to the cache file and picked up on the next dario startup.
 */
/**
 * Bring a live capture up to the superset the rest of the codebase assumes:
 * merge back any preserved tool the bundle has and the capture lacks, then
 * re-derive `tool_names`.
 *
 * `tool_names === tools.map(t => t.name)` is the contract everywhere —
 * scrubTemplate() sets it from `tools`, and so does the capture path. The bake
 * learned the hard way that a merge which mutates `tools` without re-deriving
 * the list ships an artifact whose two tool lists disagree; do not repeat it
 * here (#1035).
 */
function withPreservedTools(live: TemplateData, options?: { silent?: boolean }): TemplateData {
  let bundled: TemplateData;
  try {
    bundled = loadBundledTemplate({ silent: true });
  } catch {
    return live; // bundle unreadable — the capture is still better than throwing
  }
  const { tools, preserved } = mergePreservedTools(live.tools, bundled.tools, process.platform);
  // A tool the capture omitted that NO set classifies stays out of the merge
  // (nothing here invents wire shape) — but silence is how that class of rot
  // ships, so say it every load. A client declaring one of these will not
  // identity-map and lands in the unmapped round-robin (the v4.8.93 mode).
  const unclassified = unclassifiedToolDrops(live.tools, bundled.tools, process.platform);
  if (unclassified.length > 0 && !options?.silent) {
    console.warn(
      `[dario] live template: this capture omitted ${unclassified.length} tool${unclassified.length === 1 ? '' : 's'} no preservation set classifies — ` +
      `NOT restored, clients declaring them will not identity-map: ${unclassified.join(', ')}. ` +
      'Please report this at dario#1062 with your `claude --version`.',
    );
  }
  if (preserved.length === 0) return live;
  if (!options?.silent) {
    const byReason = preserved.map((p) => `${p.name} (${p.reason})`).join(', ');
    console.log(`[dario] live template: restored ${preserved.length} tool${preserved.length === 1 ? '' : 's'} the capture omitted: ${byReason}`);
  }
  return { ...live, tools, tool_names: tools.map((t) => t.name) };
}

export function loadTemplate(_options?: { silent?: boolean }): TemplateData {
  const cached = readLiveCache();
  if (cached) {
    const age = Date.now() - new Date(cached._captured).getTime();
    if (age < LIVE_TTL_MS) {
      return withPreservedTools(withBundledVariants(cached), _options);
    }
    // Stale cache: prefer whichever of the live cache and the bundled
    // snapshot was captured more recently — do NOT blindly keep the cache.
    // A frozen live cache must not shadow a newer bundled template, which is
    // exactly what happens in a no-CC deployment (e.g. the Hetzner container):
    // the async refresh can never run there, so the cache stays pinned at its
    // last capture while shipped releases move the bundle ahead. Without this
    // comparison, every bundled-template update is silently ignored until the
    // cache file is removed by hand. A fresh live capture (age < TTL) still
    // wins above; a stale cache only wins if it is still newer than the bundle.
    const bundled = loadBundledTemplate(_options);
    const cachedAt = new Date(cached._captured).getTime();
    const bundledAt = new Date(bundled._captured).getTime();
    return Number.isFinite(bundledAt) && bundledAt > cachedAt ? bundled : withPreservedTools(withBundledVariants(cached), _options);
  }
  return loadBundledTemplate(_options);
}

/**
 * Kick off a background live fingerprint capture. Safe to call on every
 * dario proxy startup — no-ops if CC isn't installed, if the cache is
 * already fresh, or if another refresh is in flight. Never throws.
 *
 * Result is written to ~/.dario/cc-template.live.json and picked up on
 * the next dario startup (cc-template.ts loads the cache synchronously
 * at module init).
 */
export async function refreshLiveFingerprintAsync(options?: {
  force?: boolean;
  silent?: boolean;
  timeoutMs?: number;
}): Promise<TemplateData | null> {
  const silent = options?.silent ?? false;
  const log = (msg: string) => { if (!silent) console.log(`[dario] ${msg}`); };

  if (!options?.force) {
    const cached = readLiveCache();
    if (cached) {
      const age = Date.now() - new Date(cached._captured).getTime();
      if (age < LIVE_TTL_MS) return cached;
    }
  }

  if (!findClaudeBinary()) return null;

  try {
    const live = await captureLiveTemplateAsync(options?.timeoutMs ?? 10_000);
    if (!live) {
      log('live fingerprint refresh: capture returned null (CC did not send a /v1/messages request within the timeout)');
      return null;
    }
    writeLiveCache(live);
    log(`live fingerprint refreshed from CC ${live._version}`);
    return live;
  } catch (err) {
    log(`live fingerprint refresh failed: ${(err as Error).message}`);
    return null;
  }
}

function loadBundledTemplate(options?: { silent?: boolean }): TemplateData {
  const data: TemplateData = JSON.parse(
    readFileSync(join(__dirname, 'cc-template-data.json'), 'utf-8'),
  );
  data._source = 'bundled';

  // Bundled-snapshot-level drift warning. If the user's installed CC is
  // newer than the version the bundled snapshot was verified against, the
  // proxy will still run — but the operator should know they're on a shape
  // that wasn't tested against their CC. The --strict-template / -no-live-
  // capture flags (dario#77) are the fail-closed knobs; this is the soft
  // warn that precedes them. dario#76.
  if (!options?.silent && data._supportedMaxTested) {
    try {
      const installedCCVersion = probeInstalledCCVersion();
      if (installedCCVersion && compareVersions(installedCCVersion, data._supportedMaxTested) > 0) {
        console.log(
          `[dario] ⚠  bundled template was last verified against CC v${data._supportedMaxTested} but installed CC is v${installedCCVersion}. ` +
          `Background refresh will attempt a live capture; if that fails, fingerprint-sensitive fields may be stale.`
        );
      }
    } catch {
      // probeInstalledCCVersion can throw in sandboxed environments; the
      // bundled template is still valid, so swallow and continue.
    }
  }

  return data;
}

function readLiveCache(): TemplateData | null {
  const cachePath = liveCachePath();
  if (!existsSync(cachePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(cachePath, 'utf-8');
  } catch {
    return null;
  }

  let parsed: TemplateData;
  try {
    parsed = JSON.parse(raw) as TemplateData;
  } catch (err) {
    // Unparseable JSON — typically a crash or power-loss mid-write on a
    // pre-v3.17 dario that still used a non-atomic writer. Quarantine
    // the bad file so the next refresh can write a clean one, and log
    // loudly so the user doesn't silently sit on a broken cache forever.
    quarantineCorruptCache(`unparseable JSON (${(err as Error).message})`);
    return null;
  }

  if (!parsed || !parsed.system_prompt || !Array.isArray(parsed.tools) || parsed.tools.length === 0) {
    quarantineCorruptCache('missing required fields (system_prompt / tools)');
    return null;
  }

  // Pre-4.8.145 captures baked the operator's mcp__* tools into the template
  // (dario#678 regression: duplicate tool names → upstream 400). The capture
  // path filters them now, but a polluted cache written by an older dario
  // sits on disk until something rewrites it — its junk union and inflated
  // doctor Overhead numbers persist (the #678 reporter's cache showed 138
  // tool defs, ~111 of them MCP). Quarantine on load; the background refresh
  // re-captures clean.
  if ((parsed.tools as Array<{ name?: unknown }>).some((t) => typeof t?.name === 'string' && t.name.startsWith('mcp__'))) {
    quarantineCorruptCache('mcp__ tool pollution (pre-4.8.145 capture)');
    return null;
  }

  // Schema version mismatch is NOT corruption — it's an expected event on
  // dario upgrade or downgrade. Skip the cache silently; the background
  // refresh will rewrite it in the new shape.
  if (parsed._schemaVersion !== CURRENT_SCHEMA_VERSION) return null;

  parsed._source = 'live';
  return parsed;
}

/**
 * Rename a corrupt cache file aside to `.corrupt-<ISO>` so the next
 * refresh writes a fresh cache without first having to overwrite a bad
 * file. Keeping the original as-is would also work, but quarantining
 * makes it clearer in `ls ~/.dario` that the file was rejected, and
 * preserves the contents for post-mortem in case a user files an issue.
 */
function quarantineCorruptCache(reason: string): void {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const aside = `${liveCachePath()}.corrupt-${stamp}`;
    renameSync(liveCachePath(), aside);
    console.error(`[dario] ⚠  live template cache rejected: ${reason}. Quarantined to ${aside}. Next background refresh will re-capture.`);
  } catch (err) {
    // If the rename itself fails, leave the file in place — a subsequent
    // refresh will overwrite it atomically. Log so the state is visible.
    console.error(`[dario] ⚠  live template cache rejected: ${reason}. (quarantine rename failed: ${(err as Error).message})`);
  }
}

/**
 * Atomic JSON write: dump to a sibling `.tmp` file, then rename over the
 * target path. A crash or Ctrl+C between writes never leaves a half-
 * written file where `JSON.parse` would throw on next read. Uses a pid-
 * qualified tmp name so concurrent dario processes don't stomp on each
 * other's partial writes. Exposed for tests via `_atomicWriteJsonForTest`.
 */
function atomicWriteJson(targetPath: string, data: unknown): void {
  // 0700: whichever code path creates ~/.dario first decides that directory's
  // permissions, and this one runs at startup, before any credential write.
  // Without a mode it lands 755 on Linux, which makes every non-0600 file inside
  // world-readable. The credential paths already create their dirs 0700; this was
  // the one that could get there first and did not.
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const tmp = `${targetPath}.${process.pid}.tmp`;
  try {
    // 0600: this file holds the UNSCRUBBED live capture. Verified on the Linux
    // deployment to contain `# Environment` (cwd, OS, platform) and `gitStatus:`
    // (branch, modified files, recent commits); structurally it can also carry
    // `# claudeMd`, `# userEmail` and `# auto memory` — the scrub list exists
    // because CC emits them. Credentials beside it are 0600; this was 0644.
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, targetPath);
  } catch (err) {
    // Clean up the stray tmp if the rename failed; swallow its own
    // unlink error — nothing useful to do with it.
    try { unlinkSync(tmp); } catch { /* noop */ }
    throw err;
  }
}

/** Test-only surface for `atomicWriteJson`. Production code uses `writeLiveCache`. */
export function _atomicWriteJsonForTest(targetPath: string, data: unknown): void {
  atomicWriteJson(targetPath, data);
}

function writeLiveCache(data: TemplateData): void {
  atomicWriteJson(liveCachePath(), data);
}

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /**
   * The flat [k1, v1, k2, v2, ...] array exactly as Node exposes it via
   * req.rawHeaders. Preserves insertion order and duplicates, which the
   * flattened `headers` map does not. Used to recover CC's header order.
   */
  rawHeaders: string[];
  body: Record<string, unknown>;
}

/**
 * Does this request belong to the capture we started?
 *
 * The MITM used to accept the FIRST request whose URL contained
 * `/v1/messages` with nothing tying it to the child we spawned (dario#872).
 * The port is ephemeral, so a collision is improbable rather than
 * impossible, and nothing downstream could tell a foreign request from the
 * child's once it was captured.
 *
 * The nonce rides in the URL path because that is the one channel we fully
 * control without touching what CC sends. Two measurements decided it over a
 * key-borne nonce:
 *
 *   1. CC honours a path segment in ANTHROPIC_BASE_URL — given
 *      `http://127.0.0.1:PORT/<nonce>` it requests
 *      `/<nonce>/v1/messages?beta=true` (and probes `/<nonce>/api/hello`
 *      first, which still 404s here).
 *   2. On a subscription install CC authenticates with
 *      `authorization: Bearer sk-ant-…`, so ANTHROPIC_API_KEY is not the auth
 *      header at all. A key-borne nonce would do nothing on OAuth installs
 *      while changing the auth path for API-key ones — and changing what the
 *      child authenticates with can change what it sends, which is the whole
 *      thing a fingerprint capture must not do.
 *
 * Fails closed: no nonce, no capture. A miss makes the capture return null
 * and the bake exit non-zero, which is the correct outcome for a request we
 * cannot attribute.
 */
export function isOwnCaptureRequest(url: string | undefined, nonce: string): boolean {
  if (!url || nonce.length === 0) return false;
  if (!url.startsWith(`/${nonce}/`)) return false;
  return url.includes('/v1/messages');
}

/**
 * Run a loopback MITM server on a random port, spawn CC with
 * ANTHROPIC_BASE_URL pointed at it, wait for one request, respond with a
 * minimal valid SSE stream, and return the captured request.
 *
 * Returns null on timeout or spawn failure. Does not throw.
 */
export async function captureLiveTemplateAsync(timeoutMs: number = 10_000): Promise<TemplateData | null> {
  const captured = await runCapture(timeoutMs);
  if (!captured) return null;
  return extractTemplate(captured);
}

async function runCapture(timeoutMs: number): Promise<CapturedRequest | null> {
  const nonce = `dario-capture-${randomBytes(12).toString('hex')}`;
  return new Promise((resolve) => {
    let captured: CapturedRequest | null = null;
    let settled = false;
    let foreign = 0;
    const settle = (result: CapturedRequest | null) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* noop */ }
      try { child?.kill('SIGTERM'); } catch { /* noop */ }
      resolve(result);
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Only handle OUR /v1/messages — everything else gets a 404 so CC
      // doesn't accidentally think /v1/models is live, and so a request we
      // cannot attribute to the spawned child is never captured (dario#872).
      if (!isOwnCaptureRequest(req.url, nonce)) {
        // A /v1/messages without our nonce is exactly the case #872 is about:
        // something else reached this port. Say so — a silent 404 here is how
        // a foreign capture would have gone unnoticed.
        if (req.url?.includes('/v1/messages')) {
          foreign++;
          console.error(
            `[dario] capture: rejected a /v1/messages request that did not carry this capture's nonce (${foreign} so far) — see dario#872`,
          );
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"not found"}}');
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const body = raw ? JSON.parse(raw) : {};
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(',');
          }
          captured = {
            method: req.method ?? 'POST',
            path: (req.url ?? '/v1/messages').replace(`/${nonce}`, ''),
            headers,
            rawHeaders: Array.isArray(req.rawHeaders) ? [...req.rawHeaders] : [],
            body,
          };
        } catch {
          // Captured body was not JSON — leave captured null, respond anyway.
        }

        // Send a minimal valid SSE stream so CC doesn't hang retrying.
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
          'anthropic-ratelimit-unified-status': 'allowed',
          'anthropic-ratelimit-unified-5h-utilization': '0',
          'anthropic-ratelimit-unified-7d-utilization': '0',
          'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 18000),
        });
        const sse = [
          `event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_live_capture',
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-4-5',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'ok' },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
        ].join('');
        res.end(sse);

        // Give CC a beat to read the response before we kill it.
        setTimeout(() => settle(captured), 500);
      });
    });

    server.on('error', () => settle(null));

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        settle(null);
        return;
      }
      const url = `http://127.0.0.1:${address.port}/${nonce}`;

      // Spawn CC with ANTHROPIC_BASE_URL pointed at our MITM.
      const claudeBin = findClaudeBinary();
      if (!claudeBin) {
        settle(null);
        return;
      }

      // Node 20+ won't spawn `.cmd`/`.bat` without `shell: true` (CVE-2024-27980).
      // `useShell` triggers cmd.exe on Windows — reject overrides that carry
      // shell metacharacters before the spawn, same guard as probeInstalledCCVersion.
      const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeBin);
      if (useShell && /[&|><^"'%\r\n`$;(){}[\]]/.test(claudeBin)) {
        settle(null);
        return;
      }

      try {
        child = spawn(claudeBin, ['--print', '-p', 'hi'], {
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: url,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'sk-dario-fingerprint-capture',
            // Pin the base-prompt model. An unpinned `claude --print` uses the
            // user's DEFAULT model, which made the captured base machine-specific.
            // A caller-supplied value wins: capture-and-bake sets this per variant.
            ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? TEMPLATE_BASE_MODEL,
            // Prevent CC from launching its own interactive UI or OAuth flow.
            CLAUDE_NONINTERACTIVE: '1',
          },
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true,
          shell: useShell,
        });
        child.on('error', () => settle(null));
        child.on('exit', () => {
          // Give the server a brief moment to finish reading the body in case
          // exit and request-end race.
          setTimeout(() => settle(captured), 200);
        });
      } catch {
        settle(null);
        return;
      }
    });

    let child: ReturnType<typeof spawn> | undefined;

    // Hard timeout.
    setTimeout(() => settle(captured), timeoutMs);
  });
}

/**
 * Locate the installed `claude` binary and its version. Thin public
 * wrapper over `findClaudeBinary` + `probeInstalledCCVersion` — the
 * doctor CLI and external callers use this to report install state
 * without reaching into module-private helpers.
 */
export function findInstalledCC(): { path: string | null; version: string | null } {
  const path = findClaudeBinary();
  const version = path ? probeInstalledCCVersion() : null;
  return { path, version };
}

// Resolving the binary means enumerating candidates and, when there is more
// than one, SPAWNING each to compare versions. That is a subprocess per
// candidate per call, and there are four call sites (refresh, capture,
// findInstalledCC, drift). Profiling a proxy start showed ~720ms of blocking
// spawnSync, over half of a ~1270ms startup, from repeating this and the
// version probe. The installed binary cannot change mid-process, so resolve
// once. Keyed on the override so a test flipping DARIO_CLAUDE_BIN is not served
// a stale answer.
let _claudeBinCache: { key: string; value: string | null } | null = null;

/** Test-only: drop the resolved-binary memo. */
export function _resetClaudeBinCacheForTest(): void {
  _claudeBinCache = null;
}

function findClaudeBinary(): string | null {
  // Honor an explicit override first — useful for tests and for users on
  // non-standard installs.
  const override = process.env.DARIO_CLAUDE_BIN;
  if (override) return override;
  if (_claudeBinCache && _claudeBinCache.key === '') return _claudeBinCache.value;

  const resolved = resolveClaudeBinaryUncached();
  _claudeBinCache = { key: '', value: resolved };
  return resolved;
}

function resolveClaudeBinaryUncached(): string | null {
  const candidates = enumerateClaudeCandidates();
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Multiple installs on PATH — common on Windows where an npm-wrapper
  // (~/AppData/Roaming/npm/claude.cmd) coexists with a native install
  // (~/.local/bin/claude.exe). Version-probe each and pick the newest.
  // Falls back to the first candidate if no probe succeeds (e.g. every
  // spawn fails on a sandboxed runtime).
  const probed: Array<{ path: string; version: string }> = [];
  for (const path of candidates) {
    const version = probeOneVersion(path);
    if (version) probed.push({ path, version });
  }
  if (probed.length === 0) return candidates[0];
  probed.sort((a, b) => compareVersions(b.version, a.version));
  return probed[0].path;
}

// Exported for unit tests.
export function enumerateClaudeCandidates(): string[] {
  const pathEnv = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = pathEnv.split(sep).filter(Boolean);
  // `.exe` first on Windows: the native binary beats a `.cmd` wrapper
  // when both live in the same dir. Across dirs we version-probe anyway
  // so order here only matters when probes all fail.
  const names = process.platform === 'win32'
    ? ['claude.exe', 'claude.cmd', 'claude']
    : ['claude'];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    for (const name of names) {
      const full = join(d, name);
      if (seen.has(full)) continue;
      try {
        if (existsSync(full)) {
          seen.add(full);
          found.push(full);
        }
      } catch { /* noop */ }
    }
  }
  return found;
}

// Version-probe one specific binary path. Same safety logic as
// probeInstalledCCVersionUncached below (reject shell metacharacters in
// override paths before spawning with shell:true on Windows).
function probeOneVersion(bin: string): string | null {
  try {
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    if (useShell && /[&|><^"'%\r\n`$;(){}[\]]/.test(bin)) return null;
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: useShell,
    });
    const m = /(\d+\.\d+\.\d+(?:[.\-][\w.\-]+)?)/.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Given a captured /v1/messages request body, pull out the fields that
 * matter for template replay: agent identity, system prompt, tool list,
 * and CC version (from the billing header or user-agent).
 */
export function extractTemplate(captured: CapturedRequest): TemplateData | null {
  const body = captured.body;
  const systemBlocks = body.system;
  if (!Array.isArray(systemBlocks) || systemBlocks.length < 2) return null;

  // CC's system is a 3-block structure:
  //   [0] billing tag (no cache_control, tiny)
  //   [1] agent identity ("You are Claude Code..."), cache_control ephemeral (5m — no ttl field, verified CC v2.1.203)
  //   [2] system prompt (~25KB), cache_control ephemeral (5m)
  // Billing tag is per-request — we never cache it. Identity + prompt are
  // what we want.
  const agentIdentity = pickTextBlock(systemBlocks[1]);
  const systemPrompt = pickTextBlock(systemBlocks[2]);
  if (!agentIdentity || !systemPrompt) return null;

  // mcp__* tools are EXCLUDED from the template: the capture spawns the
  // operator's own CC, and on a machine with MCP servers configured the
  // captured request declares their mcp__<server>__<tool> schemas — session
  // config, not CC wire shape. Baking them poisoned CC_TOOL_DEFINITIONS_UNION
  // and duplicated any client-declared MCP tool on the advertise path
  // (template def + verbatim client schema), which upstream rejects with
  // 400 "tools: Tool names must be unique" (dario#678 follow-up). Local
  // startsWith mirror of cc-template's isMcpToolName — importing it here
  // would cycle (cc-template imports loadTemplate from this module).
  const tools = Array.isArray(body.tools)
    ? (body.tools as Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>)
        .filter((t) => typeof t.name === 'string' && !t.name.startsWith('mcp__'))
        .map((t) => ({
          name: t.name as string,
          description: t.description ?? '',
          input_schema: t.input_schema ?? {},
        }))
    : [];
  if (tools.length === 0) return null;

  const version = extractCCVersion(captured.headers) ?? 'unknown';
  const headerOrder = extractHeaderOrder(captured.rawHeaders);
  const anthropicBeta = captured.headers['anthropic-beta'];
  const headerValues = extractStaticHeaderValues(captured.headers);
  // Top-level body key order — JSON is unordered semantically, but the
  // wire serialization has order. Captured from Object.keys on the parsed
  // body, which preserves insertion order (ES2015+).
  const bodyFieldOrder = extractBodyFieldOrder(captured.body);

  return {
    _version: version,
    _captured: new Date().toISOString(),
    _source: 'live',
    _schemaVersion: CURRENT_SCHEMA_VERSION,
    agent_identity: agentIdentity,
    system_prompt: systemPrompt,
    tools,
    tool_names: tools.map((t) => t.name),
    header_order: headerOrder,
    anthropic_beta: typeof anthropicBeta === 'string' ? anthropicBeta : undefined,
    header_values: Object.keys(headerValues).length > 0 ? headerValues : undefined,
    body_field_order: bodyFieldOrder,
  };
}

/**
 * Capture the top-level key order of a parsed body. Returns undefined when
 * the object is empty or not an object, so the reorder helper in
 * cc-template.ts falls back to its hardcoded build order.
 */
function extractBodyFieldOrder(body: Record<string, unknown> | undefined): string[] | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const keys = Object.keys(body);
  return keys.length > 0 ? keys : undefined;
}

/**
 * Pick header values from the captured request that CC would set identically
 * on every outbound call. The replayer overlays these on top of whatever the
 * caller supplied, so anything session-scoped, auth-bearing, or computed by
 * the HTTP stack itself must be excluded.
 */
const STATIC_HEADER_EXCLUDE = new Set<string>([
  // Auth — never replay across identities
  'authorization',
  // x-api-key is a CAPTURE ARTIFACT (dario#42). During capture we spawn CC
  // with ANTHROPIC_API_KEY=sk-dario-fingerprint-capture pointing at a loopback
  // MITM, so CC emits `x-api-key: sk-dario-fingerprint-capture`. Replaying
  // that placeholder upstream alongside the real OAuth Bearer used to be a
  // no-op because Anthropic ignored x-api-key when Authorization was present;
  // as of 2026-04-17 some account tiers now 401 with "invalid x-api-key" when
  // both are sent. Never capture it.
  'x-api-key',
  // Body-framing — computed per request
  'content-type', 'content-length', 'transfer-encoding',
  // Host / connection — managed by the HTTP stack
  'host', 'connection', 'keep-alive', 'accept-encoding',
  // Session / request identifiers — rotate per call
  'x-claude-code-session-id', 'x-client-request-id', 'x-request-id',
  // Beta flag is captured separately
  'anthropic-beta',
  // Billing tag — rebuilt per request from cc_version
  'x-anthropic-billing-header',
  // HOST-SPECIFIC (dario#854 fallout). These describe the machine that ran the
  // capture, not CC's wire shape, so replaying them makes every consumer of a
  // baked template announce the BAKE host's platform instead of its own. The
  // proxy already computes both correctly per-process (OS_NAME / arch), and the
  // overlay used to clobber those with the captured values.
  //
  // Found 2026-07-25: the bundled template had been baked on Windows for
  // several releases (#820/#828/#840/#849/#851 -> x-stainless-os: Windows,
  // 30 tools incl. PowerShell), while cc-drift-template-watch runs its live
  // capture every 30 min on the Linux Hetzner runner. So the Linux box served
  // `x-stainless-os: Windows`, and the watch saw permanent drift against a
  // bundle it could never match -- auto-rebaking to Linux (#852), which the next
  // Windows-side bake (#854) would flip straight back. Excluding these ends
  // both the fidelity bug and the rebake ping-pong: the bake host stops
  // mattering for these keys.
  'x-stainless-os',
  'x-stainless-arch',
]);

function extractStaticHeaderValues(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (STATIC_HEADER_EXCLUDE.has(lk)) continue;
    if (typeof v !== 'string') continue;
    out[lk] = v;
  }
  return out;
}

// ============================================================
//  Drift detection + startup diagnostics (v3.17)
// ============================================================

let _installedVersionProbe: { value: string | null; cached: boolean } = { value: null, cached: false };

/**
 * Sync-probe `claude --version` and return the parsed version string, e.g.
 * `"2.1.104"`. Memoized per-process — the binary is invoked at most once,
 * subsequent calls return the cached result. Returns `null` if the binary
 * isn't on PATH, or the probe failed / timed out, or the output didn't
 * match the expected format.
 *
 * Used by `detectDrift` to compare the installed CC against the version
 * recorded in the cache at capture time.
 */
export function probeInstalledCCVersion(): string | null {
  if (_installedVersionProbe.cached) return _installedVersionProbe.value;
  const value = probeInstalledCCVersionUncached();
  _installedVersionProbe = { value, cached: true };
  return value;
}

function probeInstalledCCVersionUncached(): string | null {
  const bin = findClaudeBinary();
  if (!bin) return null;
  try {
    // Node 20+ refuses to spawn `.cmd`/`.bat` via execFile without
    // explicit `shell: true` (CVE-2024-27980 hardening). On Windows,
    // npm-installed CLIs commonly live behind a `.cmd` shim — detect
    // that and opt into the shell path.
    //
    // `bin` is normally from findClaudeBinary's fixed allow-list, but
    // DARIO_CLAUDE_BIN lets users override it. If that override reaches
    // the shell path, cmd.exe interprets its contents — so reject any
    // override that carries shell metacharacters before we spawn.
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    if (useShell && /[&|><^"'%\r\n`$;(){}[\]]/.test(bin)) {
      return null;
    }
    const out = execFileSync(bin, ['--version'], {
      encoding: 'utf-8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: useShell,
    });
    // `claude --version` currently prints e.g. `1.0.79 (Claude Code)` or
    // `claude-cli 2.1.104`. Accept anything that contains a dotted numeric
    // version — the first match wins.
    const m = /(\d+\.\d+\.\d+(?:[.\-][\w.\-]+)?)/.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Format how old a captured timestamp is, human-readable. `_captured` is
 * an ISO string written by `extractTemplate` or the bundled snapshot.
 * Falls back to `"unknown age"` if the timestamp doesn't parse.
 */
export function formatCaptureAge(capturedIso: string, now: number = Date.now()): string {
  const t = Date.parse(capturedIso);
  if (!Number.isFinite(t)) return 'unknown age';
  const ageMs = Math.max(0, now - t);
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

/**
 * One-line human summary of the active template — what source, which CC
 * version captured it, and how old that capture is. Proxy startup logs
 * this so users can tell at a glance whether they're on a fresh live
 * capture or a stale bundled fallback.
 */
export function describeTemplate(t: TemplateData): string {
  const source = t._source ?? 'bundled';
  const age = formatCaptureAge(t._captured);
  // Variant coverage is part of the template's identity: a template that
  // lost its per-model variants serves every family the base prompt, and
  // that degradation is otherwise invisible (dario#lock-step).
  const keys = Object.keys(promptVariantsOf(t)).sort();
  const variants = keys.length > 0 ? keys.join('+') : 'none';
  return `${source} capture, CC v${t._version} (${age} old), variants: ${variants}`;
}

export interface DriftResult {
  /** True when we can confirm the cache is from a different CC version than the one currently installed. */
  drifted: boolean;
  cachedVersion: string;
  /** null when the probe couldn't run (no CC on PATH, timeout, parse fail). */
  installedVersion: string | null;
  /** Reason string — safe to log as-is. */
  message: string;
}

/**
 * Compare the loaded template's captured CC version against the version
 * reported by `claude --version` on the current machine. Drifted caches
 * are still usable — the shape is probably compatible — but the proxy
 * should force-refresh ASAP so the next startup is back in sync.
 *
 * @param installedOverride test-only injection for unit tests; production
 *   callers pass nothing and the real binary probe runs.
 */
export function detectDrift(t: TemplateData, installedOverride?: string | null): DriftResult {
  const installed = installedOverride !== undefined ? installedOverride : probeInstalledCCVersion();
  const cachedVersion = t._version;
  if (installed === null) {
    return {
      drifted: false,
      cachedVersion,
      installedVersion: null,
      message: 'installed CC version not probed (binary not on PATH or probe failed)',
    };
  }
  if (installed === cachedVersion) {
    return {
      drifted: false,
      cachedVersion,
      installedVersion: installed,
      message: `cache matches installed CC (v${installed})`,
    };
  }
  return {
    drifted: true,
    cachedVersion,
    installedVersion: installed,
    message: `cache is from CC v${cachedVersion} but installed CC is v${installed} — background refresh will re-capture`,
  };
}

// ============================================================
//  CC version compat matrix (v3.17)
// ============================================================

/**
 * The CC version range the current dario release has been exercised
 * against. Update `maxTested` every time we validate against a new CC
 * (ideally as part of the release checklist — the e2e test against the
 * user's own CC is the ground-truth signal).
 *
 * - `min`: below this, dario's extractor hasn't been validated; proxy
 *   will still run but may mis-parse CC's request body.
 * - `maxTested`: the newest CC version the current dario release has
 *   been exercised against. Above this, dario is *likely* fine (CC's
 *   request shape evolves slowly) but it's explicitly untested, so
 *   users get a soft warn and we get a signal to refresh the bundled
 *   snapshot + rerun e2e.
 */
export const SUPPORTED_CC_RANGE = {
  min: '1.0.0',
  maxTested: '2.1.257',
} as const;

/**
 * Compare two dotted-numeric version strings. Returns negative if `a<b`,
 * zero if equal, positive if `a>b`. Handles suffixes like `-beta.1` or
 * `.dev` by comparing the numeric prefix first and treating anything
 * after as a tiebreaker (strings compared lexicographically; absence of
 * suffix beats presence, matching semver's "release > prerelease").
 *
 * Intentionally minimal — dario's "zero runtime deps" policy rules out
 * pulling `semver`. CC versions are well-formed `M.m.p[-suffix]` so we
 * don't need the full spec.
 */
export function compareVersions(a: string, b: string): number {
  const splitPrefixSuffix = (v: string): { parts: number[]; suffix: string } => {
    const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(v);
    if (!m) return { parts: [0], suffix: v };
    const parts = m[1].split('.').map((s) => parseInt(s, 10));
    return { parts, suffix: m[2] ?? '' };
  };
  const A = splitPrefixSuffix(a);
  const B = splitPrefixSuffix(b);
  const len = Math.max(A.parts.length, B.parts.length);
  for (let i = 0; i < len; i++) {
    const ai = A.parts[i] ?? 0;
    const bi = B.parts[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  // Numeric prefix equal — compare suffix. Empty suffix beats non-empty
  // (release > prerelease). Otherwise lexicographic.
  if (A.suffix === B.suffix) return 0;
  if (A.suffix === '') return 1;
  if (B.suffix === '') return -1;
  return A.suffix < B.suffix ? -1 : 1;
}

export type CompatStatus = 'ok' | 'untested-above' | 'below-min' | 'unknown';

export interface CompatResult {
  status: CompatStatus;
  installedVersion: string | null;
  range: { min: string; maxTested: string };
  message: string;
}

/**
 * Check whether the installed CC version sits inside the supported range.
 * Called at startup by the proxy; the result drives whether we emit a
 * compatibility warning to the user.
 *
 * `unknown` is not a failure — it just means we couldn't probe (no CC on
 * PATH, timeout, parse miss). Dario still runs on bundled template.
 *
 * @param installedOverride test-only injection; production callers pass nothing.
 */
export function checkCCCompat(installedOverride?: string | null): CompatResult {
  const installed = installedOverride !== undefined ? installedOverride : probeInstalledCCVersion();
  const range = { min: SUPPORTED_CC_RANGE.min, maxTested: SUPPORTED_CC_RANGE.maxTested };
  if (installed === null) {
    return {
      status: 'unknown',
      installedVersion: null,
      range,
      message: 'installed CC version not probed — compatibility unchecked',
    };
  }
  if (compareVersions(installed, range.min) < 0) {
    return {
      status: 'below-min',
      installedVersion: installed,
      range,
      message: `installed CC v${installed} is older than the minimum dario supports (v${range.min}); extractor may mis-parse requests — upgrade CC`,
    };
  }
  if (compareVersions(installed, range.maxTested) > 0) {
    return {
      status: 'untested-above',
      installedVersion: installed,
      range,
      message: `installed CC v${installed} is newer than dario's last tested version (v${range.maxTested}); usually fine, but untested`,
    };
  }
  return {
    status: 'ok',
    installedVersion: installed,
    range,
    message: `installed CC v${installed} is within the tested range (v${range.min} – v${range.maxTested})`,
  };
}

/**
 * Walk rawHeaders (flat [k1, v1, k2, v2, ...] array) and return the
 * header names in insertion order, lowercased, de-duplicated. If the
 * raw array is empty or unusable, returns undefined so the caller
 * falls back to default ordering.
 */
function extractHeaderOrder(rawHeaders: string[]): string[] | undefined {
  if (!Array.isArray(rawHeaders) || rawHeaders.length === 0) return undefined;
  const order: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    if (typeof name !== 'string') continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    order.push(lower);
  }
  return order.length > 0 ? order : undefined;
}

function pickTextBlock(block: unknown): string | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as { type?: string; text?: string };
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  return null;
}

function extractCCVersion(headers: Record<string, string>): string | null {
  // Preferred: x-anthropic-billing-header carries cc_version=X.Y.Z
  const billing = headers['x-anthropic-billing-header'];
  if (billing) {
    const m = /cc_version=([\w.\-]+)/.exec(billing);
    if (m) return m[1];
  }
  // Fallback: user-agent often carries claude-cli/X.Y.Z
  const ua = headers['user-agent'];
  if (ua) {
    const m = /claude-cli\/([\w.\-]+)/.exec(ua);
    if (m) return m[1];
  }
  return null;
}

/**
 * Test hook: given a captured request object (from a mocked server or a
 * synthetic fixture), run it through the same extraction path. Exposed so
 * test/live-fingerprint.mjs doesn't need to spawn a real process.
 */
export function _extractTemplateForTest(captured: CapturedRequest): TemplateData | null {
  return extractTemplate(captured);
}
