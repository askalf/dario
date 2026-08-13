#!/usr/bin/env node
// Resolve the ONE conflict shape our release automation produces.
//
// Two bot PRs drafted off the same release both add a section under
// `## [Unreleased]` and both bump `package.json`, so merging master into
// either one conflicts in exactly two files, in exactly two ways. Every such
// conflict resolves the same way, and getting it wrong has a specific cost:
// a version below an already-published tag makes cc-drift-auto-release's
// duplicate-tag guard fast-exit green having shipped nothing.
//
// That is a rule, not a judgement, so it lives here rather than in a prompt.
//
//   package.json  keep the HIGHER version. Never downward.
//   CHANGELOG.md  keep BOTH sides. Version sections descending, newest first;
//                 loose text (bullets under `## [Unreleased]`) stays on top.
//
// REFUSES anything outside that shape — a conflict in another file, a
// package.json conflict touching more than the version line, a version that
// is not X.Y.Z. Refusing costs a hand-resolution; guessing costs a silent
// no-op release.
//
// Usage:
//   node scripts/resolve-release-conflicts.mjs [file...]   # default: both
// Exit 0 = every conflict resolved (or none present), files rewritten.
// Exit 1 = refused; the working tree is left exactly as it was found.

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const START = /^<{7} .*$/;
const MID = /^={7}$/;
const END = /^>{7} .*$/;

// CRLF is not cosmetic here. A git checkout on Windows leaves markers as
// "<<<<<<< HEAD\r", and in JavaScript `.` will not consume a carriage return
// while `$` (no `m` flag) will not match before one — so every regex above
// silently fails and the file reads as conflict-free. That is the worst
// possible failure mode for this script: reporting success while leaving
// markers in package.json. Normalize on the way in and restore on the way
// out, so the file keeps whatever convention it already had.
const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const toLf = (text) => text.replace(/\r\n/g, '\n');
const restoreEol = (text, eol) => (eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

/** Parse "1.2.3" into comparable parts. Returns null when not X.Y.Z. */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec((v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Semver compare. Numeric per component, so 5.5.99 < 5.6.0. */
export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`not a X.Y.Z version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Split text into conflict regions and the plain text between them.
 * Returns [{ before, ours, theirs }..., { before }] — the last entry is the
 * tail after the final conflict.
 */
function splitConflicts(text) {
  const lines = text.split('\n');
  const out = [];
  let before = [], ours = null, theirs = null, mode = 'before';

  for (const line of lines) {
    if (mode === 'before' && START.test(line)) { ours = []; mode = 'ours'; continue; }
    if (mode === 'ours' && MID.test(line)) { theirs = []; mode = 'theirs'; continue; }
    if (mode === 'theirs' && END.test(line)) {
      out.push({ before: before.join('\n'), ours: ours.join('\n'), theirs: theirs.join('\n') });
      before = []; ours = null; theirs = null; mode = 'before';
      continue;
    }
    if (mode === 'before') before.push(line);
    else if (mode === 'ours') ours.push(line);
    else theirs.push(line);
  }
  if (mode !== 'before') throw new Error('unterminated conflict marker');
  out.push({ before: before.join('\n') });
  return out;
}

export function hasConflicts(text) {
  return toLf(text).split('\n').some((l) => START.test(l));
}

// ── package.json ───────────────────────────────────────────────────────────

/** The only package.json conflict we accept: the version line, both sides. */
function versionFromSide(side) {
  const lines = side.split('\n').filter((l) => l.trim() !== '');
  if (lines.length !== 1) return null;
  const m = /^\s*"version"\s*:\s*"([^"]+)"\s*,?\s*$/.exec(lines[0]);
  return m ? { version: m[1], line: lines[0] } : null;
}

export function resolvePackageJson(text) {
  if (!hasConflicts(text)) return text;
  const eol = detectEol(text);
  const parts = splitConflicts(toLf(text));
  let out = '';
  for (const p of parts) {
    out += p.before;
    if (p.ours === undefined) continue;
    const a = versionFromSide(p.ours);
    const b = versionFromSide(p.theirs);
    if (!a || !b) {
      throw new Error('package.json conflict is not a lone "version" line on both sides');
    }
    // Keep the higher version, and keep the LINE from that side so its
    // indentation and trailing comma survive untouched.
    const winner = compareVersions(a.version, b.version) >= 0 ? a : b;
    out += '\n' + winner.line + '\n';
  }
  return restoreEol(out, eol);
}

// ── CHANGELOG.md ───────────────────────────────────────────────────────────

const SECTION = /^## \[([^\]]+)\]/;

/**
 * Split a chunk into { loose, sections } where `loose` is text before the
 * first `## [` heading (bullets that belong under `## [Unreleased]`, which
 * sits above the conflict region) and `sections` is one entry per version.
 */
function splitSections(chunk) {
  const lines = chunk.split('\n');
  const loose = [];
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = SECTION.exec(line);
    if (m) {
      cur = { key: m[1], lines: [line] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    } else {
      loose.push(line);
    }
  }
  return { loose: loose.join('\n'), sections };
}

const trimBlank = (s) => s.replace(/^\n+/, '').replace(/\n+$/, '');

export function resolveChangelog(text) {
  if (!hasConflicts(text)) return text;
  const eol = detectEol(text);
  const parts = splitConflicts(toLf(text));
  let out = '';

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    out += p.before;
    if (p.ours === undefined) continue;

    const A = splitSections(p.ours);
    const B = splitSections(p.theirs);

    // Git does not always put every unreleased bullet INSIDE the region. When
    // only one side gained a bullet, the other's can land after the `>>>>>>>`
    // line, before the next `## [` heading. Emitting the merged version
    // sections first would then bury it inside the newest released section —
    // observed live, an `## [Unreleased]` entry ending up under `## [5.5.13]`.
    // Loose text directly after the region belongs to whichever section was
    // open before it, which for these conflicts is Unreleased.
    let hoisted = '';
    const next = parts[i + 1];
    if (next) {
      const tail = splitSections(next.before);
      if (trimBlank(tail.loose)) {
        hoisted = trimBlank(tail.loose);
        next.before = next.before.slice(tail.loose.length);
      }
    }

    // Loose text from both sides, in order, de-duplicated. This is where an
    // `## [Unreleased]` bullet lives, and dropping one loses a real entry.
    const looseParts = [A.loose, B.loose, hoisted].map(trimBlank).filter(Boolean);
    const loose = [...new Set(looseParts)].join('\n\n');

    // Union the version sections. Identical versions on both sides collapse;
    // when they differ in content, ours wins (it is the PR's own text).
    const byVersion = new Map();
    for (const s of [...B.sections, ...A.sections]) {
      byVersion.set(s.key, trimBlank(s.lines.join('\n')));
    }

    const ordered = [...byVersion.entries()].sort((x, y) => {
      const vx = parseVersion(x[0]), vy = parseVersion(y[0]);
      if (vx && vy) return -compareVersions(x[0], y[0]);   // newest first
      if (vx) return 1;                                     // non-versions
      if (vy) return -1;                                    // (Unreleased) on top
      return 0;
    });

    const blocks = [];
    if (loose) blocks.push(loose);
    for (const [, body] of ordered) blocks.push(body);
    out += '\n' + blocks.join('\n\n') + '\n';
  }
  return restoreEol(out, eol);
}

// ── CLI ────────────────────────────────────────────────────────────────────

const HANDLERS = {
  'package.json': resolvePackageJson,
  'CHANGELOG.md': resolveChangelog,
};

function main(argv) {
  const targets = argv.length ? argv : Object.keys(HANDLERS);
  const writes = [];

  for (const file of targets) {
    const handler = HANDLERS[file];
    if (!handler) {
      console.error(`refusing: no resolver for ${file} — resolve by hand`);
      return 1;
    }
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    if (!hasConflicts(before)) { console.log(`${file}: no conflict`); continue; }
    let after;
    try {
      after = handler(before);
    } catch (e) {
      console.error(`refusing: ${file} — ${e.message}`);
      return 1;
    }
    if (hasConflicts(after)) {
      console.error(`refusing: ${file} — markers survived resolution`);
      return 1;
    }
    writes.push([file, after]);
    console.log(`${file}: resolved`);
  }

  // Write only after EVERY file resolved cleanly, so a refusal leaves the
  // tree exactly as it was found rather than half-applied.
  for (const [file, content] of writes) writeFileSync(file, content);
  return 0;
}

// Exact path identity, not a basename match: test/resolve-release-conflicts.mjs
// shares this file's basename, and a suffix check made `import` run the CLI.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) process.exit(main(process.argv.slice(2)));
