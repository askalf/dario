// Unit tests for `orderBodyForOutbound` (src/cc-template.ts) — the v3.22
// helper that replays the captured CC top-level request-body key order on
// every outbound /v1/messages call. JSON is unordered as a type but the
// wire serialization IS ordered — two bodies with the same fields but
// different key order produce different bytes and are trivial to
// fingerprint on.
//
// Pattern mirrors test/proxy-header-order.mjs but without the
// case-insensitive matching (JSON body keys are case-sensitive).

import { orderBodyForOutbound } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

// ======================================================================
//  Empty override order → passthrough (reference-equal)
// ======================================================================
// When the template has no body_field_order (pre-v3.22 baked fallback or
// absence) the helper returns the input unchanged. The test form uses an
// explicit `[]` override because the baked template now ships the order
// in production — passing undefined would exercise the replay path, not
// the passthrough path.
header('orderBodyForOutbound — empty order returns input unchanged');
{
  const b = { model: 'claude-opus-4-5', messages: [], system: [] };
  const out = orderBodyForOutbound(b, []);
  check('empty order → same record (reference-equal)', out === b);
}

// ======================================================================
//  With captured order → keys emitted in captured order
// ======================================================================
header('orderBodyForOutbound — captured order is preserved');
{
  const b = {
    stream: true,
    max_tokens: 32000,
    model: 'claude-opus-4-5',
    metadata: { user_id: 'x' },
    system: [{ type: 'text', text: 'hi' }],
    messages: [{ role: 'user', content: 'yo' }],
    tools: [],
  };
  const order = ['model', 'messages', 'system', 'tools', 'metadata', 'max_tokens', 'stream'];

  const out = orderBodyForOutbound(b, order);
  check('returns a record (not an array)', !Array.isArray(out) && typeof out === 'object');
  check('all seven keys present', Object.keys(out).length === 7);
  check(
    'Object.keys walks the captured order',
    JSON.stringify(Object.keys(out)) === JSON.stringify(order),
  );
  check(
    'JSON.stringify wire order matches captured order',
    JSON.stringify(out).indexOf('"model"') < JSON.stringify(out).indexOf('"messages"') &&
      JSON.stringify(out).indexOf('"messages"') < JSON.stringify(out).indexOf('"stream"'),
  );
  check('model value round-trips', out.model === 'claude-opus-4-5');
  check('max_tokens value round-trips', out.max_tokens === 32000);
  check('nested objects are referenced, not cloned', out.metadata === b.metadata);
}

// ======================================================================
//  Case-sensitive matching (unlike headers)
// ======================================================================
header('orderBodyForOutbound — case-sensitive key matching');
{
  // JSON keys are case-sensitive. "Model" and "model" are distinct fields.
  // If a caller somehow supplied "Model" and the captured order lists
  // "model", the captured name is NOT synthesized — "Model" falls to the
  // extras tail. This prevents the helper from inventing a field value.
  const b = { Model: 'oops', messages: [] };
  const order = ['model', 'messages'];

  const out = orderBodyForOutbound(b, order);
  const keys = Object.keys(out);
  check('captured "model" skipped (not present case-sensitively)', !keys.includes('model'));
  check('caller "Model" preserved and appears as an extra', keys.includes('Model'));
  check('messages matched and present', keys.includes('messages'));
}

// ======================================================================
//  Extras (caller-supplied, not in captured order) are appended at tail
// ======================================================================
header('orderBodyForOutbound — extras go at the tail, in insertion order');
{
  const b = {
    model: 'claude-opus-4-5',
    messages: [],
    future_field_a: 'alpha',
    system: [],
    future_field_b: 'beta',
  };
  const order = ['model', 'messages', 'system'];

  const out = orderBodyForOutbound(b, order);
  const keys = Object.keys(out);
  check('total key count includes extras', keys.length === 5);
  check(
    'captured order first',
    keys[0] === 'model' && keys[1] === 'messages' && keys[2] === 'system',
  );
  check(
    'extras preserved in caller insertion order',
    keys[3] === 'future_field_a' && keys[4] === 'future_field_b',
  );
  check('no duplicates', new Set(keys).size === keys.length);
}

// ======================================================================
//  Missing-from-caller names in captured order are skipped
// ======================================================================
header('orderBodyForOutbound — absent keys are skipped, not emitted as undefined');
{
  const b = { model: 'claude-opus-4-5', messages: [] };
  const order = ['model', 'messages', 'tools', 'thinking'];

  const out = orderBodyForOutbound(b, order);
  const keys = Object.keys(out);
  check('only present keys emitted', keys.length === 2);
  check('absent "tools" is not set to undefined', !('tools' in out));
  check('absent "thinking" is not set to undefined', !('thinking' in out));
  // Guard against the "hasOwnProperty trap" where a captured name collides
  // with an inherited property on the body record.
  check(
    'JSON.stringify does not invent missing keys',
    !JSON.stringify(out).includes('tools') && !JSON.stringify(out).includes('thinking'),
  );
}

// ======================================================================
//  Duplicate names in captured order — first wins, rest skipped
// ======================================================================
header('orderBodyForOutbound — duplicate captured names are deduped');
{
  const b = { model: 'claude-opus-4-5', messages: [] };
  const order = ['model', 'messages', 'model'];

  const out = orderBodyForOutbound(b, order);
  const keys = Object.keys(out);
  check('dedup: length=2 even with duplicate in order', keys.length === 2);
  check('first occurrence wins (position 0)', keys[0] === 'model');
  check('no second "model" anywhere', keys.filter((k) => k === 'model').length === 1);
}

// ======================================================================
//  Empty caller record
// ======================================================================
header('orderBodyForOutbound — empty caller record with captured order');
{
  const out = orderBodyForOutbound({}, ['model', 'messages']);
  check(
    'nothing to emit → empty record (not undefined, not the input)',
    typeof out === 'object' && !Array.isArray(out) && Object.keys(out).length === 0,
  );
}

// ======================================================================
//  Falsy field values are preserved (0, false, null, '')
// ======================================================================
header('orderBodyForOutbound — falsy values are emitted, not stripped');
{
  // max_tokens=0 or stream=false are legal wire values. A naive
  // `if (body[name])` check would drop them — the implementation uses
  // hasOwnProperty so falsy values must pass through.
  const b = { model: '', messages: [], max_tokens: 0, stream: false };
  const order = ['model', 'messages', 'max_tokens', 'stream'];

  const out = orderBodyForOutbound(b, order);
  check('empty string preserved', out.model === '');
  check('zero preserved', out.max_tokens === 0);
  check('false preserved', out.stream === false);
  check('all four keys present', Object.keys(out).length === 4);
}

// ======================================================================
//  Idempotence — reorder(reorder(x)) === shape of reorder(x)
// ======================================================================
header('orderBodyForOutbound — idempotent over the same captured order');
{
  const b = {
    stream: true,
    model: 'claude-opus-4-5',
    messages: [],
    system: [],
  };
  const order = ['model', 'messages', 'system', 'stream'];

  const once = orderBodyForOutbound(b, order);
  const twice = orderBodyForOutbound(once, order);
  check(
    'second pass produces the same key sequence',
    JSON.stringify(Object.keys(once)) === JSON.stringify(Object.keys(twice)),
  );
  check(
    'second pass produces byte-identical JSON',
    JSON.stringify(once) === JSON.stringify(twice),
  );
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);
