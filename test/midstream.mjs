// Unit tests for src/midstream.ts — mid-stream continuation (v6.1).
//
// Pure pieces, no sockets: the SSE frame splitter, the client-stream state
// the guard tracks, the seam (anchor + trim + the paragraph-break rule), the
// resume body, and the splicer that turns a resume stream into frames that
// continue the client's message. The end-to-end wiring (a real startProxy
// whose upstream dies, resumed through the loopback) is in
// test/midstream-continuation-wiring.mjs.

import {
  SseFrameSplitter, parseFrame, formatFrame, ClientStreamState,
  anchorOf, findAnchor, tailOverlap, fixSeam, insideCodeFence,
  buildResumeBody, resumeNotice, Splicer, MidstreamGuard, loopbackBaseFor, ANCHOR_CHARS,
} from '../dist/midstream.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : ''}`); fail++; }
};
const header = (l) => console.log(`\n=== ${l} ===`);

const ev = (type, obj) => formatFrame(type, { type, ...obj });
const anthropicPrefix = (text, model = 'claude-opus-5') => [
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
  ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
  ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
  ev('content_block_stop', { index: 0 }),
  ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
  ...(text.match(/.{1,7}/gs) ?? []).map((t) => ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: t } })),
];

// A strict replay of the Anthropic SSE grammar, the checks an SDK MessageStream enforces.
function assemble(frames) {
  const errors = [];
  let started = false, stopped = false, delta = false;
  const blocks = [];
  for (const raw of frames) {
    const f = parseFrame(raw);
    if (f.comment) continue;
    const d = f.data;
    if (!d) { errors.push(`non-json frame ${raw.slice(0, 40)}`); continue; }
    if (stopped) errors.push(`${d.type} after message_stop`);
    switch (d.type) {
      case 'ping': break;
      case 'message_start': if (started) errors.push('second message_start'); started = true; break;
      case 'content_block_start':
        if (d.index !== blocks.length) errors.push(`block index ${d.index}, expected ${blocks.length}`);
        blocks[d.index] = { type: d.content_block.type, open: true, text: '' }; break;
      case 'content_block_delta': {
        const b = blocks[d.index];
        if (!b) { errors.push(`delta for unknown block ${d.index}`); break; }
        if (!b.open) errors.push(`delta for closed block ${d.index}`);
        if (b.type === 'text' && d.delta.type !== 'text_delta') errors.push(`bad delta ${d.delta.type} on text`);
        if (d.delta.type === 'text_delta') b.text += d.delta.text;
        break;
      }
      case 'content_block_stop': {
        const b = blocks[d.index];
        if (!b) errors.push(`stop for unknown block ${d.index}`);
        else if (!b.open) errors.push(`double stop ${d.index}`);
        else b.open = false;
        break;
      }
      case 'message_delta': if (blocks.some((b) => b.open)) errors.push('message_delta with open block'); delta = true; break;
      case 'message_stop': if (!delta) errors.push('message_stop without message_delta'); stopped = true; break;
      case 'error': errors.push('error event'); break;
      default: errors.push(`unknown ${d.type}`);
    }
  }
  if (!started) errors.push('no message_start');
  if (!stopped) errors.push('no message_stop');
  return { ok: errors.length === 0, errors, text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''), blocks };
}

// ---------------------------------------------------------------------------
header('SseFrameSplitter — frames survive arbitrary chunking, bytes untouched');
{
  const src = 'event: a\ndata: {"type":"a","n":1}\n\n: comment\n\nevent: b\ndata: {"type":"b"}\n\n';
  const sp = new SseFrameSplitter();
  const enc = new TextEncoder().encode(src);
  const frames = [];
  for (let i = 0; i < enc.length; i += 5) frames.push(...sp.feed(enc.subarray(i, i + 5)));
  check('three frames', frames.length === 3, frames.length);
  check('raw concatenation is byte-identical', frames.map((f) => f.raw).join('') === src);
  check('comment frame flagged', frames[1].comment === true && frames[1].data === null);
  check('event + data parsed', frames[0].event === 'a' && frames[0].data.n === 1);
  check('nothing left buffered', sp.flush() === '');
  const sp2 = new SseFrameSplitter();
  check('partial frame held back', sp2.feed('event: x\ndata: {"type":"x"}\n').length === 0 && sp2.flush() === 'event: x\ndata: {"type":"x"}\n');
  const multi = 'data: {"type":"a"}\ndata: {"type":"b"}\n\n';
  check('utf-8 split across chunks decodes', (() => {
    const s = new SseFrameSplitter(); const bytes = new TextEncoder().encode('data: {"type":"t","s":"héllo"}\n\n');
    const out = [...s.feed(bytes.subarray(0, 21)), ...s.feed(bytes.subarray(21))];
    return out.length === 1 && out[0].data.s === 'héllo';
  })());
  check('OpenAI [DONE] sentinel keeps dataText', parseFrame('data: [DONE]\n\n').dataText === '[DONE]' && parseFrame('data: [DONE]\n\n').data === null);
  void multi;
}

// ---------------------------------------------------------------------------
header('ClientStreamState — what the client has seen');
{
  const st = new ClientStreamState('anthropic');
  for (const raw of anthropicPrefix('Hello wor')) st.observe(parseFrame(raw));
  check('started, not finished', st.started && !st.finished);
  check('text block 1 open with the text', st.openIdx === 1 && st.openType === 'text' && st.textSoFar === 'Hello wor');
  check('continuable', st.continuable === true);
  check('model remembered', st.model === 'claude-opus-5');
  const err = parseFrame(ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }));
  check('in-band error after content is withheld', st.observe(err) === false && st.withheld[0] === err);
  check('still continuable after a withheld error', st.continuable === true);
  st.observe(parseFrame(ev('content_block_stop', { index: 1 })));
  check('cut between blocks is continuable (nothing open)', st.openIdx === -1 && st.continuable === true);
  st.observe(parseFrame(ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })));
  st.observe(parseFrame(ev('message_stop', {})));
  check('finished after message_stop → not continuable', st.finished && st.continuable === false);

  const tool = new ClientStreamState('anthropic');
  for (const raw of anthropicPrefix('x')) tool.observe(parseFrame(raw));
  tool.observe(parseFrame(ev('content_block_stop', { index: 1 })));
  tool.observe(parseFrame(ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 't1', name: 'bash', input: {} } })));
  check('open tool_use → not continuable', tool.continuable === false);

  const pre = new ClientStreamState('anthropic');
  check('error before any byte is NOT withheld (pre-byte failover owns it)', pre.observe(err) === true && pre.withheld.length === 0);

  const thinking = new ClientStreamState('anthropic');
  for (const raw of anthropicPrefix('').slice(0, 2)) thinking.observe(parseFrame(raw));
  check('cut inside thinking: continuable with empty partial', thinking.continuable && thinking.openType === 'thinking' && thinking.textSoFar === '');

  const oa = new ClientStreamState('openai');
  const chunk = (delta, finish = null) => parseFrame(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'claude', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  oa.observe(chunk({ role: 'assistant', content: '' }));
  oa.observe(chunk({ content: 'Hel' })); oa.observe(chunk({ content: 'lo' }));
  check('openai: text tracked as block 0', oa.started && oa.textSoFar === 'Hello' && oa.openIdx === 0 && oa.continuable);
  check('openai: error chunk withheld', oa.observe(parseFrame('data: {"error":{"message":"boom"}}\n\n')) === false && oa.withheld.length === 1);
  oa.observe(chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '' } }] }));
  check('openai: tool_calls → not continuable', oa.continuable === false);
  const oa2 = new ClientStreamState('openai');
  oa2.observe(chunk({ content: 'a' })); oa2.observe(parseFrame('data: [DONE]\n\n'));
  check('openai: [DONE] finishes', oa2.finished === true);
}

// ---------------------------------------------------------------------------
header('The seam — anchor, trim, paragraph-break rule');
{
  const partial = 'Every byte that follows is numbered relative to it, and that num';
  const a = anchorOf(partial);
  check(`anchor is the last ≤${ANCHOR_CHARS} chars starting at a non-space`, a.length <= ANCHOR_CHARS && a === partial.slice(-a.length) && !/^\s/.test(a));
  check('exact repeat found, cut after it', (() => { const r = findAnchor(partial, a + 'ber, server replies'); return r && r.exact && (a + 'ber, server replies').slice(r.cut) === 'ber, server replies'; })());
  check('whitespace-normalized repeat found (fuzzy)', (() => { const r = findAnchor(partial, a.replace(/ /g, '  ') + 'ber'); return r && !r.exact && (a.replace(/ /g, '  ') + 'ber').slice(r.cut) === 'ber'; })());
  check('curly quotes fold', (() => { const p = 'He said "the num'; const h = 'He said “the num' + 'ber'; const r = findAnchor(p, h); return r && h.slice(r.cut) === 'ber'; })());
  check('shorter tail repeat (last 16) still found', (() => { const h = partial.slice(-16) + 'ber'; const r = findAnchor(partial, h); return r && h.slice(r.cut) === 'ber'; })());
  check('no repeat → null', findAnchor(partial, 'ber, server replies with a SYN-ACK') === null);
  check('a later recurrence is not mistaken for the anchor', findAnchor(partial, 'Then ' + 'x'.repeat(40) + a) === null);
  check('short partial (<8 chars) → null', findAnchor('num', 'numb') === null);
  check('tailOverlap exact bytes, ignores overlaps under 6 chars ("the"+"there")', tailOverlap('abc def ghi jkl', 'ghi jkl mno') === 7 && tailOverlap('abc', 'xyz') === 0 && tailOverlap('see the', 'there') === 0);
  check('insideCodeFence counts fences', insideCodeFence('a ```py\nx') === true && insideCodeFence('a ```py\nx``` b') === false);
  check('fixSeam: mid-sentence + paragraph break → one space', fixSeam('open a connection, and', '\n\nhere is where') === ' here is where');
  check('fixSeam: leaves a break after a finished sentence', fixSeam('It works.', '\n\nNext paragraph') === '\n\nNext paragraph');
  check('fixSeam: leaves newlines inside a code fence', fixSeam('```py\nx = 1', '\n    y = 2') === '\n    y = 2');
  check('fixSeam: leaves a continuation that does not start with a newline', fixSeam('and', ' here') === ' here');
  check('fixSeam: partial already ends in whitespace → untouched', fixSeam('and ', '\nhere') === '\nhere');
  check('notice names the anchor and forbids preamble', (() => { const n = resumeNotice('tail text'); return n.includes('<resume-anchor>tail text</resume-anchor>') && /no preamble/.test(n); })());
  check('notice without an anchor asks to continue', resumeNotice('').includes('Continue exactly'));
}

// ---------------------------------------------------------------------------
header('buildResumeBody — the client request, re-pointed, with the partial appended');
{
  const client = { model: 'claude-opus-5', max_tokens: 50, stream: false, tool_choice: { type: 'any' }, system: 'S', messages: [{ role: 'user', content: 'hi' }] };
  const b = buildResumeBody('anthropic', client, 'codex:gpt-5.6-terra:high', 'partial text here');
  check('model replaced, stream forced, tool_choice dropped, system kept', b.model === 'codex:gpt-5.6-terra:high' && b.stream === true && !('tool_choice' in b) && b.system === 'S');
  check('assistant(partial) + user(notice) appended in Anthropic shape', b.messages.length === 3 && b.messages[1].role === 'assistant' && b.messages[1].content[0].text === 'partial text here' && b.messages[2].role === 'user' && b.messages[2].content[0].text.includes('<resume-anchor>'));
  check('client body not mutated', client.messages.length === 1 && client.stream === false);
  const o = buildResumeBody('openai', { model: 'x', messages: [{ role: 'user', content: 'hi' }] }, 'codex:gpt-5.6-sol', 'p');
  check('OpenAI shape uses string content', o.messages[1].content === 'p' && typeof o.messages[2].content === 'string');
  const empty = buildResumeBody('anthropic', client, 'codex:gpt-5.6-sol', '');
  check('empty partial → plain re-issue, no turns appended', empty.messages.length === 1);
}

// ---------------------------------------------------------------------------
header('Splicer — the resume stream continues the client\'s open text block');
{
  const partial = 'The three-way handshake exists because both sides must prove they can send and receive before either trusts a byte. Client sends SYN with its sequence num';
  const st = new ClientStreamState('anthropic');
  const clientFrames = anthropicPrefix(partial);
  for (const raw of clientFrames) st.observe(parseFrame(raw));
  const sp = new Splicer('anthropic', st, partial);
  // The resume: a thinking block (dropped), then text that repeats the anchor, then a second text block.
  const cont = 'ber, server replies SYN-ACK.';
  const resume = [
    ev('message_start', { message: { id: 'msg_2', model: 'gpt-5.6-sol', role: 'assistant', content: [], usage: { input_tokens: 5, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
    ev('content_block_stop', { index: 0 }),
    ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
    ...(anchorOf(partial) + cont).match(/.{1,9}/gs).map((t) => ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: t } })),
    ev('content_block_stop', { index: 1 }),
    ev('content_block_start', { index: 2, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'Second block.' } }),
    ev('content_block_stop', { index: 2 }),
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 42 } }),
    ev('message_stop', {}),
  ];
  const out = [...clientFrames];
  for (const raw of resume) out.push(...sp.feed(parseFrame(raw)));
  out.push(...sp.end());
  const a = assemble(out);
  check('composed stream is grammatically valid', a.ok, a.errors.join('; '));
  check('one message_start (the client\'s), model unchanged', out.filter((r) => r.includes('message_start')).length === 1 && out[0].includes('claude-opus-5'));
  check('anchor trimmed exactly; text reads as one', a.text === partial + cont + 'Second block.', a.text.slice(partial.length - 10, partial.length + 40));
  check('resume thinking block dropped', !out.some((r) => r.includes('thinking_delta')));
  check('second text block renumbered after the client\'s blocks', a.blocks.length === 3 && a.blocks[2].type === 'text' && a.blocks[2].text === 'Second block.');
  check('stats: exact anchor', sp.stats.anchor === 'exact' && sp.stats.dropped === anchorOf(partial).length);
  check('client block 1 closed exactly once', out.filter((r) => r.includes('content_block_stop') && r.includes('"index":1')).length === 1);
}

header('Splicer — no anchor repeat → overlap fallback, and none at all');
{
  const partial = 'abc def ghi jkl mno';
  const st = new ClientStreamState('anthropic');
  const frames = anthropicPrefix(partial);
  for (const raw of frames) st.observe(parseFrame(raw));
  const sp = new Splicer('anthropic', st, partial);
  const out = [...frames];
  const resume = [
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'jkl mno pqr stu' } }),   // repeats only the last two words
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
    ev('message_stop', {}),
  ];
  for (const raw of resume) out.push(...sp.feed(parseFrame(raw)));
  out.push(...sp.end());
  const a = assemble(out);
  check('valid', a.ok, a.errors.join('; '));
  check('overlap fallback trimmed the repeated word', a.text === 'abc def ghi jkl mno pqr stu' && sp.stats.anchor === 'overlap', a.text);
}

header('Splicer — resume ends without message_delta/stop → synthesized close');
{
  const partial = 'Some text that was cut mid-way through the sentence here';
  const st = new ClientStreamState('anthropic');
  const frames = anthropicPrefix(partial);
  for (const raw of frames) st.observe(parseFrame(raw));
  const sp = new Splicer('anthropic', st, partial);
  const out = [...frames];
  for (const raw of [
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: anchorOf(partial) + ' and then it ends' } }),
  ]) out.push(...sp.feed(parseFrame(raw)));
  out.push(...sp.end());
  const a = assemble(out);
  check('valid with synthesized end', a.ok && a.text === partial + ' and then it ends', a.errors.join('; ') || a.text);
}

header('Splicer — cut inside thinking: close it, start a fresh text block');
{
  const st = new ClientStreamState('anthropic');
  const frames = anthropicPrefix('').slice(0, 2);   // message_start + thinking open
  for (const raw of frames) st.observe(parseFrame(raw));
  const sp = new Splicer('anthropic', st, '');
  const out = [...frames];
  for (const raw of [
    ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ev('content_block_stop', { index: 0 }),
    ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Fresh answer.' } }),
    ev('content_block_stop', { index: 1 }),
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
    ev('message_stop', {}),
  ]) out.push(...sp.feed(parseFrame(raw)));
  out.push(...sp.end());
  const a = assemble(out);
  check('valid', a.ok, a.errors.join('; '));
  check('thinking block 0 closed, text is block 1', a.blocks.length === 2 && a.blocks[0].type === 'thinking' && !a.blocks[0].open && a.blocks[1].text === 'Fresh answer.');
}

header('Splicer — resume brings a tool_use after its text');
{
  const partial = 'Let me check that file for you right now, hold on';
  const st = new ClientStreamState('anthropic');
  const frames = anthropicPrefix(partial);
  for (const raw of frames) st.observe(parseFrame(raw));
  const sp = new Splicer('anthropic', st, partial);
  const out = [...frames];
  for (const raw of [
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: anchorOf(partial) + '.' } }),
    ev('content_block_stop', { index: 0 }),
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } }),
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } }),
    ev('content_block_stop', { index: 1 }),
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
    ev('message_stop', {}),
  ]) out.push(...sp.feed(parseFrame(raw)));
  out.push(...sp.end());
  const a = assemble(out);
  check('valid', a.ok, a.errors.join('; '));
  check('tool_use renumbered to index 2 with its input', a.blocks.length === 3 && a.blocks[2].type === 'tool_use' && out.some((r) => r.includes('"index":2') && r.includes('input_json_delta')));
  check('stop_reason tool_use passed through', out.some((r) => r.includes('"stop_reason":"tool_use"')));
}

header('Splicer — OpenAI shape');
{
  const partial = 'Hello there, this is the first half of the answ';
  const st = new ClientStreamState('openai');
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl-dario', object: 'chat.completion.chunk', created: 1, model: 'claude', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const frames = [chunk({ role: 'assistant', content: '' }), ...partial.match(/.{1,6}/gs).map((t) => chunk({ content: t }))];
  for (const raw of frames) st.observe(parseFrame(raw));
  const sp = new Splicer('openai', st, partial);
  const out = [...frames];
  for (const raw of [chunk({ role: 'assistant', content: '' }), chunk({ content: anchorOf(partial) + 'er, and the second.' }), chunk({}, 'stop'), 'data: [DONE]\n\n']) out.push(...sp.feed(parseFrame(raw)));
  out.push(...sp.end());
  const text = out.map((r) => parseFrame(r)).filter((f) => f.data).map((f) => f.data.choices?.[0]?.delta?.content ?? '').join('');
  check('text reads as one', text === partial + 'er, and the second.', text);
  check('exactly one finish chunk and one [DONE], [DONE] last', out.filter((r) => r.includes('"finish_reason":"stop"')).length === 1 && out.filter((r) => r.includes('[DONE]')).length === 1 && out[out.length - 1].includes('[DONE]'));
}

// ---------------------------------------------------------------------------
header('MidstreamGuard — end to end against a fake loopback');
{
  const partial = 'The quick brown fox jumps over the lazy dog and keeps runn';
  const written = [];
  let ended = 0;
  const loopbackCalls = [];
  const fakeFetch = async (url, init) => {
    loopbackCalls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    const stream = new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const raw of [
          ev('message_start', { message: { id: 'm2', model: 'gpt-5.6-sol', role: 'assistant', content: [], usage: {} } }),
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: anchorOf(partial) + 'ing until dusk.' } }),
          ev('content_block_stop', { index: 0 }),
          ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
          ev('message_stop', {}),
        ]) c.enqueue(enc.encode(raw));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  let released = 0;
  const g = new MidstreamGuard({
    shape: 'anthropic',
    write: (c) => written.push(c),
    end: () => { ended++; },
    isClientGone: () => false,
    requestNo: 7,
    verbose: false,
    log: () => {},
    resume: {
      clientBody: () => ({ model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'Tell me' }] }),
      loopbackBase: 'http://127.0.0.1:1',
      loopbackHeaders: { 'x-api-key': 'k', 'x-dario-consumer': 'tests' },
      resolveTarget: async () => ({ model: 'codex:gpt-5.6-sol', label: 'gpt-5.6-sol (codex live)' }),
      onBeforeResume: () => { released++; },
      timeoutMs: 5000,
      fetchImpl: fakeFetch,
    },
  });
  // Primary bytes arrive in odd chunks; then the upstream dies (no more frames) and the site calls finish().
  const primary = anthropicPrefix(partial).join('');
  for (let i = 0; i < primary.length; i += 13) g.write(primary.slice(i, i + 13));
  g.write(ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }));
  check('error frame withheld from the client', !written.join('').includes('overloaded_error'));
  const outcome = await g.finish();
  check('outcome continued', outcome === 'continued', outcome);
  check('client response ended exactly once', ended === 1);
  check('queue slot released before the loopback', released === 1);
  check('loopback hit /v1/messages with the continuation header + auth + consumer', loopbackCalls.length === 1 && loopbackCalls[0].url.endsWith('/v1/messages') && loopbackCalls[0].headers['x-dario-continuation'] === '7' && loopbackCalls[0].headers['x-api-key'] === 'k' && loopbackCalls[0].headers['x-dario-consumer'] === 'tests');
  check('loopback body = client body + assistant(partial) + notice, at the target model', (() => { const b = loopbackCalls[0].body; return b.model === 'codex:gpt-5.6-sol' && b.messages.length === 3 && b.messages[1].content[0].text === partial && b.messages[2].content[0].text.includes(anchorOf(partial)); })());
  const frames = written.join('').split(/(?<=\n\n)/).filter(Boolean);
  const a = assemble(frames);
  check('client stream is one valid message', a.ok, a.errors.join('; '));
  check('text is partial + continuation, seam invisible', a.text === partial + 'ing until dusk.', a.text);
  check('an SSE comment marks the takeover', written.join('').includes(': dario continuation gpt-5.6-sol (codex live) after '));
  check('the withheld error never reached the client', !written.join('').includes('overloaded_error'));
}

header('MidstreamGuard — no target → stream ends as before (error forwarded)');
{
  const written = []; let ended = 0;
  const g = new MidstreamGuard({
    shape: 'anthropic', write: (c) => written.push(c), end: () => { ended++; }, isClientGone: () => false, requestNo: 1, verbose: false, log: () => {},
    resume: { clientBody: () => ({ messages: [] }), loopbackBase: 'http://127.0.0.1:1', loopbackHeaders: {}, resolveTarget: async () => null, timeoutMs: 100 },
  });
  g.write(anthropicPrefix('abc').join(''));
  g.write(ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }));
  const outcome = await g.finish();
  check('outcome no-target, ended once, withheld error released to the client', outcome === 'no-target' && ended === 1 && written.join('').includes('overloaded_error'));
}

header('MidstreamGuard — clean stream is untouched');
{
  const written = []; let ended = 0; let resolved = 0;
  const g = new MidstreamGuard({
    shape: 'anthropic', write: (c) => written.push(c), end: () => { ended++; }, isClientGone: () => false, requestNo: 1, verbose: false, log: () => {},
    resume: { clientBody: () => ({ messages: [] }), loopbackBase: 'http://127.0.0.1:1', loopbackHeaders: {}, resolveTarget: async () => { resolved++; return null; }, timeoutMs: 100 },
  });
  const all = [...anthropicPrefix('done'), ev('content_block_stop', { index: 1 }), ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }), ev('message_stop', {})].join('');
  g.write(all);
  const outcome = await g.finish();
  check('clean: forwarded byte-for-byte, no resolve, ended once', outcome === 'clean' && written.join('') === all && resolved === 0 && ended === 1);
}

header('MidstreamGuard — resume refused (HTTP 4xx) → stream ends as before');
{
  const written = []; let ended = 0;
  const g = new MidstreamGuard({
    shape: 'anthropic', write: (c) => written.push(c), end: () => { ended++; }, isClientGone: () => false, requestNo: 1, verbose: false, log: () => {},
    resume: { clientBody: () => ({ messages: [] }), loopbackBase: 'http://127.0.0.1:1', loopbackHeaders: {}, resolveTarget: async () => ({ model: 'x', label: 'x' }), timeoutMs: 100,
      fetchImpl: async () => new Response('{"type":"error"}', { status: 400 }) },
  });
  g.write(anthropicPrefix('abc def ghi jkl').join(''));
  const outcome = await g.finish();
  const a = assemble(written.join('').split(/(?<=\n\n)/).filter(Boolean));
  check('resume-failed, ended once, client sees the truncated stream (no message_stop)', outcome === 'resume-failed' && ended === 1 && !a.ok && a.errors.includes('no message_stop'));
}

header('MidstreamGuard — client gone → no resume');
{
  let ended = 0; let fetched = 0;
  const g = new MidstreamGuard({
    shape: 'anthropic', write: () => {}, end: () => { ended++; }, isClientGone: () => true, requestNo: 1, verbose: false, log: () => {},
    resume: { clientBody: () => ({ messages: [] }), loopbackBase: 'http://127.0.0.1:1', loopbackHeaders: {}, resolveTarget: async () => ({ model: 'x', label: 'x' }), timeoutMs: 100, fetchImpl: async () => { fetched++; return new Response(''); } },
  });
  g.write(anthropicPrefix('abc def ghi jkl').join(''));
  const outcome = await g.finish();
  check('ended, no loopback', outcome === 'ended' && ended === 1 && fetched === 0);
}

header('loopbackBaseFor');
{
  check('wildcard → 127.0.0.1', loopbackBaseFor('0.0.0.0', 3456) === 'http://127.0.0.1:3456');
  check('localhost → 127.0.0.1', loopbackBaseFor('localhost', 1) === 'http://127.0.0.1:1');
  check(':: → [::1]', loopbackBaseFor('::', 2) === 'http://[::1]:2');
  check('specific v4 kept', loopbackBaseFor('10.0.0.5', 3) === 'http://10.0.0.5:3');
  check('specific v6 bracketed', loopbackBaseFor('fe80::1', 4) === 'http://[fe80::1]:4');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
