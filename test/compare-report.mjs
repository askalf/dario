#!/usr/bin/env node
// Tests for src/compare-report.ts — the reader behind `dario compare`.
//
// The records it reads have been written since v6.0.0; the reader exists
// because nothing read them, and 919 failed comparisons sat on a box for a
// week with the reason inside the files (#1306). So the case that matters
// most here is the unhappy one: a log full of skips has to say so on the
// first screen, not in file 700.

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  textOfBody, looksLikeJson, summarizeCompareRecords, formatCompareReport, readCompareDir,
} from '../dist/compare-report.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const side = (status, body, ms) => ({ status, body, ms });
const anthropic = (text) => JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] });
const sse = (text) => text.split(' ').map((w) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w + ' ' } })}\n\n`).join('');

header('textOfBody — every envelope the log can hold');
{
  check('an Anthropic message: the text blocks, thinking dropped', textOfBody(anthropic('{"a":1}')) === '{"a":1}');
  check('an SSE stream: the deltas in order', textOfBody(sse('one two three')).trim() === 'one two three');
  check('a legacy completion', textOfBody(JSON.stringify({ completion: 'hi' })) === 'hi');
  check('an error envelope has no text', textOfBody(JSON.stringify({ type: 'error', error: { message: 'nope' } })) === '');
  check('empty / null / junk are empty, never a throw', textOfBody('') === '' && textOfBody(null) === '' && textOfBody('not json at all') === '');
}

header('looksLikeJson — what an extraction caller actually needs back');
{
  check('plain JSON', looksLikeJson('{"entities":[]}'));
  check('fenced JSON, which models like to send', looksLikeJson('```json\n{"entities":[]}\n```') && looksLikeJson('```\n[1,2]\n```'));
  check('prose is not JSON', !looksLikeJson('Sure! Here are the entities:'));
  check('empty is not JSON', !looksLikeJson('') && !looksLikeJson('   '));
}

header('summarize — the numbers the bake-off was for');
{
  const records = [
    { ts: '2026-09-10T01:00:00Z', primaryModel: 'a', comparedModel: 'b', primary: side(200, anthropic('{"x":1}'), 100), compare: side(200, anthropic('{"x":1}'), 300) },
    { ts: '2026-09-11T01:00:00Z', primaryModel: 'a', comparedModel: 'b', primary: side(200, anthropic('prose'), 200), compare: side(200, anthropic('{"y":2}'), 400) },
    { ts: '2026-09-12T01:00:00Z', primaryModel: 'a', comparedModel: 'b', primary: side(500, anthropic(''), 300), compare: side(200, anthropic('{"z":3}'), 500) },
  ];
  const s = summarizeCompareRecords(records);
  check('three records, three pairs, the span', s.records === 3 && s.pairs === 3 && s.first === '2026-09-10T01:00:00Z' && s.last === '2026-09-12T01:00:00Z');
  const a = s.perModel.find((m) => m.model === 'a');
  const b = s.perModel.find((m) => m.model === 'b');
  check('primary: 3 calls, 2 ok, median 200ms, 1 of 3 parsed as JSON', a.calls === 3 && a.ok === 2 && a.medianMs === 200 && a.json === 1, JSON.stringify(a));
  check('compared: 3 calls, all ok, median 400ms, all JSON', b.calls === 3 && b.ok === 3 && b.medianMs === 400 && b.json === 3, JSON.stringify(b));
  check('average length is per call', a.avgChars === Math.round((7 + 5 + 0) / 3), a.avgChars);
}

header('summarize — a log of nothing but failures says so');
{
  // The production shape: the compare side never arrived, and every record
  // carries the same reason.
  const records = Array.from({ length: 12 }, (_, i) => ({
    ts: `2026-09-0${(i % 9) + 1}T01:00:00Z`,
    primaryModel: 'gpt-5.4-mini', comparedModel: 'gpt-5.5',
    primary: side(200, anthropic('{"ok":1}'), 50), compare: null,
    skipped: 'compare failed: res.removeListener is not a function',
  }));
  const s = summarizeCompareRecords(records);
  check('no pairs at all', s.pairs === 0);
  check('the compared model has no row — it never answered', !s.perModel.some((m) => m.model === 'gpt-5.5'));
  check('the primary is still counted', s.perModel[0].model === 'gpt-5.4-mini' && s.perModel[0].calls === 12);
  check('one skip reason, counted', s.skips.length === 1 && s.skips[0].count === 12 && s.skips[0].reason.includes('removeListener'));
  const text = formatCompareReport(s, '/tmp/x').join('\n');
  check('the report leads with it rather than hiding it', text.includes('Compared: 0 with both sides') && text.includes('Skipped comparisons:') && text.includes('12  compare failed') && text.includes('nothing to compare'), text.slice(0, 200));
}

header('report — shape, and the empty case that tells you how to start one');
{
  const s = summarizeCompareRecords([
    { ts: '2026-09-13T14:00:00Z', primaryModel: 'gpt-5.6-luna', comparedModel: 'gpt-5.5', primary: side(200, anthropic('{"a":1}'), 2736), compare: side(200, anthropic('{"a":1}'), 2729) },
  ]);
  const lines = formatCompareReport(s, '/tmp/x');
  const text = lines.join('\n');
  check('a header, the counts, one row per model', text.includes('dario — Shadow compare') && text.includes('Records: 1') && text.includes('Compared: 1 with both sides') && /gpt-5\.6-luna\s+1\s+100%\s+2736ms\s+100%/.test(text), text);
  check('no skip section when nothing was skipped', !text.includes('Skipped comparisons'));
  const empty = formatCompareReport(summarizeCompareRecords([]), '/tmp/none').join('\n');
  check('an empty log explains how a comparison is requested', empty.includes('No records in /tmp/none') && empty.includes('x-dario-compare'), empty);
}

header('readCompareDir — tolerant of what a directory really holds');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-compare-report-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ ts: '2026-09-13T00:00:00Z', primaryModel: 'm', primary: side(200, anthropic('{}'), 5) }));
  writeFileSync(join(dir, 'b.json'), '{ half written');
  writeFileSync(join(dir, 'notes.txt'), 'ignored');
  mkdirSync(join(dir, 'sub.json'));
  const records = readCompareDir(dir);
  check('reads the good record, skips the broken one and the non-JSON', records.length === 1 && records[0].primaryModel === 'm', JSON.stringify(records));
  check('a directory that does not exist is empty, not a throw', readCompareDir(join(dir, 'nope')).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
