/**
 * effort.ts — the effort vocabulary and the model-name effort suffix.
 *
 * These lived in cc-template.ts, which is where the request path uses them.
 * They moved down here because the pool-fallback classifier (claude-model.ts)
 * has to parse the SAME suffix the request path parses, and that module is
 * deliberately pure — it decides what the Claude pool can serve out of a base
 * set and nothing else. Importing cc-template.js there would drag the CC
 * template load (live capture / bundled snapshot, read at module init) into a
 * classifier whose whole value is being decidable without one, and a second
 * hand-written copy of the suffix list would be the other way to get it: two
 * definitions of "what counts as an effort suffix" that drift apart silently,
 * which is exactly the bug this file was extracted to fix (dario#1156 review).
 *
 * cc-template.ts re-exports all three, so every existing import site
 * (proxy.ts, cli.ts, test/effort-flag.mjs) is unchanged.
 */

/** Valid values for the `--effort` flag. Mirrors CC's effort set (`low|medium|high|xhigh|max`) plus CC's `ultracode` mode and dario's pseudo-value `'client'` for passthrough. `'ultracode'` is CC's xhigh-plus-dynamic-workflow-orchestration mode (CC 2.1.154); the Messages API accepts only low|medium|high|xhigh|max, so dario normalizes ultracode → 'xhigh' on the wire (see normalizeEffortForWire). `'client'` passes through the client's own `output_config.effort` (falling back to `'xhigh'`). dario#87, `'max'` added in dario#190, `'ultracode'` added 2026-05-28. */
export type EffortValue = 'low' | 'medium' | 'high' | 'xhigh' | 'ultracode' | 'max' | 'client';
export const VALID_EFFORT_VALUES: ReadonlyArray<EffortValue> = ['low', 'medium', 'high', 'xhigh', 'ultracode', 'max', 'client'];

/**
 * dario#419 — strip an optional effort suffix off a model name, so OpenAI-compat
 * clients that can't set `output_config.effort` (e.g. Cursor) can choose effort
 * by model name: `opus-4-8:high` (colon) or Cursor-style `claude-opus-4-8-high`
 * (hyphen). Only the wire-valid effort levels are recognized as a suffix — any
 * other trailing token is left as part of the model name, and a bare model that
 * IS an effort word (e.g. just "high") is left alone. Returns the model with the
 * suffix removed plus the parsed effort (undefined when none). Exported for tests.
 */
const SUFFIX_EFFORTS: ReadonlyArray<EffortValue> = ['ultracode', 'medium', 'xhigh', 'high', 'low', 'max'];
/**
 * dario's effort tiers onto the levels the Codex Responses backend accepts
 * (dario#1260). Probed 2026-08-29: `none, minimal, low, medium, high, xhigh,
 * max` are valid upstream; `ultra` 400s.
 *
 *   - low/medium/high/xhigh/max pass through — same name on both sides.
 *   - `ultracode` is dario's own tier with no upstream equivalent. It maps to
 *     `max`, the nearest thing the backend has, rather than being dropped:
 *     a caller who asked for the most effort available should not silently
 *     get the default.
 *   - `client` means "whatever the client asked for", so it forces nothing
 *     and the request's own thinking budget decides, as before.
 */
export function effortForCodex(effort: EffortValue | undefined):
  'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  switch (effort) {
    case 'low': case 'medium': case 'high': case 'xhigh': case 'max': return effort;
    case 'ultracode': return 'max';
    case 'client': case undefined: return undefined;
    default: return undefined;
  }
}

export function parseEffortSuffix(model: string): { model: string; effort?: EffortValue } {
  for (const e of SUFFIX_EFFORTS) {
    for (const sep of [':', '-']) {
      const tag = sep + e;
      if (model.length > tag.length && model.endsWith(tag)) {
        return { model: model.slice(0, -tag.length), effort: e };
      }
    }
  }
  return { model };
}
