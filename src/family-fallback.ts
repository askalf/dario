// Family fallback: a request for a model family every pool seat is parked on
// is served as another Claude model the pool can still serve, instead of
// answering 429 or leaving the Claude pool. The case it is for is Fable, which
// is metered on a seat's included credit rather than its 5h and 7d windows:
// once that credit is spent the seat still has room for Opus, but every Fable
// request is parked until the credit resets.
//
// Strictly opt-in. Sourced from `--family-fallback=fable=claude-opus-5-5` /
// `DARIO_FAMILY_FALLBACK` / config `familyFallback`. Pure: the proxy passes in
// what the pool says, so the decision is testable without one.

import { KNOWN_FAMILIES, modelFamily } from './pool.js';

/** Source family → target Claude model. */
export type FamilyFallbackMap = ReadonlyMap<string, string>;

export interface ParsedFamilyFallback {
  map: Map<string, string>;
  /** One line per entry that was dropped, saying why. */
  errors: string[];
}

const ONE_M = /\[1m\]$/i;

/**
 * Parse `fable=claude-opus-5-5,sonnet=claude-haiku-5` (or the same pairs from
 * a config object). A source must be a family `modelFamily` knows; a target
 * must name a Claude model of a DIFFERENT known family, so a fallback can never
 * point back at the family it is leaving. Bad entries are dropped and reported,
 * the rest kept. Later entries for the same family win.
 */
export function parseFamilyFallback(spec: string | Record<string, unknown> | null | undefined): ParsedFamilyFallback {
  const map = new Map<string, string>();
  const errors: string[] = [];
  if (spec === null || spec === undefined) return { map, errors };
  const pairs: Array<[string, unknown]> = typeof spec === 'string'
    ? spec.split(',').map((s) => s.trim()).filter(Boolean).map((entry): [string, unknown] => {
        const eq = entry.indexOf('=');
        return eq < 0 ? [entry, undefined] : [entry.slice(0, eq), entry.slice(eq + 1)];
      })
    : Object.entries(spec);
  for (const [rawFrom, rawTo] of pairs) {
    const from = rawFrom.trim().toLowerCase();
    const to = typeof rawTo === 'string' ? rawTo.trim() : '';
    if (!KNOWN_FAMILIES.includes(from)) {
      errors.push(`"${rawFrom}": not a model family (one of ${KNOWN_FAMILIES.join(', ')})`);
      continue;
    }
    if (!to) {
      errors.push(`"${rawFrom}": no target model (write ${from}=<model>)`);
      continue;
    }
    const toFamily = modelFamily(to);
    if (!toFamily || !/^claude-/i.test(to)) {
      errors.push(`"${rawFrom}=${to}": the target must be a claude-* model of a known family`);
      continue;
    }
    if (toFamily === from) {
      errors.push(`"${rawFrom}=${to}": the target is the same family`);
      continue;
    }
    map.set(from, to);
  }
  return { map, errors };
}

/**
 * The model to serve `model` as, or null to leave the request alone.
 *
 * `parked(family)` is whether a rate limit keeps every pool seat off that
 * family (`AccountPool.familyRateLimited`), and `servable(family)` whether some seat
 * is eligible for it right now. The switch happens only when the request's own
 * family is parked and the target's is servable: a pool that is merely busy,
 * expiring a token or empty keeps its existing handling, and a target that is
 * parked too gains nothing. One step, never chained.
 *
 * A `[1m]` long-context tag on the request is carried onto the target when the
 * target has none, so the switch does not shrink the context window asked for.
 *
 * A model name that is not printable ASCII (at most 256 characters, no spaces
 * or control characters) is left alone: no real model is named so, and the
 * name the client sent is echoed in the `x-dario-family-fallback` header and
 * the log, where a line break would fail the header (setHeader throws, the
 * request errors) or forge a log line.
 */
export function familyFallbackModel(
  map: FamilyFallbackMap,
  model: string,
  pool: { parked: (family: string) => boolean; servable: (family: string) => boolean },
): string | null {
  if (map.size === 0) return null;
  if (!/^[\x21-\x7e]{1,256}$/.test(model)) return null;
  const family = modelFamily(model);
  if (!family) return null;
  const target = map.get(family);
  if (!target) return null;
  const targetFamily = modelFamily(target);
  if (!targetFamily || !pool.parked(family) || !pool.servable(targetFamily)) return null;
  return ONE_M.test(model.trim()) && !ONE_M.test(target) ? `${target}[1m]` : target;
}

/** `fable → claude-opus-5-5, sonnet → claude-haiku-5`, for the startup banner and doctor. */
export function describeFamilyFallback(map: FamilyFallbackMap): string {
  return [...map].map(([from, to]) => `${from} → ${to}`).join(', ');
}
