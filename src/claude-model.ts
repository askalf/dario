/**
 * "Can the Claude pool actually serve this model name?" — the positive test
 * the reverse half of failover needs, and WHAT it resolves to.
 *
 * Chain selection used to answer this by elimination: anything absent from the
 * Codex slugs was handed to the Claude pool. That is not a capability test, it
 * is a default, and it is wrong for every name that belongs to neither
 * provider. `--pool-fallback=gpt-5.6-sol,gpt-4o` on a rate-limited
 * subscription re-pointed the request at Anthropic as `gpt-4o` and turned a
 * 429 into a 400 — and a typo'd slug (`claude-sonnet-6`, `gtp-5.6-sol`) did
 * the same, silently, because a misspelling is also "absent from the slugs".
 * A discovery outage makes it worse: `getCodexModelSlugs` degrades to an EMPTY
 * set, at which point elimination calls EVERY chain entry Claude-servable.
 *
 * So the rule is positive, in two steps that mirror the request path:
 *
 *   1. RESOLVE the entry the way a request model is resolved — an explicit
 *      `claude:` / `anthropic:` prefix is stripped, then operator
 *      `--model-alias` values, pinned aliases (`opus48`) and catalog family
 *      shorthands (`opus`, `sonnet1m`) map to a canonical id. The caller
 *      supplies that resolver so classification and forwarding cannot
 *      disagree.
 *   2. VALIDATE the resolved id against the catalog base set. A `claude-`
 *      prefix on its own proves nothing — `claude-sonnet-6` has the prefix and
 *      does not exist — so the id (sans `[1m]`) must be a base the pool can
 *      forward. An explicit provider prefix can force the route; it cannot
 *      make an unknown model servable.
 *
 * The RESOLVED id is what the caller swaps into the body. The swap happens
 * after the proxy's own alias pass, so returning the entry as written would
 * send an alias upstream raw and Anthropic would 400 it.
 *
 * Pure over the base set it is handed, so the whole selection stays testable
 * without a socket. `bases` defaults to the baked catalog, never to empty: a
 * cold catalog must still admit real ids, and must still refuse typos.
 */
import { BAKED_BASE_MODELS, resolveAliasAgainst } from './model-catalog.js';

/** Provider prefixes that force the Claude path (mirrors proxy.ts's PROVIDER_PREFIXES). */
const CLAUDE_PREFIXES = new Set(['claude', 'anthropic']);

/** Maps a bare name to a canonical id, or returns it unchanged. */
export type ModelResolver = (model: string) => string;

/**
 * The canonical id the Claude pool would serve `model` as, or null when it
 * cannot serve it. `bases` is the catalog base set — `getCachedBases()` at a
 * call site, a fixture in a test. `resolve` is the alias pipeline; the default
 * knows only catalog family shorthands, so pass the proxy's full resolver
 * (operator aliases + pinned aliases) where one exists.
 */
export function resolveClaudeServable(
  model: string,
  bases: readonly string[] = BAKED_BASE_MODELS,
  resolve?: ModelResolver,
): string | null {
  let m = model.trim().toLowerCase();
  if (!m) return null;

  const idx = m.indexOf(':');
  if (idx > 0) {
    const prefix = m.slice(0, idx);
    // A recognized non-Claude prefix is a definite NO, not a fall-through to
    // the name test below — `openai:claude-sonnet-5` is the operator pointing
    // somewhere else on purpose.
    if (!CLAUDE_PREFIXES.has(prefix)) return null;
    m = m.slice(idx + 1);
    if (!m) return null;
  }

  const resolved = (resolve ? resolve(m) : (resolveAliasAgainst(m, bases) ?? m)).trim().toLowerCase();
  const base = resolved.endsWith('[1m]') ? resolved.slice(0, -4) : resolved;
  return bases.some((b) => b.toLowerCase() === base) ? resolved : null;
}

/** Whether the Claude pool can serve `model`. See resolveClaudeServable. */
export function isClaudeServableModel(
  model: string,
  bases: readonly string[] = BAKED_BASE_MODELS,
  resolve?: ModelResolver,
): boolean {
  return resolveClaudeServable(model, bases, resolve) !== null;
}
