#!/usr/bin/env node
/**
 * A/B shape memory for per-model prompt variants — the fix for the #1095
 * rebake ping-pong.
 *
 * The measured failure: Anthropic A/B-serves alternative system-prompt arms
 * for the same model at the same CC version. Across 2026-08-23/24 the fable
 * variant flip-flopped between the SAME two byte-stable shapes (9072 and
 * 9220 chars) through FOUR auto-rebakes in ~25 hours — each hourly check
 * captured whichever arm the per-request dice rolled, compared it strictly
 * against the single baked arm, called the difference drift, and rebaked;
 * the next check rolled the other arm and did it again, forever.
 *
 * The fix: `_variantShapeHashes` records every distinct shape ever observed
 * per family. classifyVariantShape() calls a re-served known arm 'known-alt'
 * (not drift; the bake keeps its canonical), and only a never-seen shape is
 * 'new' (real drift, worth a rebake). This file pins the classifier, the
 * hash identity, and the seeded bundle's invariants.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { variantShapeHash, classifyVariantShape } from '../dist/live-fingerprint.js';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { console.log(`  OK ${name}`); pass++; } else { console.log(`  FAIL ${name}`); fail++; } };
const header = (n) => console.log(`\n=== ${n} ===`);

header('variantShapeHash is plain full sha256 hex');
{
  const t = 'the exact bytes matter';
  check('matches node crypto directly', variantShapeHash(t) === createHash('sha256').update(t).digest('hex'));
  check('full 64-hex digest', /^[0-9a-f]{64}$/.test(variantShapeHash(t)));
  check('byte-sensitive', variantShapeHash('a') !== variantShapeHash('a '));
}

header('classifyVariantShape: the three verdicts');
{
  const armA = 'arm A — the currently baked canonical';
  const armB = 'arm B — the other A/B arm, seen before';
  const armC = 'arm C — a shape never served until now';
  const known = [variantShapeHash(armA), variantShapeHash(armB)];
  check('byte-equal to canonical → canonical', classifyVariantShape(armA, armA, known) === 'canonical');
  check('a re-served known arm → known-alt (NOT drift)', classifyVariantShape(armB, armA, known) === 'known-alt');
  check('a never-seen shape → new (real drift)', classifyVariantShape(armC, armA, known) === 'new');
  // The exact pre-fix failure: no memory at all — every alt looks new.
  check('with no memory, an alt is (correctly) new', classifyVariantShape(armB, armA, undefined) === 'new');
  check('canonical wins even when absent from the memory', classifyVariantShape(armA, armA, []) === 'canonical');
  // A family with no baked canonical yet (first capture) is 'new' unless remembered.
  check('no canonical + unknown shape → new', classifyVariantShape(armC, undefined, known) === 'new');
  check('no canonical + known shape → known-alt', classifyVariantShape(armB, undefined, known) === 'known-alt');
}

header('the shipped bundle carries a consistent shape memory');
{
  const d = JSON.parse(readFileSync(new URL('../src/cc-template-data.json', import.meta.url), 'utf8'));
  const mem = d._variantShapeHashes;
  check('_variantShapeHashes exists', !!mem && typeof mem === 'object');
  const variants = d.system_prompt_variants || {};
  for (const [k, text] of Object.entries(variants)) {
    check(`${k}: canonical shape is in its own memory`, Array.isArray(mem[k]) && mem[k].includes(variantShapeHash(text)));
    check(`${k}: every remembered hash is full sha256 hex`, (mem[k] || []).every((h) => /^[0-9a-f]{64}$/.test(h)));
    check(`${k}: memory is sorted and duplicate-free`, JSON.stringify(mem[k]) === JSON.stringify([...new Set(mem[k])].sort()));
  }
  // The two fable arms measured in the #1095 ping-pong must both be remembered —
  // that pair IS the regression this mechanism exists to absorb.
  check('fable remembers BOTH measured A/B arms', (mem.fable || []).length >= 2);
  check('opus-5 remembers both measured arms', (mem['opus-5'] || []).length >= 2);
}

header('the bake script wires the classifier, not a strict !==');
{
  const bake = readFileSync(new URL('../scripts/capture-and-bake.mjs', import.meta.url), 'utf8');
  check('bake loop classifies the captured arm', /classifyVariantShape\(vScrubbed\.system_prompt, prevVariants\[key\]/.test(bake));
  check('a known-alt keeps the previous canonical (sticky)', /variants\[key\] = prevVariants\[key\];\s*\n\s*variantOutcomes\[key\] = 'known-alt';/.test(bake));
  check('the outgoing bundle carries the unioned memory', /scrubbed\._variantShapeHashes = memory;/.test(bake));
  check('check mode logs known arms as not-drift', /known A\/B arm[\s\S]{0,80}not drift/.test(bake));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
