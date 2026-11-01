#!/usr/bin/env node
// Per-key default effort, the pure half: the vocabulary, the record, create /
// set / clear / rotate, the file parser's tolerance, the public shape, and the
// request-side test that decides whether a key's default applies (a request
// that named its own effort is never overruled). In-process; no proxy, no
// credentials, no network.

import {
  KEY_EFFORT_VALUES, isKeyEffort, createKey, emptyKeysFile, publicKey, rotateKey, setKeyEffort, parseKeysFile,
} from '../dist/keys.js';
import { requestNamesEffort, parseEffortSuffix, effortForCodex } from '../dist/effort.js';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  OK ${label}`); pass++; }
  else { console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (l) => console.log(`\n=== ${l} ===`);
const NOW = Date.parse('2026-11-01T22:00:00Z');

header('vocabulary: the wire-valid levels and nothing else');
{
  check('five levels', KEY_EFFORT_VALUES.join(',') === 'low,medium,high,xhigh,max');
  for (const v of KEY_EFFORT_VALUES) check(`isKeyEffort(${v})`, isKeyEffort(v));
  for (const v of ['client', 'ultracode', 'LOW', 'turbo', '', 7, null, undefined, {}]) check(`not a key effort: ${JSON.stringify(v)}`, !isKeyEffort(v));
  check('every key effort maps straight through to the Codex level', KEY_EFFORT_VALUES.every((v) => effortForCodex(v) === v));
}

header('record: create, set, clear, rotate, public shape');
{
  const file = emptyKeysFile();
  const alice = createKey(file, 'alice', { effort: 'low', now: NOW });
  check('create carries the effort', alice.record.effort === 'low');
  check('public shape exposes it', publicKey(alice.record, NOW).effort === 'low');
  const bob = createKey(file, 'bob', { now: NOW });
  check('no effort: absent on the record, null in public', bob.record.effort === undefined && publicKey(bob.record, NOW).effort === null);
  let threw = null;
  try { createKey(file, 'carol', { effort: 'turbo', now: NOW }); } catch (e) { threw = e.message; }
  check('create refuses an unknown level', /invalid effort "turbo"/.test(threw ?? ''), threw);
  threw = null;
  try { createKey(file, 'dave', { effort: 'client', now: NOW }); } catch (e) { threw = e.message; }
  check('create refuses client (that is the pin vocabulary, not a key default)', /invalid effort/.test(threw ?? ''), threw);
  check('an empty effort string means none', createKey(file, 'erin', { effort: '', now: NOW }).record.effort === undefined);
  check('set on an existing key', setKeyEffort(file, 'bob', 'xhigh')?.effort === 'xhigh');
  check('set returns null for an unknown key', setKeyEffort(file, 'nobody', 'low') === null);
  threw = null;
  try { setKeyEffort(file, 'bob', 'ultracode'); } catch (e) { threw = e.message; }
  check('set refuses a client mode', /invalid effort/.test(threw ?? ''), threw);
  check('the refused set left the old value', file.keys.find((k) => k.name === 'bob').effort === 'xhigh');
  check('clear with null', setKeyEffort(file, 'bob', null)?.effort === undefined);
  setKeyEffort(file, 'bob', 'max');
  check('clear with an empty string', setKeyEffort(file, 'bob', '')?.effort === undefined);
  setKeyEffort(file, 'alice', 'medium');
  const rotated = rotateKey(file, 'alice', NOW);
  check('rotate keeps the effort', rotated.record.effort === 'medium' && rotated.secret !== alice.secret);
}

header('file: a default survives a round trip; an unknown level on disk is dropped');
{
  const file = emptyKeysFile();
  createKey(file, 'alice', { effort: 'low', now: NOW });
  createKey(file, 'bob', { now: NOW });
  const text = JSON.stringify({ version: file.version, keys: file.keys });
  const back = parseKeysFile(text);
  check('round trip keeps the level', back.keys.find((k) => k.name === 'alice').effort === 'low');
  check('round trip keeps the absence', back.keys.find((k) => k.name === 'bob').effort === undefined);
  const dirty = JSON.parse(text);
  dirty.keys[1].effort = 'turbo';
  dirty.keys[0].effort = 'client';
  const cleaned = parseKeysFile(JSON.stringify(dirty));
  check('unknown and pin-only levels are dropped, the keys stay', cleaned.keys.length === 2 && cleaned.keys.every((k) => k.effort === undefined));
  const typed = JSON.parse(text);
  typed.keys[1].effort = 42;
  check('a non-string level is dropped', parseKeysFile(JSON.stringify(typed)).keys[1].effort === undefined);
}

header('request side: when does a key default apply?');
{
  check('empty body: no effort named', !requestNamesEffort({}));
  check('null body: no effort named', !requestNamesEffort(null) && !requestNamesEffort(undefined));
  check('Messages shape output_config.effort counts', requestNamesEffort({ output_config: { effort: 'low' } }));
  check('output_config without effort does not', !requestNamesEffort({ output_config: { format: { type: 'json_schema' } } }));
  check('a non-string effort does not', !requestNamesEffort({ output_config: { effort: 3 } }));
  check('chat completions reasoning_effort counts', requestNamesEffort({ reasoning_effort: 'high' }));
  check('an empty reasoning_effort does not', !requestNamesEffort({ reasoning_effort: '' }));
  check('Responses reasoning.effort counts', requestNamesEffort({ reasoning: { effort: 'medium' } }));
  check('reasoning without effort does not', !requestNamesEffort({ reasoning: { summary: 'auto' } }));
  check('a thinking block alone is not an effort choice', !requestNamesEffort({ thinking: { type: 'enabled', budget_tokens: 2048 } }));
  // The suffix is the caller's job: parsed off the model before the body test runs.
  check('suffix still parses beside this', parseEffortSuffix('claude-opus-5-5:low').effort === 'low');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
