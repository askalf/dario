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
 *   node scripts/capture-and-bake.mjs --allow-missing-variant  # bypass the lock-step gate (ship a family with NO variant)
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
 *       for a deliberate downgrade bake with --allow-older-cc. Also: a
 *       VARIANT_FAMILIES capture failed with no previous variant to keep —
 *       shipping would silently serve that family the base prompt, and in
 *       --check the absence would masquerade as variant drift. Bypass with
 *       --allow-missing-variant)
 *   2 — --check mode only: wire-SHAPE drift vs current OUT (tools / system_prompt /
 *       beta / field order changed — needs a real re-bake; human-reviewed)
 *   4 — bake mode only: the capture drops tools NO preservation set classifies
 *       and --allow-tool-drops was not passed — refusing to shrink the bundle
 *       silently (dario#1062).
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

import { captureLiveTemplateAsync, findInstalledCC, promptVariantsOf, TEMPLATE_BASE_MODEL, VARIANT_FAMILIES, unclassifiedToolDrops, variantShapeHash, classifyVariantShape } from '../dist/live-fingerprint.js';
import { scrubTemplate, findUserPathHits } from '../dist/scrub-template.js';
import { PLATFORM_ONLY_TOOLS, INTERACTIVE_ONLY_TOOLS, CONFIG_SCOPED_TOOLS } from '../dist/cc-template.js';
import { computeDrift, formatDriftReport, interpretDrift, formatDriftSummary, stripModelConditionalBetas, isOlderCCVersion, detectIssue881Residue, formatIssue881Warning } from './drift-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const OUT = join(repoRoot, 'src/cc-template-data.json');

const CHECK_MODE = process.argv.includes('--check');
const ALLOW_OLDER_CC = process.argv.includes('--allow-older-cc');
const ALLOW_NON_LINUX = process.argv.includes('--allow-non-linux-bake');
const ALLOW_MISSING_VARIANT = process.argv.includes('--allow-missing-variant');

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
const BASE_MODEL = TEMPLATE_BASE_MODEL;
// Models CC ships a DIFFERENT system prompt to. Measured on CC 2.1.220
// (2026-07-25), two byte-identical passes each, raw chars vs the opus-4-8
// base at 6664: fable-5 11084, opus-5 9990, sonnet-5 28156. A variant is
// stored only when it differs from the base after scrubbing.
//
// Derived from VARIANT_FAMILIES, the same table systemPromptForModel selects
// from at runtime — a family added there is captured here with no second
// hand-maintained list to forget (the tool_names ≠ tools divergence class).
const VARIANT_MODELS = VARIANT_FAMILIES.map((f) => ({ key: f.key, model: f.captureModel }));
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
  log(`error: scrub left host content in the serialized template (paths, an unstripped section, or instruction-file prose — dario#872):`);
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


// Bake host must be Linux, because CC's prompt is not host-portable.
//
// The sonnet-5 variant names the tools that exist where the capture ran: a
// Windows host yields `, Glob, Grep` and `the Glob or Grep`, a Linux host yields
// `\`find\` or \`grep\` via the Bash tool`. Six bytes, in one slot, and every other
// slot byte-identical. So a Windows bake and CI's Linux bake each report the
// other as drift and re-bake forever — dario#854 -> #860 was the same disease
// through the path channel, #856 through the OS/arch header channel, and this is
// the third channel: prose that mentions the tool list.
//
// Unlike those two, this one cannot be normalised away. The correct text depends
// on which tools the caller actually has, which the bundle cannot know, and
// rewriting CC's prose would be inventing wire shape rather than replaying it.
// PLATFORM_ONLY_TOOLS already unions the tools ARRAY across platforms; nothing
// can union a sentence.
//
// So the fix is procedural: CI bakes on Linux (cc-drift-template-watch, which
// also pins the OAuth sole-refresher), and a bake from anywhere else has to be
// deliberate. --check is deliberately NOT gated — detecting drift from any
// platform is useful and harmless; only WRITING the bundle is restricted.
if (!CHECK_MODE && process.platform !== 'linux') {
  if (ALLOW_NON_LINUX) {
    log(`warning: baking on ${process.platform}, not linux — proceeding because --allow-non-linux-bake was passed.`);
    log('warning: expect CI to re-bake this bundle on its next drift check (see the sonnet-5 variant note in this file).');
  } else {
    log(`error: refusing to write the bundle from ${process.platform}. CC's prompt names the tools available on the bake host, so a non-Linux bundle ping-pongs with CI's Linux bake indefinitely.`);
    log('error: dispatch the cc-drift-template-watch workflow instead — it bakes on Linux and pins the OAuth sole-refresher.');
    log('error: pass --allow-non-linux-bake for a deliberate local bake, or use --check to detect drift without writing.');
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

// Preserve config-scoped tools from the previous bundle. Same superset rule as
// the two merges above, different cause: CC's REMOTE config decides whether it
// advertises these at all, so the same binary in the same headless mode can
// capture them one week and not the next (v2.1.232 carried TaskCreate/TaskGet/
// TaskList/TaskUpdate, v2.1.233 dropped all four while keeping TaskOutput and
// TaskStop). Dropping them shrinks CC_NATIVE_NAMES_UNION, and a client that
// still declares TaskCreate then falls into the unmapped round-robin and gets
// renamed onto a fallback slot — the v4.8.93 failure mode. Preserving is safe
// in the other direction because advertise is an intersection with the client's
// declared tools, so an entry no client declares is never sent.
const preservedConfigScopedTools = (prev.tools || []).filter(
  (t) => CONFIG_SCOPED_TOOLS.has(t.name) && !scrubbed.tools.some((s) => s.name === t.name),
);
if (preservedConfigScopedTools.length > 0) {
  log(`preserved ${preservedConfigScopedTools.length} config-scoped tool${preservedConfigScopedTools.length === 1 ? '' : 's'} from previous bundle (this capture's CC config omits them): ${preservedConfigScopedTools.map((t) => t.name).join(', ')}`);
  scrubbed.tools = [...scrubbed.tools, ...preservedConfigScopedTools].sort((a, b) => a.name.localeCompare(b.name));
}

// Refuse to bake away tools nothing classifies. Every legitimate absence has
// a set above (platform / interactive / config-scoped); a tool in the previous
// bundle that is still missing AFTER those merges is either CC genuinely
// retiring it or the preservation lists rotting (dario#1062's thesis — which
// did not reproduce on 2.1.236 or 2.1.241, but the roster is remote-config-
// shaped, so the day it happens must be loud). Baking through it silently
// shrinks CC_NATIVE_NAMES_UNION and lands declaring clients in the unmapped
// round-robin (v4.8.93). Retirement is a deliberate act: pass
// --allow-tool-drops WITH capture evidence, and remove the names from the
// preservation sets in the same change.
const bakeToolDrops = unclassifiedToolDrops(scrubbed.tools, prev.tools || [], process.platform);
if (bakeToolDrops.length > 0) {
  const msg = `capture drops ${bakeToolDrops.length} tool(s) no preservation set classifies: ${bakeToolDrops.join(', ')}`;
  if (CHECK_MODE) {
    log(`WARNING: ${msg} — a re-bake would remove them from the bundle. See dario#1062.`);
  } else if (process.argv.includes('--allow-tool-drops')) {
    log(`warning: ${msg} — proceeding because --allow-tool-drops was passed. Pair this with capture evidence and prune the preservation sets.`);
  } else {
    log(`error: ${msg}`);
    log('error: refusing to bake — this would silently shrink CC_NATIVE_NAMES_UNION (the v4.8.93 regression class).');
    log('error: if CC genuinely retired these tools, re-run with --allow-tool-drops and record the evidence.');
    process.exit(4);
  }
}

// Re-derive tool_names AFTER every preservation merge. scrubTemplate() sets it
// from `tools` (scrub-template.ts:50) and live-fingerprint does the same at
// capture time (live-fingerprint.ts:757), so `tool_names === tools.map(name)` is
// the contract everywhere. The merges above mutate `tools` afterwards and
// nothing re-synced the list, so every bake shipped an artifact whose two tool
// lists disagreed: a consumer trusting tool_names as the inventory concludes the
// preserved tools aren't in the toolset while their full definitions sit right
// there in `tools`.
//
// Observed on the shipped bundle: tool_names 30 vs tools 33 (AskUserQuestion,
// EnterPlanMode, ExitPlanMode missing), widening to 27 vs 33 on a Linux bake
// (also Glob, Grep, PowerShell) because platform preservation adds the most.
//
// Second time this exact inconsistency shipped — see the CHANGELOG entry
// "Template tool-list drift from the community tool-mapping PR", where a change
// updated `tools` without touching the parallel `tool_names`. Deriving rather
// than hand-maintaining is what stops a third.
scrubbed.tool_names = scrubbed.tools.map((t) => t.name);

log(`previous baked template: CC v${prev._version} captured ${prev._captured}, ${prev.tools.length} tools, ${prev.system_prompt.length} char system prompt`);

// ── #881 tripwire ────────────────────────────────────────────────────
// Detect-and-shout only: never strips the paragraph, never suppresses the
// drift it causes. #881 defers the bake-time normalisation call deliberately,
// so all this does is make sure a 5038 capture cannot be mistaken for a
// genuine CC prompt change by whoever reviews the resulting rebake PR.
//
// Runs in BOTH modes on purpose. In --check it explains the exit-2 that opens
// the PR; in the real bake it describes the capture the PR actually ships,
// and those can differ — the anomaly is intermittent, so a clean --check
// followed by a 5038 bake is the genuinely dangerous ordering.
const TRIPWIRE_881 = join(repoRoot, 'issue-881-tripwire.txt');
rmSync(TRIPWIRE_881, { force: true });
const residue881 = detectIssue881Residue(scrubbed.system_prompt, prev.system_prompt);
if (residue881.detected) {
  const lines = formatIssue881Warning(residue881);
  // Straight to stderr, NOT through log() — a `[bake] ` prefix would stop
  // GitHub Actions parsing line 1 as a workflow command, and the annotation
  // is the whole point. The workflow's `cat drift-output.txt` is what lands
  // it on the run summary.
  for (const line of lines) console.error(line);
  // Sibling of drift-summary.md / label-target.txt: a file the workflow can
  // test for without grepping prose, used to label the rebake PR.
  writeFileSync(TRIPWIRE_881, `${residue881.reason} ${residue881.capturedLen} ${residue881.bundledLen}\n`);
}

// ── Fable system-prompt variant (dario#lock-step) ────────────────────
// CC 2.1.198 sends Fable a larger, model-specific system prompt than the base.
// Capture it on Fable, scrub it the same way, and store the scrubbed variant so
// Fable requests carry Fable's actual CC prompt (cc-template.ts:systemPromptForModel).
// Stored ONLY when it differs from the base — otherwise runtime falls back to base.
const prevVariants = promptVariantsOf(prev);
const variants = {};
// Per-family outcome, consumed by the lock-step gate below: 'fresh'
// (captured, differs from base), 'base' (captured, matches base — the
// family legitimately has no variant), 'kept' (capture failed, previous
// bundle's variant retained), 'missing' (capture failed AND there is no
// previous variant to keep).
const variantOutcomes = {};
const capturedArmHashes = {};   // key -> sha256 of the arm THIS run captured (for the shape memory)
for (const { key, model } of VARIANT_MODELS) {
  const keepPrevious = () => {
    if (prevVariants[key]) { variants[key] = prevVariants[key]; variantOutcomes[key] = 'kept'; }
    else variantOutcomes[key] = 'missing';
  };
  try {
    const capturedVariant = await captureForModel(model, `${key}-variant`);
    if (!capturedVariant) {
      log(`warning: ${key}-variant capture failed — keeping previous variant if any.`);
      keepPrevious();
      continue;
    }
    const vScrubbed = scrubTemplate(capturedVariant);
    if (!vScrubbed.system_prompt || vScrubbed.system_prompt === scrubbed.system_prompt) {
      log(`${key}-variant matches base — no separate variant stored.`);
      variantOutcomes[key] = 'base';
      continue;
    }
    const vResidual = findUserPathHits(vScrubbed.system_prompt);
    if (vResidual.length > 0) {
      log(`warning: ${key}-variant scrub left host content — NOT storing variant: ${vResidual.slice(0, 3).join(', ')}`);
      keepPrevious();
      continue;
    }
    // A/B shape memory (dario#1095): Anthropic serves alternative prompt arms
    // for the same model at the same CC version, per request. Re-baking onto
    // whichever arm this capture's dice rolled is what produced four rebakes
    // in 25h flip-flopping fable between the SAME two byte-stable shapes. A
    // captured shape already in the known set keeps the previous canonical —
    // the bundle only moves when CC serves a shape it has never served before.
    const cls = classifyVariantShape(vScrubbed.system_prompt, prevVariants[key], (prev._variantShapeHashes ?? {})[key]);
    if (cls === 'known-alt') {
      variants[key] = prevVariants[key];
      variantOutcomes[key] = 'known-alt';
      log(`${key} system-prompt variant: captured a KNOWN A/B arm (${vScrubbed.system_prompt.length} chars) — keeping canonical (${prevVariants[key].length} chars).`);
      capturedArmHashes[key] = variantShapeHash(vScrubbed.system_prompt);
      continue;
    }
    variants[key] = vScrubbed.system_prompt;
    variantOutcomes[key] = 'fresh';
    capturedArmHashes[key] = variantShapeHash(vScrubbed.system_prompt);
    log(`${key} system-prompt variant: base ${scrubbed.system_prompt.length} → ${key} ${variants[key].length} chars`);
  } catch (e) {
    log(`warning: ${key}-variant capture error (${e.message}) — keeping previous variant if any.`);
    keepPrevious();
  }
}

// ── Lock-step gate (dario#lock-step) ─────────────────────────────────
// A family whose capture failed with no previous variant to keep must not
// ship — or diff — as if CC had retired the variant. Baked, the bundle
// would silently serve that family the BASE prompt; in --check, the
// absence would read as "N → 0 chars" variant drift and hand the watch
// workflow a rebake PR that strips it. Same philosophy as the older-CC
// guard (#635): an infra failure exits 1 loudly instead of masquerading
// as drift. A captured-and-matches-base outcome stays allowed — that is
// a measured result, and prev-had-one → variant-retired is real drift
// for --check to report.
const missingVariants = VARIANT_MODELS.map((v) => v.key).filter((k) => variantOutcomes[k] === 'missing');
if (missingVariants.length > 0) {
  if (ALLOW_MISSING_VARIANT) {
    log(`WARNING: proceeding WITHOUT a variant for: ${missingVariants.join(', ')} (--allow-missing-variant) — those families will be served the base prompt.`);
  } else {
    log(`error: variant capture failed with no previous variant to keep: ${missingVariants.join(', ')}.`);
    log('error: a bundle baked now would silently serve those families the BASE system prompt.');
    log('error: infra failure, not CC drift — fix the capture, or bypass deliberately with --allow-missing-variant.');
    process.exit(1);
  }
}
const keptVariants = VARIANT_MODELS.map((v) => v.key).filter((k) => variantOutcomes[k] === 'kept');
if (keptVariants.length > 0) {
  log(`note: carrying the previous bundle's variant for: ${keptVariants.join(', ')} — re-capture failed this run, so the kept text may lag the freshly captured base (CC v${captured._version}).`);
}
if (Object.keys(variants).length > 0) scrubbed.system_prompt_variants = variants;
// Union the shape memory: previous known arms + whatever this run captured +
// the canonical actually being baked. Sorted for stable diffs. The set only
// grows here — pruning a retired arm is a deliberate manual edit, the same
// contract as CONFIG_SCOPED_TOOLS.
{
  const memory = {};
  const keys = new Set([...Object.keys(prev._variantShapeHashes ?? {}), ...Object.keys(variants), ...Object.keys(capturedArmHashes)]);
  for (const k of keys) {
    const s = new Set((prev._variantShapeHashes ?? {})[k] ?? []);
    if (prevVariants[k]) s.add(variantShapeHash(prevVariants[k]));
    if (variants[k]) s.add(variantShapeHash(variants[k]));
    if (capturedArmHashes[k]) s.add(capturedArmHashes[k]);
    if (s.size > 0) memory[k] = [...s].sort();
  }
  if (Object.keys(memory).length > 0) scrubbed._variantShapeHashes = memory;
}

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
  const newVariants = promptVariantsOf(scrubbed);
  const variantKeys = [...new Set([...Object.keys(prevVariants), ...Object.keys(newVariants)])].sort();
  const changedKeys = variantKeys.filter((k) => (prevVariants[k] ?? '') !== (newVariants[k] ?? ''));
  // A/B shape memory (dario#1095): a capture that differs from the baked arm
  // but matches a KNOWN previously-served shape is Anthropic's per-request
  // A/B, not drift. Only a never-seen shape counts. (In --check the sticky
  // bake-path logic above has already folded known arms back to canonical, so
  // anything still differing here is either new or a retirement.)
  const knownAltDiffs = changedKeys.filter((k) =>
    (newVariants[k] ?? '') !== '' && classifyVariantShape(newVariants[k], prevVariants[k], (prev._variantShapeHashes ?? {})[k]) === 'known-alt');
  for (const k of knownAltDiffs) {
    log(`check: ${k} variant capture is a known A/B arm (${(newVariants[k] ?? '').length} chars vs baked ${(prevVariants[k] ?? '').length}) — not drift.`);
  }
  const variantDiffs = changedKeys.filter((k) => !knownAltDiffs.includes(k));
  const variantDrift = variantDiffs.length > 0;
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
    for (const k of variantDiffs) {
      log(`check: ${k} system-prompt variant drift (${(prevVariants[k] ?? '').length} → ${(newVariants[k] ?? '').length} chars).`);
    }
    if (diff.length === 0) {
      // The slot diff is empty, so the drift-detected branch above wrote no
      // summary — give the workflow embed an accurate variant-only one
      // instead of leaving the body summary-less (or, before the rmSync
      // above, stale).
      writeFileSync(summaryPath, [
        `**Verdict:** 🟡 Moderate — per-model system-prompt variant${variantDiffs.length === 1 ? '' : 's'} only`,
        '',
        ...variantDiffs.map((k) => `- **system_prompt_variants.${k}:** ${(prevVariants[k] ?? '').length} → ${(newVariants[k] ?? '').length} chars (base system prompt, tools, and anthropic_beta unchanged)`),
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
