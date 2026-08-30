// Unit tests for shadow compare (src/compare.ts, v6.0.0).
//
// The invariant under test is not "the comparison is accurate" — it is that a
// comparison CANNOT DEGRADE THE REQUEST IT OBSERVES. Every failure mode here
// (no account, unlistable model, unparseable body, unwritable log) has to end
// in a dropped comparison and an untouched response.
//
// runCompare() itself is deliberately not exercised: it reads real credentials
// and would make a network call on any machine that has a Codex account, which
// is not something a unit test should decide to do.

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readCompareTarget, withModel, teeResponse, writeCompareRecord,
  COMPARE_HEADER, COMPARE_RESULT_HEADER,
} from '../dist/compare.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n${'='.repeat(70)}\n  ${label}\n${'='.repeat(70)}`);
}

header('readCompareTarget — arming');
{
  check('reads the model from the header',
    readCompareTarget({ [COMPARE_HEADER]: 'gpt-5.6-sol' }) === 'gpt-5.6-sol');
  check('unarmed by default — no header means no comparison',
    readCompareTarget({}) === null);
  check('an empty value means OFF, not a model named ""',
    readCompareTarget({ [COMPARE_HEADER]: '' }) === null);
  check('whitespace is trimmed rather than sent as a slug',
    readCompareTarget({ [COMPARE_HEADER]: '  gpt-5.6-sol  ' }) === 'gpt-5.6-sol');
  check('a repeated header takes the first value',
    readCompareTarget({ [COMPARE_HEADER]: ['a', 'b'] }) === 'a');
  check('a non-string value is ignored rather than coerced',
    readCompareTarget({ [COMPARE_HEADER]: 42 }) === null);
  check('the response header is distinct from the request header',
    COMPARE_RESULT_HEADER !== COMPARE_HEADER);
}

header('withModel — building the comparison request');
{
  const body = Buffer.from(JSON.stringify({
    model: 'claude-opus-4-8', stream: true, messages: [{ role: 'user', content: 'hi' }],
  }));
  const out = JSON.parse(withModel(body, 'gpt-5.6-sol').toString());

  check('the model is swapped to the comparison target', out.model === 'gpt-5.6-sol');
  check('streaming is forced OFF — nobody is watching it arrive', out.stream === false);
  check('the prompt itself is carried across untouched',
    JSON.stringify(out.messages) === JSON.stringify([{ role: 'user', content: 'hi' }]));
  check('a non-JSON body yields null so the comparison is skipped, not guessed',
    withModel(Buffer.from('not json'), 'gpt-5.6-sol') === null);
  check('a JSON scalar is also refused (it is not a request)',
    withModel(Buffer.from('"just a string"'), 'gpt-5.6-sol') === null);
}

header('teeResponse — observing without interfering');
{
  const delivered = [];
  const res = {
    statusCode: 200,
    write(c) { delivered.push(['write', c]); return true; },
    end(c) { if (c !== undefined) delivered.push(['end', c]); return this; },
  };
  const tee = teeResponse(res);
  res.write('event: a\n');
  res.write(Buffer.from('event: b\n'));
  res.end('done');
  const got = tee.captured();

  check('every chunk still reaches the real response, in order',
    JSON.stringify(delivered.map((d) => d[0])) === JSON.stringify(['write', 'write', 'end']));
  check('the delivered payload is byte-identical to what was written',
    delivered[0][1] === 'event: a\n' && delivered[2][1] === 'done');
  check('the tee captures the whole body, Buffers decoded',
    got.body === 'event: a\nevent: b\ndone');
  check('and records the status actually sent', got.status === 200);
  check('and how long the response took', typeof got.ms === 'number' && got.ms >= 0);

  const res2 = { statusCode: 204, write() { return true; }, end() { return this; } };
  teeResponse(res2);
  res2.end();
  check('an empty response tees to an empty body rather than throwing',
    teeResponse(res2).captured().body === '');
}

header('writeCompareRecord — durability is best-effort, never fatal');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-compare-'));
  const record = {
    ts: '2026-08-30T04:00:00.000Z',
    path: '/v1/messages',
    shape: 'anthropic',
    streaming: true,
    primaryModel: 'claude-opus-4-8',
    comparedModel: 'gpt-5.6-sol',
    request: { messages: [{ role: 'user', content: 'hi' }] },
    primary: { status: 200, body: 'A', ms: 10 },
    compare: { status: 200, body: 'B', ms: 20 },
  };
  const written = writeCompareRecord(record, dir);
  check('a record is written and its path returned', typeof written === 'string');

  const parsed = JSON.parse(readFileSync(written, 'utf-8'));
  check('both sides survive the round trip',
    parsed.primary.body === 'A' && parsed.compare.body === 'B');
  check('the request is stored verbatim, so a record replays on its own',
    parsed.request.messages[0].content === 'hi');
  check('the filename carries the compared model, for grepping a directory',
    readdirSync(dir)[0].includes('gpt-5.6-sol'));
  check('colons are stripped from the timestamp (Windows rejects them in names)',
    !readdirSync(dir)[0].includes(':'));

  const slashy = writeCompareRecord({ ...record, comparedModel: 'evil/../../name' }, dir);
  check('a model name cannot escape the compare directory',
    typeof slashy === 'string' && slashy.startsWith(dir) && !slashy.includes('..')
    && slashy.slice(dir.length + 1).match(/[\\/]/) === null);

  check('an unwritable destination returns null instead of throwing',
    writeCompareRecord(record, '\0::invalid::') === null);
  check('a record with a skip reason and no compare side is still written',
    typeof writeCompareRecord({ ...record, compare: null, skipped: 'no Codex account configured' }, dir) === 'string');
}

header('writeCompareRecord — concurrent same-model records cannot clobber each other');
{
  // Timestamp and model are the only inputs to the old filename, and neither is
  // unique across simultaneous requests. Several compares against one target in
  // the same millisecond is the normal case under load — exactly the sample
  // worth keeping — so every one of them has to land as its own file.
  const dir = mkdtempSync(join(tmpdir(), 'dario-compare-race-'));
  const same = {
    ts: '2026-08-30T04:00:00.000Z',
    path: '/v1/messages',
    shape: 'anthropic',
    streaming: false,
    primaryModel: 'claude-opus-4-8',
    comparedModel: 'gpt-5.6-sol',
    request: { messages: [{ role: 'user', content: 'hi' }] },
    primary: { status: 200, body: 'A', ms: 10 },
    compare: { status: 200, body: 'B', ms: 20 },
  };

  const paths = Array.from({ length: 20 }, (_, i) =>
    writeCompareRecord({ ...same, request: { seq: i } }, dir));

  check('every write reports a path', paths.every((p) => typeof p === 'string'));
  check('identical timestamp + model still yield distinct filenames',
    new Set(paths).size === paths.length);
  check('and every record survives on disk — none is silently overwritten',
    readdirSync(dir).length === paths.length);

  const seqs = readdirSync(dir)
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')).request.seq)
    .sort((a, b) => a - b);
  check('each record keeps its own body rather than a winner\'s',
    JSON.stringify(seqs) === JSON.stringify(Array.from({ length: 20 }, (_, i) => i)));
  check('the model is still greppable in every name',
    readdirSync(dir).every((f) => f.includes('gpt-5.6-sol') && f.endsWith('.json')));
}

console.log(`\n${'='.repeat(70)}`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`${'='.repeat(70)}\n`);
if (fail > 0) process.exit(1);
