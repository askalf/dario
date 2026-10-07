#!/usr/bin/env node
// Fixes the one wire-drift class that has a mechanical fix: Claude Code does not send, on a model
// family, a beta the opus base carries, and the rest of that family's set is Claude Code's in the
// same order. The fix is to add the flag to that family's list in src/beta-family-drops.ts, so
// dario's header for the family matches the installed Claude Code's captured set. That is all the
// candidate establishes: it must still pass the caller's re-check and unit tests, and neither
// sends a request upstream, so upstream acceptance of the narrower set is not checked here.
//
// Usage: node scripts/wire-drift-fix.mjs <wire-drift-report.json>
//   exit 0: fixed. src/beta-family-drops.ts and CHANGELOG.md are patched, wire-drift-fix.md holds
//           the PR body, and stdout is {"fixed":true,"title":...,"additions":[...]}.
//   exit 3: no mechanical fix (any other finding, a missing flag, an order change). Nothing is
//           written; stdout is {"fixed":false,"reason":...}.
//   exit 1: the report or the drops file could not be read.
// The caller rebuilds and runs scripts/check-wire-drift.mjs again; only a passing re-check is a fix.

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { appendUnreleased } from './_drift-patch-helpers.mjs';

export const DROPS_PATH = 'src/beta-family-drops.ts';
const BEGIN = '// wire-drift-fix:begin\n';
const END = '// wire-drift-fix:end';
const PREFIX = 'export const FAMILY_BETA_DROPS: Readonly<Record<string, readonly string[]>> = ';

const split = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);

/** The FAMILY_BETA_DROPS key a model's removals belong under. A Sonnet finding covers the line. */
export function familyKey(model) {
  const m = String(model).toLowerCase().replace(/\[1m\]$/, '');
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  return m.replace(/^claude-/, '');
}

/** The report JSON. check-wire-drift.mjs shares stdout with the proxy banner, so it starts at the first `{` line. */
export function parseReport(text) {
  const i = text.search(/^\{/m);
  return JSON.parse(text.slice(i < 0 ? 0 : i));
}

/** The drops object rendered exactly as it sits between the markers. */
export function renderDrops(drops) {
  return `${PREFIX}${JSON.stringify(drops, null, 2)};\n`;
}

/** The drops object from the file's text, or null when the block is missing or not in renderDrops form. */
export function parseDrops(fileText) {
  const b = fileText.indexOf(BEGIN);
  const e = fileText.indexOf(END);
  if (b < 0 || e < b) return null;
  const block = fileText.slice(b + BEGIN.length, e);
  if (!block.startsWith(PREFIX) || !block.endsWith(';\n')) return null;
  let drops;
  try {
    drops = JSON.parse(block.slice(PREFIX.length, -2));
  } catch {
    return null;
  }
  return renderDrops(drops) === block ? drops : null;
}

/** The file's text with the block between the markers replaced by `drops`. */
export function replaceDrops(fileText, drops) {
  const b = fileText.indexOf(BEGIN) + BEGIN.length;
  const e = fileText.indexOf(END);
  return fileText.slice(0, b) + renderDrops(drops) + fileText.slice(e);
}

/**
 * What to add to which family, or why there is no mechanical fix. Fixable only when every
 * high-severity finding is a beta.transform where dario's set is Claude Code's plus extra flags
 * in the same order, and each extra flag is not already listed for that family. Pure.
 */
export function planWireDriftFix(report, drops) {
  const no = (reason) => ({ fixable: false, reason, additions: [] });
  const high = (report?.findings ?? []).filter((f) => f.severity === 'high');
  if (high.length === 0) return no('the report has no high-severity finding');
  const additions = [];
  for (const f of high) {
    if (f.category !== 'beta.transform' || !f.model || typeof f.got !== 'string' || typeof f.expected !== 'string') {
      return no(`a ${f.category} finding${f.model ? ` for ${f.model}` : ''} has no mechanical fix`);
    }
    const got = split(f.got);
    const want = split(f.expected);
    const extra = got.filter((b) => !want.includes(b));
    const kept = got.filter((b) => want.includes(b));
    if (extra.length === 0 || kept.join(',') !== want.join(',')) {
      return no(`${f.model}: dario's set is not Claude Code's plus extra flags in the same order`);
    }
    const key = familyKey(f.model);
    if (extra.some((b) => (drops[key] ?? []).includes(b))) {
      return no(`${f.model}: an extra flag is already listed under "${key}", so the list does not reach this model`);
    }
    additions.push({ key, model: f.model, flags: extra });
  }
  return { fixable: true, additions };
}

/** `drops` with every addition appended to its family, each flag once. Pure. */
export function applyAdditions(drops, additions) {
  const next = Object.fromEntries(Object.entries(drops).map(([k, v]) => [k, [...v]]));
  for (const a of additions) {
    next[a.key] = next[a.key] ?? [];
    for (const flag of a.flags) if (!next[a.key].includes(flag)) next[a.key].push(flag);
  }
  return next;
}

const code = (s) => `\`${s}\``;
const list = (xs) => xs.map(code).join(', ');

/** The commit and PR title. */
export function fixTitle(additions) {
  const models = [...new Set(additions.map((a) => a.model))].join(', ');
  return `betaForModel: drop what Claude Code does not send on ${models}`;
}

/** The CHANGELOG bullet. */
export function changelogBullet(additions, ccVersion) {
  const parts = additions.map((a) => `${list(a.flags)} on ${code(a.model)}`).join('; ');
  return `- **Wire drift: dario no longer sends ${parts}.** Claude Code ${ccVersion} does not send ${additions.length === 1 && additions[0].flags.length === 1 ? 'it' : 'them'} there, while the opus base carries ${additions.length === 1 && additions[0].flags.length === 1 ? 'it' : 'them'}. Found and fixed by the wire-drift watcher.`;
}

/** The PR body, before the caller's validation section. */
export function prBody(additions, ccVersion) {
  const rows = additions.map((a) => `| ${code(a.model)} | ${code(a.key)} | ${list(a.flags)} |`).join('\n');
  return [
    `## Wire drift against Claude Code ${ccVersion}`,
    '',
    `The wire-drift watcher found dario sending beta flags that the installed Claude Code ${ccVersion} does not send on these models, with the rest of each model's set matching Claude Code's in order. The flags are added to the family's list in ${code(DROPS_PATH)}, which ${code('betaForModel')} removes from every model id that contains the key.`,
    '',
    '| model | family key | flags no longer sent |',
    '|---|---|---|',
    rows,
    '',
    `What was checked: the removed flags are absent from the installed Claude Code's captured headers for these models, the remaining flags keep Claude Code's order, and the re-check and unit tests below pass on the patched code. Those compare headers against a loopback stub; no request went upstream, so whether the API accepts the narrower set for every request body and account is not checked here. This PR was opened by the watcher, from a trusted scheduled run.`,
  ].join('\n');
}

function main(argv) {
  const reportPath = argv[2];
  if (!reportPath) {
    console.error('usage: node scripts/wire-drift-fix.mjs <wire-drift-report.json>');
    return 1;
  }
  let report, fileText, drops;
  try {
    report = parseReport(readFileSync(reportPath, 'utf8'));
    fileText = readFileSync(DROPS_PATH, 'utf8');
  } catch (e) {
    console.error(`wire-drift-fix: ${e.message}`);
    return 1;
  }
  drops = parseDrops(fileText);
  if (!drops) {
    console.error(`wire-drift-fix: ${DROPS_PATH} has no drops block in the form this script writes`);
    return 1;
  }
  const plan = planWireDriftFix(report, drops);
  if (!plan.fixable) {
    console.log(JSON.stringify({ fixed: false, reason: plan.reason }));
    return 3;
  }
  const ccVersion = report.ccVersion || 'unknown';
  writeFileSync(DROPS_PATH, replaceDrops(fileText, applyAdditions(drops, plan.additions)));
  writeFileSync('CHANGELOG.md', appendUnreleased(readFileSync('CHANGELOG.md', 'utf8'), changelogBullet(plan.additions, ccVersion)));
  writeFileSync('wire-drift-fix.md', `${prBody(plan.additions, ccVersion)}\n`);
  console.log(JSON.stringify({ fixed: true, title: fixTitle(plan.additions), ccVersion, additions: plan.additions }));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv));
}
