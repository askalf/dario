#!/usr/bin/env node
// Client-version gate parsing + the sentence dario answers with.
//
// 2026-09-22, the day claude-opus-5-5 shipped: every request for it came back
//   400 {"type":"invalid_request_error","message":"Claude Code 2.1.278 does not
//        support this model; version 2.1.280 or newer is required. Run 'claude
//        update', or update the Claude Code SDK."}
// Anthropic gates a new model on the client version it reads off the request,
// which for dario is the bundled template's `user-agent: claude-cli/<_version>`.
// Nothing about the pool, the seat or the model was wrong, and the message names
// Claude Code — which the caller (Cursor, Cline, the Agent SDK) usually is not.
// The daily sdk-drift watch compares the bundle against npm and can be a day
// behind the publish, so this 400 is the first symptom and it has to say what it
// means on its own.

import assert from 'node:assert';
import { parseClientVersionGate, describeClientVersionGate } from '../dist/proxy.js';

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

// --- the live-observed wire shape ---
const live = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: "Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required. "
      + "Run 'claude update', or update the Claude Code SDK.",
  },
  request_id: 'req_011CfJoivTcfNRfKJNjmZapZ',
});
const g = parseClientVersionGate(live);
check('live shape parses', g !== null);
check('claimed version extracted', g.claimed === '2.1.278');
check('required version extracted', g.required === '2.1.280');

check('case-insensitive match', parseClientVersionGate('CLAUDE CODE 2.1.1 DOES NOT SUPPORT THIS MODEL; VERSION 2.2.0 OR NEWER IS REQUIRED') !== null);
check('two-part versions parse', parseClientVersionGate('Claude Code 3.0 does not support this model; version 3.1 or newer is required').required === '3.1');

// --- the neighbouring 400s must not be swallowed by this branch ---
check('effort rejection is not a version gate',
  parseClientVersionGate('{"error":{"message":"This model does not support effort level \'max\'. Supported levels: high, low, medium."}}') === null);
check('max_tokens rejection is not a version gate',
  parseClientVersionGate('{"error":{"message":"max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-opus-4-1-20250805."}}') === null);
check('model_not_found is not a version gate',
  parseClientVersionGate('{"error":{"message":"model: claude-opus-5.5 was not found. Did you mean claude-opus-5-5?"}}') === null);
check('unrelated 400 → null', parseClientVersionGate('{"error":{"message":"long context beta is not yet available"}}') === null);

// --- the sentence the caller reads ---
const sentence = describeClientVersionGate({ claimed: '2.1.278', required: '2.1.280' }, 'claude-opus-5-5');
check('names the model', sentence.includes('claude-opus-5-5'));
check('names both versions', sentence.includes('2.1.280') && sentence.includes('2.1.278'));
check('says it is the template label, not the caller', /template/i.test(sentence) && /not your client/i.test(sentence));
check('carries the remedy', sentence.includes('claude-code@latest') && /cc-drift-template-watch/.test(sentence));
check('no em dash', !sentence.includes('—'));

console.log(`client-version-gate: ${passed} passed, 0 failed`);
