#!/usr/bin/env node
/**
 * Capture a fresh template from the user's installed CC, scrub it, and
 * write it to `src/cc-template-data.json` as the bundled fallback.
 *
 * Only run this from the dario repo on a maintainer's own machine — the
 * scrubber strips host-identifying data before bake, but the raw capture
 * does pass through the capturing user's CC install.
 *
 * Usage:
 *   npm run build          # the script imports from dist/
 *   node scripts/capture-and-bake.mjs
 *
 * Exits 1 on capture failure (CC not on PATH, capture timeout, no tools).
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureLiveTemplateAsync, findInstalledCC } from '../dist/live-fingerprint.js';
import { scrubTemplate, findUserPathHits } from '../dist/scrub-template.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const OUT = join(repoRoot, 'src/cc-template-data.json');

function log(msg) {
  console.error(`[bake] ${msg}`);
}

const { path: ccPath, version: ccVersion } = findInstalledCC();
if (!ccPath) {
  log('error: no `claude` binary on PATH. Install @anthropic-ai/claude-code before running bake.');
  process.exit(1);
}
log(`using CC at ${ccPath} (version ${ccVersion ?? 'unknown'})`);

log('spawning CC against loopback MITM to capture /v1/messages...');
const captured = await captureLiveTemplateAsync(20_000);
if (!captured) {
  log('error: capture timed out or CC did not send a /v1/messages request within 20s.');
  process.exit(1);
}

log(`captured: CC v${captured._version}, ${captured.tools.length} tools, ${captured.system_prompt.length} char system prompt`);

const scrubbed = scrubTemplate(captured);
scrubbed._source = 'bundled';
// Record the newest CC version this baked snapshot has been verified against
// so loadBundledTemplate can warn when a user's installed CC is newer and
// live capture has not run yet. dario#76.
scrubbed._supportedMaxTested = captured._version;

const residualHits = findUserPathHits(JSON.stringify(scrubbed));
if (residualHits.length > 0) {
  log(`error: scrub left residual user paths in the serialized template:`);
  for (const h of residualHits.slice(0, 10)) log(`  - ${h}`);
  process.exit(1);
}

const droppedMcp = captured.tools.length - scrubbed.tools.length;
const strippedAutoMemory = captured.system_prompt.includes('# auto memory') && !scrubbed.system_prompt.includes('# auto memory');

log(`scrubbed:`);
log(`  tools: ${captured.tools.length} → ${scrubbed.tools.length} (dropped ${droppedMcp} mcp__* tool${droppedMcp === 1 ? '' : 's'})`);
log(`  system_prompt: ${captured.system_prompt.length} → ${scrubbed.system_prompt.length} chars${strippedAutoMemory ? ' (# auto memory section removed)' : ''}`);

const prev = JSON.parse(readFileSync(OUT, 'utf-8'));
log(`previous baked template: CC v${prev._version} captured ${prev._captured}, ${prev.tools.length} tools, ${prev.system_prompt.length} char system prompt`);

writeFileSync(OUT, JSON.stringify(scrubbed, null, 2) + '\n');
log(`wrote ${OUT}`);
log(`summary: CC v${prev._version} → v${scrubbed._version}, tools ${prev.tools.length} → ${scrubbed.tools.length}, system_prompt ${prev.system_prompt.length} → ${scrubbed.system_prompt.length} chars`);
