// Fuzz the upstream-rejection parsers — the regexes dario runs over RAW 400
// bodies from the upstream API to learn a model's supported effort tiers and
// max_tokens cap — plus the provider-prefix parser that routes on the
// client-supplied `model` field. Rejection bodies and model strings are both
// wire input from a party dario does not control. Contracts: never throw,
// never hang (a super-linear regex here is a denial-of-service on the
// error-recovery path), and return only the documented shapes —
// parseEffortRejection null or a rejected tier + non-empty supported list,
// parseMaxTokensRejection null or a positive finite cap, parseProviderPrefix
// null or a known provider + non-empty model.
import {
  parseEffortRejection,
  isEffortParamUnsupported,
  parseMaxTokensRejection,
  bestSupportedEffort,
  parseProviderPrefix,
} from '../dist/proxy.js';

export function fuzz(data) {
  const s = data.toString('utf8');

  // The raw fuzz body, plus variants seeded with the real upstream anchors so
  // the regexes' interesting paths run on adversarial surroundings.
  const bodies = [
    s,
    `does not support effort level '${s.slice(0, 32)}'. Supported levels: ${s.slice(0, 64)}`,
    `${s} does not support the effort parameter ${s}`,
    `max_tokens: ${s.slice(0, 24)} > ${s.slice(0, 24)}, which is the maximum allowed ${s}`,
  ];
  for (const body of bodies) {
    const eff = parseEffortRejection(body);
    if (eff !== null) {
      if (typeof eff.rejected !== 'string' || !Array.isArray(eff.supported) || eff.supported.length === 0) {
        throw new Error(`parseEffortRejection returned a malformed shape: ${JSON.stringify(eff)}`);
      }
      // Whatever tiers came off the wire, the clamp target must come out usable.
      if (typeof bestSupportedEffort(eff.supported) !== 'string') {
        throw new Error('bestSupportedEffort returned a non-string');
      }
    }
    if (typeof isEffortParamUnsupported(body) !== 'boolean') {
      throw new Error('isEffortParamUnsupported returned a non-boolean');
    }
    const cap = parseMaxTokensRejection(body);
    if (cap !== null && (!Number.isFinite(cap) || cap <= 0)) {
      throw new Error(`parseMaxTokensRejection returned a non-positive cap: ${cap}`);
    }
  }

  // Client-supplied model strings: raw, correctly prefixed, and colon-riddled.
  for (const model of [s, `openai:${s}`, `claude:${s}`, `:${s}`, `${s}:${s}`]) {
    const route = parseProviderPrefix(model);
    if (route !== null) {
      if ((route.provider !== 'openai' && route.provider !== 'claude') || typeof route.model !== 'string' || route.model.length === 0) {
        throw new Error(`parseProviderPrefix returned a malformed route: ${JSON.stringify(route)}`);
      }
    }
  }
}
