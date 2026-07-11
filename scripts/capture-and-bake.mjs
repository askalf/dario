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
 *   node scripts/capture-and-bake.mjs              # capture + scrub + write
 *   node scripts/capture-and-bake.mjs --check      # capture + diff; exit 2 on shape drift, 3 on label-only drift, 0 on full match
 *   node scripts/capture-and-bake.mjs --allow-older-cc  # bypass the stale-binary guard (deliberate downgrade bake)
 *
 * The --check mode is non-destructive: it captures + scrubs but does not
 * write to disk. Useful from a scheduled cron (see docs/drift-monitor.md)
 * to detect same-binary remote-config drift — the class of change
 * documented in v4.2.1's CHANGELOG entry where CC's wire output shifts
 * within a single npm version. On non-zero exit, the wrapping cron / CI
 * step can open an issue or auto-PR a re-bake.
 *
 * Exits:
 *   0 — capture succeeded; in default mode wrote OUT; in --check mode, full match
 *       (wire shape AND _version label both current)
 *   1 — infrastructure failure (CC not on PATH, capture timeout, scrub failure,
 *       or installed CC OLDER than the bundle's capture — stale runner; an older
 *       binary re-captures yesterday's wire shape and would report it as drift,
 *       which reached the ship gate as a template downgrade in PR #632. Bypass
 *       for a deliberate downgrade bake with --allow-older-cc)
 *   2 — --check mode only: wire-SHAPE drift vs current OUT (tools / system_prompt /
 *       beta / field order changed — needs a real re-bake; human-reviewed)
 *   3 — --check mode only: LABEL-only drift — wire shape matches but the bundled
 *       `_version` lags the live CC version. computeDrift ignores `_version` (its
 *       job is within-version shape drift), so this slips past exit 2, yet
 *       sdk-drift-watch.yml flags it against npm. Distinct code so the workflow
 *       can ship a deterministic label bump (scripts/label-sync.mjs) instead of
 *       waiting for a shape rebake to happen to ride along. On exit 3 the live
 *       version is written to `label-target.txt` for the workflow to consume.
 */

import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureLiveTemplateAsync, findInstalledCC } from '../dist/live-fingerprint.js';
import { scrubTemplate, findUserPathHits } from '../dist/scrub-template.js';
import { PLATFORM_ONLY_TOOLS, INTERACTIVE_ONLY_TOOLS } from '../dist/cc-template.js';
import { computeDrift, formatDriftReport, interpretDrift, formatDriftSummary, stripModelConditionalBetas, isOlderCCVersion } from './drift-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const OUT = join(repoRoot, 'src/cc-template-data.json');

const CHECK_MODE = process.argv.includes('--check');
const ALLOW_OLDER_CC = process.argv.includes('--allow-older-cc');

function log(msg) {
  console.error(`[bake] ${msg}`);
}

const { path: ccPath, version: ccVersion } = findInstalledCC();
if (!ccPath) {
  log('error: no `claude` binary on PATH. Install @anthropic-ai/claude-code before running bake.');
  process.exit(1);
}
log(`using CC at ${ccPath} (version ${ccVersion ?? 'unknown'})${CHECK_MODE ? ' [--check mode: dry-run]' : ''}`);

// The shared BASE is always captured on a non-Fable model (Opus): CC 2.1.198
// ships Fable a larger, model-specific system prompt, and baking that into the
// base would inject a Fable identity into every non-Fable request. The Fable
// variant is captured separately below (dario#lock-step). Both captures pin the
// model via ANTHROPIC_MODEL so the bake is deterministic regardless of the
// operator's saved default (which is what previously contaminated the base).
const BASE_MODEL = 'claude-opus-4-8';
const FABLE_MODEL = 'claude-fable-5';
async function captureForModel(model, label) {
  const saved = process.env.ANTHROPIC_MODEL;
  process.env.ANTHROPIC_MODEL = model;
  try {
    log(`spawning CC (${label}: ${model}) against loopback MITM to capture /v1/messages...`);
    return await captureLiveTemplateAsync(20_000);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = saved;
  }
}
const captured = await captureForModel(BASE_MODEL, 'base');
if (!captured) {
  log('error: capture timed out or CC did not send a /v1/messages request within 20s.');
  process.exit(1);
}

log(`captured: CC v${captured._version}, ${captured.tools.length} tools, ${captured.system_prompt.length} char system prompt`);

const scrubbed = scrubTemplate(captured);
// Strip the model-conditional betas betaForModel() appends per-request
// (context-1m on [1m] requests, fallback-credit on fable) so the baked BASE set
// matches #475's design — they're re-added per-request at runtime, not part of
// the canonical base. Without this, a capture that rode one (the drift runner's
// capture carries context-1m) would re-introduce it to the base on every rebake,
// undoing #475. Same set the drift detector ignores (drift-report.mjs).
const beforeBeta = scrubbed.anthropic_beta || '';
scrubbed.anthropic_beta = stripModelConditionalBetas(beforeBeta);
if (scrubbed.anthropic_beta !== beforeBeta) {
  log(`stripped model-conditional beta(s) from baked base: ${beforeBeta} → ${scrubbed.anthropic_beta}`);
}
scrubbed._source = 'bundled';
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

// ── Stale-binary guard ────────────────────────────────────────────────
// An installed CC OLDER than the one that baked the current bundle cannot
// observe forward drift — it re-captures the previous wire shape, and in
// --check mode that reads as exit-2 "drift" whose auto-rebake is a template
// DOWNGRADE (PR #632: runner at 2.1.197 against the 2.1.198 bundle reported
// the afk-mode beta "removed"). Treat it as an infrastructure failure (exit 1,
// same class as CC-not-on-PATH) so the watcher run fails red with a fix-the-
// runner message instead of reaching the ship gate. A deliberate downgrade
// bake (e.g. an upstream CC release gets pulled and the bundle must go
// backward) bypasses with --allow-older-cc.
if (isOlderCCVersion(captured._version, prev._version)) {
  if (ALLOW_OLDER_CC) {
    log(`warning: installed CC v${captured._version} is older than the bundle's capture (v${prev._version}) — proceeding because --allow-older-cc was passed.`);
  } else {
    log(`error: installed CC v${captured._version} is OLDER than the CC that baked the current bundle (v${prev._version}).`);
    log('error: an older binary cannot observe forward drift; any "drift" it reports would re-bake the previous wire shape (a downgrade).');
    log('error: update CC on this machine (npm i -g @anthropic-ai/claude-code@latest) and re-run, or pass --allow-older-cc for a deliberate downgrade bake.');
    process.exit(1);
  }
}

// Preserve other-platform tools from the previous bundle so the baked file
// remains a union across maintainers' platforms. A bake on Linux must not
// drop Windows-only tools (e.g. PowerShell) or vice versa — the bundled
// JSON is filtered down to per-platform at request time by
// filterToolsForPlatform(); the bundle itself must remain a superset.
const currentPlat = process.platform;
const scrubbedNames = new Set(scrubbed.tools.map((t) => t.name));
const preservedOtherPlatTools = (prev.tools || []).filter((t) => {
  if (scrubbedNames.has(t.name)) return false;
  for (const [plat, names] of Object.entries(PLATFORM_ONLY_TOOLS)) {
    if (names.has(t.name) && plat !== currentPlat) return true;
  }
  return false;
});
if (preservedOtherPlatTools.length > 0) {
  log(`preserved ${preservedOtherPlatTools.length} other-platform tool${preservedOtherPlatTools.length === 1 ? '' : 's'} from previous bundle: ${preservedOtherPlatTools.map((t) => t.name).join(', ')}`);
  // CC sends tools alphabetically by name — sort after merge so the preserved
  // tools insert at their natural position rather than appending at the end.
  scrubbed.tools = [...scrubbed.tools, ...preservedOtherPlatTools].sort((a, b) => a.name.localeCompare(b.name));
}

// Preserve interactive-only tools from the previous bundle. The capture spawns
// CC headlessly (`claude --print -p hi`), and CC v2.1.187 stopped advertising
// AskUserQuestion / EnterPlanMode / ExitPlanMode in --print mode — so a fresh
// headless capture drops them even though every real interactive CC client still
// sends them. Like the platform-tool preservation above, re-add them from the
// previous bundle so the bundled JSON stays a superset; dropping them broke
// buildCCRequest's advertise-respects-client contract (v4.8.93). Sorted back in
// alphabetically to match CC's wire order.
const preservedInteractiveTools = (prev.tools || []).filter(
  (t) => INTERACTIVE_ONLY_TOOLS.has(t.name) && !scrubbed.tools.some((s) => s.name === t.name),
);
if (preservedInteractiveTools.length > 0) {
  log(`preserved ${preservedInteractiveTools.length} interactive-only tool${preservedInteractiveTools.length === 1 ? '' : 's'} from previous bundle (headless capture omits them): ${preservedInteractiveTools.map((t) => t.name).join(', ')}`);
  scrubbed.tools = [...scrubbed.tools, ...preservedInteractiveTools].sort((a, b) => a.name.localeCompare(b.name));
}
log(`previous baked template: CC v${prev._version} captured ${prev._captured}, ${prev.tools.length} tools, ${prev.system_prompt.length} char system prompt`);

// ── Fable system-prompt variant (dario#lock-step) ────────────────────
// CC 2.1.198 sends Fable a larger, model-specific system prompt than the base.
// Capture it on Fable, scrub it the same way, and store the scrubbed variant so
// Fable requests carry Fable's actual CC prompt (cc-template.ts:systemPromptForModel).
// Stored ONLY when it differs from the base — otherwise runtime falls back to base.
let fableVariant = null;
try {
  const capturedFable = await captureForModel(FABLE_MODEL, 'fable-variant');
  if (capturedFable) {
    const fableScrubbed = scrubTemplate(capturedFable);
    if (fableScrubbed.system_prompt && fableScrubbed.system_prompt !== scrubbed.system_prompt) {
      const fResidual = findUserPathHits(fableScrubbed.system_prompt);
      if (fResidual.length > 0) {
        log(`warning: fable-variant scrub left residual user paths — NOT storing variant: ${fResidual.slice(0, 3).join(', ')}`);
        fableVariant = prev.system_prompt_fable ?? null;
      } else {
        fableVariant = fableScrubbed.system_prompt;
        log(`fable system-prompt variant: base ${scrubbed.system_prompt.length} → fable ${fableVariant.length} chars`);
      }
    } else {
      log('fable-variant matches base — no separate variant stored.');
    }
  } else {
    log('warning: fable-variant capture failed — keeping previous variant if any.');
    fableVariant = prev.system_prompt_fable ?? null;
  }
} catch (e) {
  log(`warning: fable-variant capture error (${e.message}) — keeping previous variant if any.`);
  fableVariant = prev.system_prompt_fable ?? null;
}
if (fableVariant) scrubbed.system_prompt_fable = fableVariant;

// ── --check mode: diff and exit; do not write ────────────────────────
if (CHECK_MODE) {
  // Remove any leftover drift-summary.md BEFORE diffing. The watch workflow
  // embeds the file into issue/PR bodies whenever it exists, but this run
  // only writes it for the drift it actually found — so a stale copy (from
  // a previous run on the persistent self-hosted runner workdir, or the
  // once-tracked copy that #669 accidentally committed) gets embedded as if
  // it described THIS run's drift.
  const summaryPath = join(repoRoot, 'drift-summary.md');
  rmSync(summaryPath, { force: true });
  const diff = computeDrift(prev, scrubbed);
  const variantDrift = (prev.system_prompt_fable ?? '') !== (scrubbed.system_prompt_fable ?? '');
  if (diff.length === 0 && !variantDrift) {
    // Wire shape matches. But the bundled _version LABEL may still lag the
    // live CC version: computeDrift intentionally ignores _version (its job
    // is to catch within-version SHAPE drift), so a stale label reads as
    // "no drift" here — yet sdk-drift-watch.yml, which compares _version
    // against npm's claude-code@latest, flags it with nothing to re-bake.
    // Signal that label-only case distinctly (exit 3) so the workflow can
    // ship a deterministic label bump (scripts/label-sync.mjs). Safe to
    // auto-merge precisely because this empty diff PROVES the shape is
    // identical at the live version — only the label moves.
    if (prev._version !== captured._version) {
      log(`check: no wire-shape drift, but bundled _version (${prev._version}) lags live CC (${captured._version}) — label-only drift.`);
      writeFileSync(join(repoRoot, 'label-target.txt'), captured._version + '\n');
      process.exit(3);
    }
    log('check: no drift detected. Bundled template matches live capture.');
    process.exit(0);
  }
  // v4.7.0: lead with a one-line verdict + per-axis breakdown so the
  // workflow embedding this output (and any human reading the log)
  // sees the ship/investigate signal before the line-by-line detail.
  if (diff.length > 0) {
    const interp = interpretDrift(diff);
    log(`check: drift detected — ${diff.length} differing slot${diff.length === 1 ? '' : 's'} (verdict: ${interp.verdict}):`);
    for (const line of formatDriftSummary(interp)) log(line);
    log('');
    log('check: per-slot detail:');
    for (const line of formatDriftReport(diff)) log(line);
    writeFileSync(summaryPath, formatDriftSummary(interp).join('\n') + '\n');
    log(`wrote drift-summary.md for workflow embedding`);
  }
  if (variantDrift) {
    log(`check: fable system-prompt variant drift (${(prev.system_prompt_fable ?? '').length} → ${(scrubbed.system_prompt_fable ?? '').length} chars).`);
    if (diff.length === 0) {
      // The slot diff is empty, so the drift-detected branch above wrote no
      // summary — give the workflow embed an accurate variant-only one
      // instead of leaving the body summary-less (or, before the rmSync
      // above, stale).
      writeFileSync(summaryPath, [
        '**Verdict:** 🟡 Moderate — fable system-prompt variant only',
        '',
        `- **system_prompt_fable:** ${(prev.system_prompt_fable ?? '').length} → ${(scrubbed.system_prompt_fable ?? '').length} chars (base system prompt, tools, and anthropic_beta unchanged)`,
      ].join('\n') + '\n');
      log('wrote drift-summary.md (variant-only) for workflow embedding');
    }
  }
  log('check: bundled template is stale relative to live CC. Run `node scripts/capture-and-bake.mjs` to re-bake.');

  process.exit(2);
}

// ── Default mode: write the new template ─────────────────────────────
writeFileSync(OUT, JSON.stringify(scrubbed, null, 2) + '\n');
log(`wrote ${OUT}`);
log(`summary: CC v${prev._version} → v${scrubbed._version}, tools ${prev.tools.length} → ${scrubbed.tools.length}, system_prompt ${prev.system_prompt.length} → ${scrubbed.system_prompt.length} chars`);


// `computeDrift` + `unifiedDiff` + `formatDriftReport` live in
// `./drift-report.mjs` so they can be unit-tested without importing this
// file (top-level `await captureLiveTemplateAsync` would block the test
// runner on a live CC capture). Imported above.
