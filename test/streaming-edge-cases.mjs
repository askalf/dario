// Streaming robustness audit (v3.17). The existing issue-29 and hybrid-tools
// suites cover the happy path and a single mid-line split. This file goes
// after the long-tail cases where SSE reassembly has historically had
// subtle bugs:
//
//   1. Byte-by-byte shredding — stream-through-shredder must === stream-
//      through-whole for any input (event framing, tool translation).
//   2. Multiple concurrent tool_use blocks at different indices.
//   3. Empty tool input (content_block_start → content_block_stop with
//      zero deltas in between).
//   4. Multi-byte UTF-8 chars split across chunk boundaries.
//   5. SSE comment lines (`:keep-alive`) and the `[DONE]` sentinel
//      pass through untouched.
//   6. end() corner cases: empty buffer, trailing partial, mid-tool.

import {
  createStreamingReverseMapper,
} from '../dist/cc-template.js';

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

const enc = new TextEncoder();
const dec = new TextDecoder();

// Tool map where Bash needs translateBack (client calls it `exec` with
// field `command`; CC expects `Bash` with field `command`). We invent a
// shape that forces translateBack to actually transform so we can catch
// wire-shape errors.
function makeToolMap() {
  const map = new Map();
  map.set('exec', {
    ccTool: 'Bash',
    // translateBack runs on CC's tool_use input and produces the client-
    // facing input. Here: rename `command` → `cmd`.
    translateBack: (ccInput) => {
      const out = { ...ccInput };
      if ('command' in out) {
        out.cmd = out.command;
        delete out.command;
      }
      return out;
    },
  });
  return map;
}

/**
 * Feed a full SSE string through the mapper, one chunk at a time by
 * the given chunk size (in bytes). Returns the concatenated output.
 */
function streamInChunks(mapper, sseText, chunkSize) {
  const bytes = enc.encode(sseText);
  let out = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    out += dec.decode(mapper.feed(slice), { stream: true });
  }
  out += dec.decode(mapper.end());
  return out;
}

// ======================================================================
//  1. Byte-by-byte shredding yields the same output as whole-input
// ======================================================================
header('1. byte-by-byte chunking produces identical output to whole-input');
{
  const sse = [
    `event: message_start`,
    `data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}`,
    ``,
    `event: content_block_start`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"ls -la\\""}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"}"}}`,
    ``,
    `event: content_block_stop`,
    `data: {"type":"content_block_stop","index":0}`,
    ``,
    `event: message_stop`,
    `data: {"type":"message_stop"}`,
    ``,
  ].join('\n');

  const whole = streamInChunks(createStreamingReverseMapper(makeToolMap()), sse, sse.length);
  const shredded = streamInChunks(createStreamingReverseMapper(makeToolMap()), sse, 1);
  check('whole and shredded outputs match byte-for-byte', whole === shredded);
  check('output contains translated tool name `exec`', whole.includes('"name":"exec"'));
  check('output contains translated field `cmd`', whole.includes('\\"cmd\\"'));
  check('output no longer contains untranslated `command` field', !whole.includes('\\"command\\"'));
  check('every emitted event is valid JSON', everyDataLineParses(whole));
}

// ======================================================================
//  2. Multiple concurrent tool_use blocks at different indices
// ======================================================================
header('2. two tool_use blocks at indices 0 and 1 each translate independently');
{
  const sse = [
    `event: content_block_start`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_a","name":"Bash","input":{}}}`,
    ``,
    `event: content_block_start`,
    `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_b","name":"Bash","input":{}}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"pwd\\"}"}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"whoami\\"}"}}`,
    ``,
    `event: content_block_stop`,
    `data: {"type":"content_block_stop","index":0}`,
    ``,
    `event: content_block_stop`,
    `data: {"type":"content_block_stop","index":1}`,
    ``,
  ].join('\n');

  const out = streamInChunks(createStreamingReverseMapper(makeToolMap()), sse, 4);
  check('index 0 translation present (pwd with cmd key)', out.includes('"partial_json":"{\\"cmd\\":\\"pwd\\"}"'));
  check('index 1 translation present (whoami with cmd key)', out.includes('"partial_json":"{\\"cmd\\":\\"whoami\\"}"'));
  check('both content_block_stop events present', (out.match(/"type":"content_block_stop"/g) || []).length === 2);
  check('no leftover `command` keys anywhere', !out.includes('\\"command\\"'));
}

// ======================================================================
//  3. Empty tool input (no deltas at all between start and stop)
// ======================================================================
header('3. tool_use with zero deltas: start→stop, translateBack gets {}');
{
  const sse = [
    `event: content_block_start`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_empty","name":"Bash","input":{}}}`,
    ``,
    `event: content_block_stop`,
    `data: {"type":"content_block_stop","index":0}`,
    ``,
  ].join('\n');

  const out = streamInChunks(createStreamingReverseMapper(makeToolMap()), sse, 256);
  check('start emitted with translated name', out.includes('"name":"exec"'));
  check('synthetic delta emitted with empty {} input', out.includes('"partial_json":"{}"'));
  check('stop event present', out.includes('"type":"content_block_stop"'));
  check('everything parses as JSON', everyDataLineParses(out));
}

// ======================================================================
//  4. Multi-byte UTF-8 character split across chunk boundary
// ======================================================================
header('4. multi-byte UTF-8 (emoji in tool input) split across chunks');
{
  // 🦀 (U+1F980) is 4 bytes in UTF-8: f0 9f a6 80. If the decoder is
  // fed one byte at a time without streaming mode, it garbles.
  const sse = [
    `event: content_block_start`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"Bash","input":{}}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"echo 🦀\\"}"}}`,
    ``,
    `event: content_block_stop`,
    `data: {"type":"content_block_stop","index":0}`,
    ``,
  ].join('\n');

  const shredded = streamInChunks(createStreamingReverseMapper(makeToolMap()), sse, 1);
  check('emoji survives byte-by-byte streaming', shredded.includes('🦀'));
  check('translated field `cmd` contains the emoji', /"partial_json":"\{\\"cmd\\":\\"echo 🦀\\"\}"/.test(shredded));
  check('all events parse', everyDataLineParses(shredded));
}

// ======================================================================
//  5. SSE comment line and [DONE] sentinel pass through untouched
// ======================================================================
header('5. SSE comment (`:keep-alive`) and `[DONE]` sentinel pass through');
{
  const sse = [
    `: keep-alive`,
    ``,
    `event: content_block_start`,
    `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"Bash","input":{}}}`,
    ``,
    `event: content_block_delta`,
    `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"x\\"}"}}`,
    ``,
    `event: content_block_stop`,
    `data: {"type":"content_block_stop","index":0}`,
    ``,
    `data: [DONE]`,
    ``,
  ].join('\n');

  const out = streamInChunks(createStreamingReverseMapper(makeToolMap()), sse, 3);
  check('keep-alive comment preserved', out.includes(': keep-alive'));
  check('[DONE] sentinel preserved', out.includes('data: [DONE]'));
  check('translation still applied', out.includes('\\"cmd\\"'));
}

// ======================================================================
//  6. end() corner cases
// ======================================================================
header('6a. end() on empty stream returns empty output');
{
  const mapper = createStreamingReverseMapper(makeToolMap());
  const tail = mapper.end();
  check('empty end() returns zero-length Uint8Array', tail instanceof Uint8Array && tail.length === 0);
}

header('6b. end() flushes trailing partial event with no final blank line');
{
  // Last event is not followed by "\n\n". feed() must keep it buffered;
  // end() must flush it.
  const mapper = createStreamingReverseMapper(makeToolMap());
  const sseNoTrailingBlank =
    `event: message_stop\ndata: {"type":"message_stop"}`;
  // No tool_use involved → passthrough. But it must still be emitted.
  const feedOut = dec.decode(mapper.feed(enc.encode(sseNoTrailingBlank)), { stream: true });
  const endOut = dec.decode(mapper.end());
  const combined = feedOut + endOut;
  check('trailing partial event appears in combined output', combined.includes('"type":"message_stop"'));
}

header('6c. feed() on empty chunk is a no-op');
{
  const mapper = createStreamingReverseMapper(makeToolMap());
  const out = mapper.feed(new Uint8Array(0));
  check('empty feed returns empty output', out.length === 0);
}

// ======================================================================
//  7. Empty tool map → identity mapper (zero overhead fast path)
// ======================================================================
header('7. empty tool map returns a passthrough (noop) mapper');
{
  const mapper = createStreamingReverseMapper(new Map());
  const sse = `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  const encoded = enc.encode(sse);
  const out = dec.decode(mapper.feed(encoded), { stream: true }) + dec.decode(mapper.end());
  check('empty toolMap passthrough: input === output', out === sse);
}

// ----------------------------------------------------------------------
// Helper: parse every data: line in an SSE string and verify it's
// either [DONE] or valid JSON. Skips comment lines.
// ----------------------------------------------------------------------
function everyDataLineParses(sseText) {
  const lines = sseText.split('\n');
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try { JSON.parse(payload); }
    catch { return false; }
  }
  return true;
}

// ======================================================================
//  Summary
// ======================================================================
console.log(`\n======================================================================`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`======================================================================\n`);
if (fail > 0) process.exit(1);
