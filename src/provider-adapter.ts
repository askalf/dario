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
 * The adapters reuse the same primitives proxy.ts uses (`isOpenAIModel`,
 * `isCodexModel`), so this is a consolidation of the existing decision, not a
 * re-derivation of it.
 */

import { isOpenAIModel } from './openai-backend.js';
import { isCodexModel } from './codex-backend.js';

export type ProviderId = 'claude' | 'openai' | 'codex';

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
  /** At least one Codex/ChatGPT-subscription account is stored (`dario codex add …`). */
  hasCodexAccount: boolean;
  /** Model slugs the Codex backend lists for the selected account (discovered, cached). */
  codexModels: readonly string[];
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
 * Codex/ChatGPT-subscription adapter — the "altman" engine (dario#1009).
 * Claims an OpenAI-shape request when a Codex account is stored and either the
 * model carries a `codex:`/`chatgpt:` prefix or its name is one the backend
 * itself listed for that account (`codexModels`, discovered by
 * codex-backend.ts — the slugs are per-account and move, so they are never
 * hardcoded here). Ranks above the openai adapter so a listed slug reaches the
 * subscription even when an API-key backend is also configured; anything not
 * listed — `gpt-4o` and friends — is untouched and still lands on that backend.
 *
 * Serves BOTH request shapes. The ChatGPT backend speaks Responses, and dario
 * now owns a translation for each side of it: chat/completions⇄Responses in
 * codex-backend.ts, and Messages⇄Responses in anthropic-responses-translate.ts
 * (dario#1141). So an Anthropic-shape /v1/messages request naming a listed slug
 * is served from the subscription too — which is what lets a Claude-shaped
 * harness (Claude Code, or any Anthropic-SDK client) run on a ChatGPT plan.
 *
 * There is deliberately no path guard: the claim is driven by the MODEL, and a
 * Claude model is never in `codexModels`, so Claude traffic on either path is
 * untouched. The `openai` adapter below keeps its OpenAI-path guard — the
 * API-key backend has no Messages translation.
 */
export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  priority: 200,
  claimsPrimary(ctx: RouteContext): boolean {
    if (!ctx.hasCodexAccount) return false;
    if (ctx.forcedProvider === 'claude' || ctx.forcedProvider === 'openai') return false;
    return ctx.forcedProvider === 'codex' || isCodexModel(ctx.model, ctx.codexModels);
  },
};

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
    if (ctx.forcedProvider === 'claude' || ctx.forcedProvider === 'codex') return false;
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

export const DEFAULT_ADAPTERS: readonly ProviderAdapter[] = [codexAdapter, openaiAdapter, claudeAdapter];

/**
 * Resolve the routing decision. Offers the request to adapters in priority
 * order and takes the first primary claim; the Claude adapter always claims, so
 * the result is total. The claude→openai pool fallback is layered on top
 * because it's a cross-adapter relationship (a Claude-primary request that
 * spills to openai on pool exhaustion), not a primary claim by either side.
 */
/**
 * Who serves a request the Claude pool could not, and on which wire shapes.
 *
 * This exists because v6.0.0 shipped the failover dispatcher correctly and the
 * GATE in front of it wrongly. `selectPoolAccount()` in proxy.ts still required
 * an api-key backend AND the OpenAI path before it would defer, so a box with a
 * Codex account and no api-key backend — the deployment this release is FOR —
 * got a 503 before the dispatcher ran, and Anthropic-shape requests never
 * reached it at all. Every routing test passed, because not one of them went
 * through that selector.
 *
 * So the matrix lives here, in one place, stated once:
 *
 *   codex account lists the model     → 'codex'       (both wire shapes)
 *   else api-key backend, OpenAI path → 'openai'      (no Messages translation)
 *   else                              → 'unavailable' (honest 503)
 *
 * A caveat worth keeping in view: this is a SPECIFICATION test surface, not a
 * wiring one. It cannot prove proxy.ts asks it the right question at the right
 * moment — that is precisely what broke — and only a live request through the
 * selector can. Treat green here as necessary, never sufficient.
 */
export type PoolFallbackOutcome = 'codex' | 'openai' | 'unavailable';

export function poolFallbackOutcome(input: {
  fallbackModels: readonly string[];
  poolSize: number;
  /** A stored Codex account LISTS one of `fallbackModels`. */
  codexServes: boolean;
  hasOpenAIBackend: boolean;
  isOpenAIPath: boolean;
}): PoolFallbackOutcome {
  const { fallbackModels, poolSize, codexServes, hasOpenAIBackend, isOpenAIPath } = input;
  // Unarmed, or an empty pool, is not a failover situation at all: an empty
  // pool is a setup error the operator must see, not traffic to re-bill.
  if (fallbackModels.length === 0 || poolSize === 0) return 'unavailable';
  if (codexServes) return 'codex';
  if (hasOpenAIBackend && isOpenAIPath) return 'openai';
  return 'unavailable';
}

export function route(
  ctx: RouteContext,
  adapters: readonly ProviderAdapter[] = DEFAULT_ADAPTERS,
): RouteDecision {
  const ordered = [...adapters].sort((a, b) => b.priority - a.priority);
  const primary = ordered.find((a) => a.claimsPrimary(ctx)) ?? claudeAdapter;

  let fallback: ProviderId | null = null;
  let reason = `${primary.id} primary`;
  // NOTE: this reports the CLAUDE-PRIMARY direction. The reverse — a codex
  // primary declining a 429/5xx so the request lands on the Claude pool — is
  // dispatched in proxy.ts, because it is a mid-flight decision that depends
  // on the upstream's answer rather than on anything knowable when routing.
  //
  // Pool-exhaustion failover (v6.0.0). The target is whichever provider can
  // actually serve `poolFallbackModel`, which makes a SECOND SUBSCRIPTION a
  // first-class failover target rather than requiring an API key.
  //
  // codex is preferred when the nominated model is one its account lists: it
  // is a plan you already pay for, so failover costs nothing per token, and
  // since v5.5.87 it serves BOTH wire shapes — an Anthropic-shape client
  // (Claude Code, any Anthropic SDK, a fleet agent) can fail over too. The
  // api-key backend keeps its OpenAI-path guard: there is still no Messages
  // translation on that route.
  if (primary.id === 'claude' && ctx.poolFallbackModel !== null && ctx.poolSize > 0) {
    if (ctx.hasCodexAccount && isCodexModel(ctx.poolFallbackModel, ctx.codexModels)) {
      fallback = 'codex';
      reason = 'claude primary, codex (subscription) fallback on pool-exhaustion';
    } else if (ctx.hasOpenAIBackend && ctx.isOpenAIPath) {
      fallback = 'openai';
      reason = 'claude primary, openai fallback on pool-exhaustion';
    }
  }
  return { provider: primary.id, fallback, reason };
}
