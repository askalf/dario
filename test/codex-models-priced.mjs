#!/usr/bin/env node
// Every ChatGPT-plan model the snapshot lists has a price.
//
// test/fixtures/codex-models.snapshot.json is the model list the live-test
// account sees, kept current by codex-drift-watch.yml. A model with
// visibility `list` is one dario routes. One with no row in OPENAI_PRICING is
// costed at another model's rate, with nothing in the output to say so:
// gpt-6.1-sol and gpt-6.1-terra read at gpt-5.6-terra's $2/$12 until 6.23.5.
//
// The pricing watcher cannot catch this. It walks dario's rows against
// OpenAI's page, and that page lists many models no ChatGPT plan serves. The
// snapshot is the list that matters, so a snapshot that gains a model fails
// here until the model has a row.

import { readFileSync } from 'node:fs';

import { OPENAI_PRICING, hasPublishedRate, providerOfModel } from '../dist/analytics.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + detail : ''}`); fail++; }
};

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/codex-models.snapshot.json', import.meta.url), 'utf8'));
const listed = (snapshot.models ?? []).filter((m) => m.visibility === 'list').map((m) => m.slug);

console.log('\n=== every listed ChatGPT-plan model has a row in OPENAI_PRICING ===');
// A snapshot that ships empty is the state before the watch's first run: nothing to hold to a price yet.
check(`the snapshot lists ${listed.length} routable model${listed.length === 1 ? '' : 's'}`, Array.isArray(snapshot.models));
for (const slug of listed) {
  check(`${slug} is priced from OpenAI's table`, providerOfModel(slug) === 'openai' && Object.hasOwn(OPENAI_PRICING, slug) && hasPublishedRate(slug),
    'add its row to OPENAI_PRICING in src/analytics.ts from https://developers.openai.com/api/docs/pricing');
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
