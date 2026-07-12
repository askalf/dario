// Fuzz the deterministic cch request-integrity stamp — the anchored-regex
// projection + xxHash64 that dario recomputes over every outbound /v1/messages
// body so its model/fallback rewrites stay consistent with the billing
// header's cch token. The body text embeds client-supplied conversation
// content, which may itself quote cch-lookalikes. Contracts: xxh64 never
// throws and stays in the u64 domain on arbitrary bytes/seeds; on a valid-JSON
// body the stamp is 5 lowercase hex chars, stamping is idempotent, keeps the
// body valid JSON, and only ever rewrites the anchored billing token (a
// mis-anchored match silently corrupts the user's own text — dario#528). On
// garbage that merely LOOKS like it carries a billing token, JSON.parse's
// SyntaxError is the documented garbage-in contract (callers stamp bodies they
// just serialized), so SyntaxError is expected; anything else is a finding.
import { xxh64, cchWithSeed, cchForBody, stampCch } from '../dist/cch.js';

const U64 = (1n << 64n) - 1n;

export function fuzz(data) {
  const s = data.toString('utf8');

  // 1. The hash core on raw bytes with a fuzz-derived seed.
  const seed = data.length >= 8 ? data.readBigUInt64LE(0) : BigInt(data.length);
  const h = xxh64(data, seed);
  if (typeof h !== 'bigint' || h < 0n || h > U64) {
    throw new Error(`xxh64 left the u64 domain: ${h}`);
  }

  // 2. A guaranteed-valid-JSON body carrying a real billing tag, with the fuzz
  //    string as conversation content AFTER it (which may quote cch=xxxxx —
  //    the anchored rewrite must never touch it).
  const body = JSON.stringify({
    model: 'claude-opus-4-6',
    max_tokens: 32000,
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.177; cc_entrypoint=cli; cch=abc12;' }],
    messages: [{ role: 'user', content: s }],
    metadata: { user_id: s.slice(0, 64) },
  });
  const cch = cchWithSeed(body, seed);
  if (cch !== null && !/^[0-9a-f]{5}$/.test(cch)) {
    throw new Error(`cchWithSeed produced a non-5-hex token: ${JSON.stringify(cch)}`);
  }
  const stamped = stampCch(body, '2.1.177');
  JSON.parse(stamped); // the stamp must never break the body's JSON
  if (stamped.length !== body.length) {
    // 5-hex → 5-hex anchored replacement: anything else means the rewrite
    // escaped the billing tag and rewrote conversation content.
    throw new Error('stampCch changed the body length');
  }
  if (stampCch(stamped, '2.1.177') !== stamped) {
    throw new Error('stampCch is not idempotent');
  }

  // 3. Raw fuzz text as the body: past the billing-token gate, a JSON.parse
  //    SyntaxError is the documented contract for non-JSON input — only that
  //    error class is expected.
  for (const raw of [s, `{"a":"cc_entrypoint=cli; cch=00000;${s}"}`]) {
    try {
      cchForBody(raw, '2.1.177');
      stampCch(raw, '2.1.177');
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
}
