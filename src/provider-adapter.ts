/**
 * Provider routing seam.
 *
 * dario's "which backend owns this request" decision used to live inline in the
 * request handler as a set of interleaved conditions (path class, provider
 * prefix, GPT-family model test, the openai-backend reroute guard, the pool
 * fallback guard). This module consolidates that decision into one place: a
 * small set of `ProviderAdapter`s and a `route()` function that returns the
 * primary provider plus any exhaustion fallback.
 *
 * Scope is deliberately the DECISION, not the request lifecycle. The Claude
 * path's pool/template/cch/session/overage machinery stays shared below this
 * seam — it's infrastructure that happens to serve one provider, not per-
 * provider behaviour, so pushing it behind an adapter interface would make the
 * Claude adapter the whole proxy and the OpenAI adapter nearly empty. The seam
 * that pays for itself is routing + request-shaping; the rest is shared.
 *
 * The adapters reuse the same primitive proxy.ts uses (`isOpenAIModel`), so this
 * is a consolidation of the existing decision, not a re-derivation of it.
 */

import { isOpenAIModel } from './openai-backend.js';

export type ProviderId = 'claude' | 'openai';

/** Inputs the routing decision needs, computed once per request. */
export interface RouteContext {
  /** urlPath === '/v1/chat/completions' (OpenAI chat shape). */
  isOpenAIPath: boolean;
  /** Model name after provider-prefix stripping (e.g. 'gpt-4o', 'claude-opus-4-8'). */
  model: string;
  /** Forced provider from a `<provider>:` prefix or `--model` override; null if unforced. */
  forcedProvider: ProviderId | null;
  /** An openai-compat backend is configured (`dario backend add …`). */
  hasOpenAIBackend: boolean;
  /** `--pool-fallback=<model>` value, or null when disabled. */
  poolFallbackModel: string | null;
  /** Live pool account count. */
  poolSize: number;
}

export interface RouteDecision {
  /** Primary handler for the request. */
  provider: ProviderId;
  /** Provider to fall to on primary exhaustion; only claude→openai exists today. */
  fallback: ProviderId | null;
  /** Human-readable trace for `--verbose` and tests. */
  reason: string;
}

export interface ProviderAdapter {
  id: ProviderId;
  /** Higher priority is offered the request first. */
  priority: number;
  /** True if this adapter should PRIMARILY handle the request. */
  claimsPrimary(ctx: RouteContext): boolean;
}

/**
 * OpenAI-compat backend adapter. Claims a request under exactly the condition
 * the request handler reroutes on: a configured backend, an OpenAI-shape
 * request, not force-routed to Claude, and either force-routed to openai or a
 * recognized GPT-family model.
 */
export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  priority: 100,
  claimsPrimary(ctx: RouteContext): boolean {
    if (!ctx.hasOpenAIBackend) return false;
    if (!ctx.isOpenAIPath) return false;
    if (ctx.forcedProvider === 'claude') return false;
    return ctx.forcedProvider === 'openai' || isOpenAIModel(ctx.model);
  },
};

/**
 * Claude adapter — the default owner. Claims anything the openai adapter
 * doesn't, matching the request handler's fall-through to the template path
 * (including OpenAI-shape requests with Claude models, which the Claude path
 * serves via openai→anthropic translation).
 */
export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  priority: 0,
  claimsPrimary(): boolean {
    return true;
  },
};

export const DEFAULT_ADAPTERS: readonly ProviderAdapter[] = [openaiAdapter, claudeAdapter];

/**
 * Resolve the routing decision. Offers the request to adapters in priority
 * order and takes the first primary claim; the Claude adapter always claims, so
 * the result is total. The claude→openai pool fallback is layered on top
 * because it's a cross-adapter relationship (a Claude-primary request that
 * spills to openai on pool exhaustion), not a primary claim by either side.
 */
export function route(
  ctx: RouteContext,
  adapters: readonly ProviderAdapter[] = DEFAULT_ADAPTERS,
): RouteDecision {
  const ordered = [...adapters].sort((a, b) => b.priority - a.priority);
  const primary = ordered.find((a) => a.claimsPrimary(ctx)) ?? claudeAdapter;

  let fallback: ProviderId | null = null;
  let reason = `${primary.id} primary`;
  if (
    primary.id === 'claude' &&
    ctx.poolFallbackModel !== null &&
    ctx.hasOpenAIBackend &&
    ctx.isOpenAIPath &&
    ctx.poolSize > 0
  ) {
    fallback = 'openai';
    reason = 'claude primary, openai fallback on pool-exhaustion';
  }
  return { provider: primary.id, fallback, reason };
}
