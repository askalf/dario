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
 *      disagree. The prefix rule applies to the alias TARGET too, since an
 *      operator alias is written the way a request model is written — see
 *      stripClaudePrefix. So does the effort suffix (`:high`, `-high`) — see
 *      servableTarget.
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
import { parseEffortSuffix, type EffortValue } from './effort.js';

/** Provider prefixes that force the Claude path (mirrors proxy.ts's PROVIDER_PREFIXES). */
const CLAUDE_PREFIXES = new Set(['claude', 'anthropic']);

/** Maps a bare name to a canonical id, or returns it unchanged. */
export type ModelResolver = (model: string) => string;

/**
 * What the pool would serve a chain entry as: the canonical id, plus the effort
 * the entry ASKED FOR when it carried a suffix (`claude:opus:high`). Both
 * halves travel together because the caller needs both — the id goes into the
 * body, the effort into the outbound `output_config` — and dropping the second
 * is how `claude:opus:high` reached Anthropic at the pool default (dario#1161).
 */
export type ClaudeTarget = { model: string; effort?: EffortValue };

/**
 * Strip a Claude-side provider prefix, or refuse the name outright.
 *
 * Null on any prefix that isn't `claude:`/`anthropic:` — a recognized
 * non-Claude prefix is a definite NO, not a fall-through to the name test
 * (`openai:claude-sonnet-5` is the operator pointing somewhere else on
 * purpose), and an unrecognized one names a model this pool has no claim on.
 * `model` is expected already trimmed + lowercased.
 */
function stripClaudePrefix(model: string): string | null {
  const idx = model.indexOf(':');
  if (idx <= 0) return model || null;
  if (!CLAUDE_PREFIXES.has(model.slice(0, idx))) return null;
  return model.slice(idx + 1) || null;
}

/**
 * One spelling of the target: strip its prefix, run the catalog pass, keep it
 * only if the result is a base the pool can forward.
 *
 * A target that arrived prefixed still holds a shorthand (`claude:opus` →
 * `opus`), so the catalog pass runs on it. Idempotent for a target already
 * canonical: resolveAliasAgainst only answers for family shorthands.
 */
function servableTarget(target: string, bases: readonly string[]): string | null {
  const stripped = stripClaudePrefix(target);
  if (stripped === null) return null;
  const resolved = resolveAliasAgainst(stripped, bases) ?? stripped;
  const base = resolved.endsWith('[1m]') ? resolved.slice(0, -4) : resolved;
  return bases.some((b) => b.toLowerCase() === base) ? resolved : null;
}

/**
 * The id the Claude pool would serve `model` as AND the effort the entry asked
 * for, or null when the pool cannot serve it. `bases` is the catalog base set —
 * `getCachedBases()` at a call site, a fixture in a test. `resolve` is the alias
 * pipeline; the default knows only catalog family shorthands, so pass the
 * proxy's full resolver (operator aliases + pinned aliases) where one exists.
 */
export function resolveClaudeTarget(
  model: string,
  bases: readonly string[] = BAKED_BASE_MODELS,
  resolve?: ModelResolver,
): ClaudeTarget | null {
  const entry = stripClaudePrefix(model.trim().toLowerCase());
  if (entry === null) return null;

  // The alias TARGET may carry a prefix of its own — operator aliases are
  // declared the way a request model is written, and `--model-alias=backup=
  // claude:opus` is the natural way to say it (dario#1151). The request path
  // parses that prefix AFTER alias resolution; without the same pass here the
  // target reached the base check as the literal `claude:opus`, matched
  // nothing, and a perfectly valid fallback was skipped.
  const target = (resolve ? resolve(entry) : (resolveAliasAgainst(entry, bases) ?? entry))
    .trim().toLowerCase();

  const direct = servableTarget(target, bases);
  if (direct) return { model: direct };

  // …and it may carry an effort suffix as well (`claude:opus:high`,
  // `claude-opus-4-8-high`), which the request path strips on the Claude side
  // exactly like this (dario#419, proxy.ts). Without the same pass the suffix
  // survived into the base check, matched nothing, and the entry was silently
  // unservable — the prefix fix in #1156 left this half unresolved. Tried only
  // AFTER the name as written fails, so a real id that happens to end in an
  // effort word keeps priority over the suffix reading.
  //
  // The effort is RETURNED, not discarded: an operator who writes `:high` on a
  // chain entry is choosing the effort the failover request runs at, and the
  // request path honours exactly that spelling for a client-sent model. Serving
  // the failover at the pool default instead would silently answer a `high`
  // request at whatever `--effort` happens to be (dario#1161).
  const eff = parseEffortSuffix(target);
  if (!eff.effort) return null;
  const stripped = servableTarget(eff.model, bases);
  return stripped ? { model: stripped, effort: eff.effort } : null;
}

/**
 * The canonical id alone, for callers that only need to name the model. See
 * resolveClaudeTarget for the effort half.
 */
export function resolveClaudeServable(
  model: string,
  bases: readonly string[] = BAKED_BASE_MODELS,
  resolve?: ModelResolver,
): string | null {
  return resolveClaudeTarget(model, bases, resolve)?.model ?? null;
}

/** Whether the Claude pool can serve `model`. See resolveClaudeTarget. */
export function isClaudeServableModel(
  model: string,
  bases: readonly string[] = BAKED_BASE_MODELS,
  resolve?: ModelResolver,
): boolean {
  return resolveClaudeTarget(model, bases, resolve) !== null;
}
