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

  // Second Read finding, 2026-08-30. The filename was built from the record's
  // millisecond timestamp alone, so two comparisons finishing in the same
  // millisecond produced the same path and one silently overwrote the other —
  // invisible, because the log would simply hold fewer records than requests.
  {
    const raceDir = mkdtempSync(join(tmpdir(), 'dario-compare-race-'));
    const SAME_MS = { ...record, ts: '2026-08-30T12:00:00.000Z' };
    const a = writeCompareRecord({ ...SAME_MS, primary: { status: 200, body: 'FIRST', ms: 1 } }, raceDir);
    const b = writeCompareRecord({ ...SAME_MS, primary: { status: 200, body: 'SECOND', ms: 2 } }, raceDir);

    check('two records in the SAME millisecond get two distinct paths', a !== b);
    check('...and both survive on disk', readdirSync(raceDir).length === 2);
    check('...with the first one not overwritten',
      JSON.parse(readFileSync(a, 'utf-8')).primary.body === 'FIRST');
    check('...and the second one intact too',
      JSON.parse(readFileSync(b, 'utf-8')).primary.body === 'SECOND');

    const c = writeCompareRecord({ ...SAME_MS, primary: { status: 200, body: 'THIRD', ms: 3 } }, raceDir);
    check('a third collision keeps counting rather than giving up',
      c !== a && c !== b && readdirSync(raceDir).length === 3);
  }

  check('an unwritable destination returns null instead of throwing',
    writeCompareRecord(record, '\0::invalid::') === null);
  check('a record with a skip reason and no compare side is still written',
    typeof writeCompareRecord({ ...record, compare: null, skipped: 'no Codex account configured' }, dir) === 'string');
}

console.log(`\n${'='.repeat(70)}`);
console.log(`  Results: ${pass} passed, ${fail} failed`);
console.log(`${'='.repeat(70)}\n`);
if (fail > 0) process.exit(1);
