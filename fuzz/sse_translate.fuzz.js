// Fuzz the Anthropic-SSE → OpenAI-SSE stream translator — the per-request
// closure that turns each upstream `data: {...}` line into an OpenAI
// chat.completion.chunk for /v1/chat/completions clients. The upstream stream
// is wire input dario does not control; the contract: NEVER throw on a hostile
// line (broken JSON, events whose content_block / delta fields are missing,
// primitives, or prototype-named junk), and every non-null return is a
// well-formed `data: <json>\n\n` frame (or the [DONE] sentinel). A throw here
// kills a client's live stream mid-response.
import { createOpenAIStreamTranslator } from '../dist/proxy.js';

function checkOutput(out) {
  if (out === null) return;
  if (typeof out !== 'string' || !out.startsWith('data: ')) {
    throw new Error(`translator returned a non-SSE frame: ${JSON.stringify(String(out).slice(0, 80))}`);
  }
  for (const frame of out.split('\n\n')) {
    if (frame === '' || frame === 'data: [DONE]') continue;
    JSON.parse(frame.slice(6)); // a non-JSON frame breaks the client's SSE parser
  }
}

export function fuzz(data) {
  const s = data.toString('utf8');
  const translate = createOpenAIStreamTranslator();

  // Raw fuzz input, as-is and forced through the `data: ` gate.
  checkOutput(translate(s));
  checkOutput(translate(`data: ${s}`));

  // Hostile-but-parseable events: real event types with fuzz-derived fields,
  // so the translator's property access runs on adversarial shapes.
  const types = ['content_block_start', 'content_block_delta', 'content_block_stop', 'message_stop', s.slice(0, 24)];
  const hostiles = [
    { type: types[data.length % types.length], content_block: { type: 'tool_use', name: s.slice(0, 16), id: s.slice(0, 8) } },
    { type: 'content_block_start', content_block: s },
    { type: 'content_block_start', content_block: { type: 'tool_use', name: s.slice(0, 16) } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: s } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: s } },
    { type: 'content_block_delta', delta: s.length },
    { type: 'message_stop', ['__proto__']: { polluted: true } },
  ];
  for (const e of hostiles) checkOutput(translate(`data: ${JSON.stringify(e)}`));

  // A multi-line stream split on newlines — the closure is stateful across
  // lines (tool-call index/id), so interleavings matter.
  const streamed = createOpenAIStreamTranslator();
  for (const line of s.split('\n')) checkOutput(streamed(line));
}
