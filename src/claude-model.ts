/**
 * "Can the Claude pool actually serve this model name?" — the positive test
 * the reverse half of failover needs.
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
 * So the rule is positive: a name qualifies only if it carries an explicit
 * Claude provider prefix, names the `claude-` family directly, or is a family
 * shorthand the catalog resolves (`opus`, `sonnet1m`). Anything else is served
 * by neither end of the chain and is skipped, which surfaces the real upstream
 * error instead of a fabricated one from the wrong provider.
 *
 * Pure over the base set it is handed, matching model-catalog.ts's rules, so
 * the whole selection stays testable without a socket.
 */
import { resolveAliasAgainst } from './model-catalog.js';

/** Provider prefixes that force the Claude path (mirrors proxy.ts's PROVIDER_PREFIXES). */
const CLAUDE_PREFIXES = new Set(['claude', 'anthropic']);

/**
 * Whether the Claude pool can serve `model`. `bases` is the live catalog base
 * set — pass `getCachedBases()` at a call site, or a fixture in a test.
 *
 * Prefixed names (`claude:opus`) qualify on the prefix alone: an explicit
 * provider prefix is the operator naming the provider, which outranks any
 * name-shape guess. The proxy strips the prefix downstream, so the chain entry
 * is returned as written.
 */
export function isClaudeServableModel(model: string, bases: readonly string[] = []): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;

  const idx = m.indexOf(':');
  if (idx > 0) {
    const prefix = m.slice(0, idx);
    // A recognized non-Claude prefix is a definite NO, not a fall-through to
    // the name test below — `openai:claude-sonnet-5` is the operator pointing
    // somewhere else on purpose.
    if (!CLAUDE_PREFIXES.has(prefix)) return false;
    return m.slice(idx + 1).length > 0;
  }

  // `claude-opus-4-8`, `claude-sonnet-5[1m]` — the canonical ids the pool
  // forwards upstream unchanged.
  if (m.startsWith('claude-')) return true;

  // Family shorthands (`opus`, `sonnet1m`) are what the Claude path resolves
  // through resolveClaudeAlias before forwarding, so they are servable too —
  // but only when the catalog can actually resolve them, which keeps a bare
  // `gpt` or a typo out.
  return resolveAliasAgainst(m, bases) !== null;
}
