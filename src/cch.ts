// Deterministic Claude Code request-integrity hash (`cch`) — dario#528.
//
// Claude Code stamps each /v1/messages request with a 5-hex `cch` token inside
// the `x-anthropic-billing-header` system block. It is NOT random: it is an
// xxHash64 over a canonical PROJECTION of the request body, masked to 20 bits.
// Reverse-engineered by lwsh123k (dario#528) and verified here against live
// captures on Claude Code 2.1.177:
//
//   material = the serialized body, transformed by:
//     1. reset the `cch=XXXXX` token to `cch=00000`
//     2. blank the "model" VALUE (keep the key)
//     3. delete "fallbacks", "fallback_credit_token", "max_tokens"
//     4. re-serialize as compact JSON (JSON.stringify)
//   cch = ( xxHash64(material, SEED[version]) & 0xFFFFF ) as zero-padded 5-hex
//
// The excluded fields are exactly the ones a routing proxy rewrites (model,
// fallbacks, max_tokens), so the value is STABLE across dario's rewrites — the
// upstream re-derives the same projection from whatever we send and recomputes
// the identical hash. dario therefore only has to hash its own final body.
//
// The seed rotates per Claude Code release and is keyed on major.minor.patch
// (the build-tag suffix, e.g. ".e2d" vs ".dd9", does NOT change it — verified
// against two captures with different suffixes, same 2.1.177 seed). An unknown
// version returns null so the caller falls back to a random value (the
// pre-dario#528 behavior) rather than emitting a confident-but-wrong hash that
// a validating server could single out.

/** Verified per-release seeds, keyed on `major.minor.patch`. */
export const CCH_SEEDS: Record<string, bigint> = {
  '2.1.177': 0x4d659218e32a3268n,
};

const MASK = 0xfffffn;
const U64 = (1n << 64n) - 1n;

// xxHash64 primes.
const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;

const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & U64;

function round(acc: bigint, input: bigint): bigint {
  acc = (acc + input * P2) & U64;
  acc = rotl(acc, 31n);
  return (acc * P1) & U64;
}

function mergeRound(acc: bigint, val: bigint): bigint {
  const r = round(0n, val);
  acc = (acc ^ r) & U64;
  return (acc * P1 + P4) & U64;
}

/** Canonical xxHash64 of `data` with a 64-bit `seed`. */
export function xxh64(data: Uint8Array, seed: bigint): bigint {
  const len = data.length;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let h: bigint;
  let i = 0;

  if (len >= 32) {
    let v1 = (seed + P1 + P2) & U64;
    let v2 = (seed + P2) & U64;
    let v3 = seed & U64;
    let v4 = (seed - P1) & U64;
    const limit = len - 32;
    while (i <= limit) {
      v1 = round(v1, dv.getBigUint64(i, true)); i += 8;
      v2 = round(v2, dv.getBigUint64(i, true)); i += 8;
      v3 = round(v3, dv.getBigUint64(i, true)); i += 8;
      v4 = round(v4, dv.getBigUint64(i, true)); i += 8;
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & U64;
    h = mergeRound(h, v1);
    h = mergeRound(h, v2);
    h = mergeRound(h, v3);
    h = mergeRound(h, v4);
  } else {
    h = (seed + P5) & U64;
  }

  h = (h + BigInt(len)) & U64;

  while (i + 8 <= len) {
    const k1 = round(0n, dv.getBigUint64(i, true));
    h = (h ^ k1) & U64;
    h = (rotl(h, 27n) * P1 + P4) & U64;
    i += 8;
  }
  if (i + 4 <= len) {
    h = (h ^ ((BigInt(dv.getUint32(i, true)) * P1) & U64)) & U64;
    h = (rotl(h, 23n) * P2 + P3) & U64;
    i += 4;
  }
  while (i < len) {
    h = (h ^ ((BigInt(data[i]) * P5) & U64)) & U64;
    h = (rotl(h, 11n) * P1) & U64;
    i += 1;
  }

  h = (h ^ (h >> 33n)) & U64;
  h = (h * P2) & U64;
  h = (h ^ (h >> 29n)) & U64;
  h = (h * P3) & U64;
  h = (h ^ (h >> 32n)) & U64;
  return h;
}

const CCH_RE = /cch=[0-9a-fA-F]{5}/;

/** Build the canonical cch pre-image bytes from a serialized request body. */
function cchMaterial(bodyText: string): Uint8Array {
  const zeroed = bodyText.replace(CCH_RE, 'cch=00000'); // first occurrence only
  const body = JSON.parse(zeroed) as Record<string, unknown>;
  body.model = '';
  delete body.fallbacks;
  delete body.fallback_credit_token;
  delete body.max_tokens;
  return new TextEncoder().encode(JSON.stringify(body));
}

/**
 * Deterministic 5-hex cch for a serialized body under an EXPLICIT seed, or
 * null if the body carries no `cch=XXXXX` token. Used by `scripts/cch-
 * calibrate.mjs` to test candidate seeds against a live capture without going
 * through the version table.
 */
export function cchWithSeed(bodyText: string, seed: bigint): string | null {
  if (!CCH_RE.test(bodyText)) return null;
  const h = xxh64(cchMaterial(bodyText), seed) & MASK;
  return h.toString(16).padStart(5, '0');
}

/**
 * Deterministic 5-hex `cch` for a serialized request body, or null when:
 *  - `version` (major.minor.patch) has no known seed, or
 *  - the body carries no `cch=XXXXX` billing token to stamp.
 * A null return means the caller should keep its random placeholder.
 */
export function cchForBody(bodyText: string, version: string): string | null {
  const seed = CCH_SEEDS[version];
  if (seed === undefined) return null;
  return cchWithSeed(bodyText, seed);
}
