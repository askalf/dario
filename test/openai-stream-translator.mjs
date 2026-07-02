// createOpenAIStreamTranslator — per-request tool-call state isolation (#642-audit).
//
// The translator used to keep tool-call index/id in module globals, so two
// concurrent /v1/chat/completions streams with tool_use blocks cross-
// contaminated each other's counters and emitted malformed OpenAI tool_calls
// deltas. These tests interleave two independent translators and assert their
// state never bleeds.

import { createOpenAIStreamTranslator } from '../dist/proxy.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const D = (obj) => `data: ${JSON.stringify(obj)}`;
const start = (id, name) => D({ type: 'content_block_start', content_block: { type: 'tool_use', id, name } });
const stop = () => D({ type: 'content_block_stop' });
// pull the emitted tool_calls[0].index out of a translated OpenAI SSE frame
function toolIndex(frame) {
  const m = frame && frame.match(/"index":(\d+),"id"/);
  return m ? Number(m[1]) : (frame && frame.match(/"tool_calls":\[\{"index":(\d+)/) ? Number(RegExp.$1) : null);
}

header('single translator advances tool index across blocks');
{
  const t = createOpenAIStreamTranslator();
  const f0 = t(start('call_a', 'foo'));
  check('first tool_use -> index 0', toolIndex(f0) === 0);
  t(stop());
  const f1 = t(start('call_b', 'bar'));
  check('second tool_use -> index 1', toolIndex(f1) === 1);
}

header('two concurrent translators keep independent state (the #642 fix)');
{
  const a = createOpenAIStreamTranslator();
  const b = createOpenAIStreamTranslator();
  // Interleave: A starts a tool, B starts a tool, A closes + starts a 2nd,
  // B closes + starts a 2nd. If state were shared, indices would collide.
  const a0 = a(start('a0', 'toolA'));
  const b0 = b(start('b0', 'toolB'));
  check('A first tool -> index 0', toolIndex(a0) === 0);
  check('B first tool -> index 0 (NOT bumped by A)', toolIndex(b0) === 0);
  a(stop());
  const a1 = a(start('a1', 'toolA2'));
  check('A second tool -> index 1', toolIndex(a1) === 1);
  b(stop());
  const b1 = b(start('b1', 'toolB2'));
  check('B second tool -> index 1 (independent of A)', toolIndex(b1) === 1);
}

header('non-data lines and [DONE] handled');
{
  const t = createOpenAIStreamTranslator();
  check('non-data line -> null', t('event: ping') === null);
  check('[DONE] passthrough', t('data: [DONE]') === 'data: [DONE]\n\n');
  check('text_delta -> content frame', (t(D({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } })) || '').includes('"content":"hi"'));
}

console.log(`\nopenai-stream-translator: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
