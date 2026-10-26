/**
 * The credits rung of the failover chain.
 *
 * Since October 2026 a Max plan includes monthly Claude API credits ($100 on
 * Max 5x, $200 on Max 20x). They are spent through a Console API key of the
 * organization the plan is linked to, not through the seat's own five-hour
 * and weekly windows, so until now the only ways to spend them through dario
 * were ANTHROPIC_UPSTREAM_API_KEY (the whole Claude backend on the key, pool
 * bypassed) or an OpenAI-compat backend pointed at Anthropic's compatibility
 * layer, which Anthropic describes as a layer for testing models.
 *
 * A chain entry written `credits:<model>` names the key as a rung. When every
 * seat is drained or cooling and no subscription rung can serve, the request
 * goes to api.anthropic.com on the Messages path as a plain API request: the
 * client's own body with the model swapped, `x-api-key`, no Claude Code
 * template and no OAuth beta. Both wire shapes work, because the Claude path
 * already translates OpenAI-shape requests and responses. The response says
 * `x-dario-pool-fallback: credits:<model>`; the rolling window, `/metrics`
 * and the dashboard file the request under its own billing bucket, `credits`,
 * next to extra usage and API key; the persistent ledger counts it in its
 * metered total, as spent; and the overage guard does not halt on it: a rung
 * the operator configured is not a surprise bill.
 *
 * The key comes from DARIO_CREDITS_API_KEY only, never a flag, so it never
 * lands in argv. The rung is opt-in twice: the entry must be in the chain AND
 * the key must be set. Without the key the entry is inert, the proxy says so
 * at startup and `dario doctor` says so in its Failover line.
 *
 * Where it sits: a subscription rung (a Codex account that lists an entry)
 * always goes first, because the plan is the thing dario exists to spend.
 * Among the metered rungs, this one and the openai-compat backend, the
 * chain's own left-to-right order decides.
 */

import { resolveClaudeTarget, type ClaudeTarget, type ModelResolver } from './claude-model.js';

export const CREDITS_PREFIX = 'credits:';

/** The analytics `account` of a request the credits rung served. */
export const ACCOUNT_KEY_CREDITS = '__credits__';

/** The OAuth-enablement beta a plain API request must not carry. */
const OAUTH_BETA = 'oauth-2025-04-20';

/** The value of `x-dario-pool-fallback` on a response the rung served. */
export function creditsFallbackMarker(model: string): string {
  return `${CREDITS_PREFIX}${model}`;
}

export function isCreditsEntry(entry: string): boolean {
  return entry.trim().toLowerCase().startsWith(CREDITS_PREFIX);
}

/** The model half of a `credits:<model>` entry as written; null for any other entry. */
export function creditsEntryModel(entry: string): string | null {
  const e = entry.trim();
  if (!e.toLowerCase().startsWith(CREDITS_PREFIX)) return null;
  const model = e.slice(CREDITS_PREFIX.length).trim();
  return model || null;
}

/** Every credits entry's model as written, in chain order. */
export function creditsEntries(chain: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of chain) {
    const model = creditsEntryModel(entry);
    if (model) out.push(model);
  }
  return out;
}

/** The chain without its credits entries: what the subscription and openai-compat rungs read. */
export function withoutCreditsEntries(chain: readonly string[]): string[] {
  return chain.filter((entry) => !isCreditsEntry(entry));
}

/**
 * True when the credits rung is asked before the openai-compat backend: the
 * first credits entry precedes every plain entry, or there is no plain entry.
 * False when the chain has no credits entry at all.
 */
export function creditsBeforePlain(chain: readonly string[]): boolean {
  const credits = chain.findIndex((entry) => isCreditsEntry(entry));
  if (credits < 0) return false;
  const plain = chain.findIndex((entry) => !isCreditsEntry(entry));
  return plain < 0 || credits < plain;
}

/**
 * The first credits entry the Claude catalog can serve, resolved exactly like
 * a Claude chain entry: aliases (`credits:sonnet`), a provider prefix
 * (`credits:anthropic:claude-opus-5`) and an effort suffix spelled the way a
 * Claude entry spells it (`credits:claude:opus:high`, `credits:claude-opus-5-high`)
 * all work, and a name the catalog does not list is skipped rather than sent, so
 * a typo cannot trade a recoverable 429 for a 404 billed to the key.
 */
export function pickCreditsTarget(
  chain: readonly string[],
  bases?: readonly string[],
  resolve?: ModelResolver,
): ClaudeTarget | null {
  for (const entry of chain) {
    const model = creditsEntryModel(entry);
    if (!model) continue;
    const target = resolveClaudeTarget(model, bases, resolve);
    if (target) return target;
  }
  return null;
}

/**
 * Outbound headers for a credits request: the headers a plain API client
 * sends and nothing of Claude Code's identity. The client's own betas go
 * through minus the OAuth flag, which an API key request must not carry.
 */
export function creditsHeaders(
  key: string,
  clientBeta: string | undefined,
  anthropicVersion = '2023-06-01',
): Record<string, string> {
  const headers: Record<string, string> = {
    'accept': 'application/json',
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': anthropicVersion,
  };
  const beta = (clientBeta ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter((b) => b.length > 0 && b !== OAUTH_BETA)
    .join(',');
  if (beta) headers['anthropic-beta'] = beta;
  return headers;
}

/**
 * One phrase for the startup line and `dario doctor`, or null when the chain
 * names no credits entry.
 */
export function describeCreditsRung(chain: readonly string[], hasKey: boolean): string | null {
  const credits = creditsEntries(chain);
  if (credits.length === 0) return null;
  const model = credits[0]!;
  return hasKey
    ? `API credits as ${model} (x-api-key on the Messages path, both wire shapes, billing bucket credits, metered in the ledger)`
    : `credits:${model} named but DARIO_CREDITS_API_KEY is not set, so that rung is inert`;
}
