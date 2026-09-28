#!/usr/bin/env node
// Move everything pending under `## [Unreleased]` into the release it ships in.
//
// WHY THIS EXISTS. A version bump on master is the release, and the GitHub
// Release body is that version's CHANGELOG section (extract-release-notes).
// A bullet still under `## [Unreleased]` when the bump merges ships its code
// in that release and its note in none: the next bump promotes it into a
// release that did not carry the change. It happens whenever a contribution
// merges while a release PR is open — merging master back into the release
// branch keeps the new bullet under Unreleased (resolve-release-conflicts
// keeps loose text on top by design) — and on a hand-made bump that adds its
// heading below Unreleased instead of promoting it (dario#1450). CI fails
// such a PR (check-changelog.mjs); this is the one-command fix, and
// drift-pr-heal runs it after merging master into a bot release PR.
//
// Rule: the first release heading below `## [Unreleased]` is the release in
// flight. Unreleased's text is folded into it, subsection by subsection: a
// bullet under `### Fixed` joins that release's `### Fixed` (created when
// missing), loose text goes to the top of the section. Unreleased is left
// empty. Nothing is reworded, reordered within a subsection, or dropped.
//
// Usage:
//   node scripts/fold-unreleased.mjs [CHANGELOG.md]
// Exit 0 = folded or nothing to fold (file rewritten only when it changed).
// Exit 1 = no `## [Unreleased]` or no release heading below it.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const UNRELEASED = /^## \[Unreleased\]\s*$/;
const H2 = /^## /;
const H3 = /^### /;

/** Split section body lines into loose lines plus ordered `### ` subsections. */
function parseBody(lines) {
  const loose = [];
  const subs = [];
  let cur = null;
  for (const line of lines) {
    if (H3.test(line)) { cur = { heading: line.trim(), lines: [] }; subs.push(cur); continue; }
    (cur ? cur.lines : loose).push(line);
  }
  return { loose, subs };
}

const trimBlank = (lines) => {
  let a = 0, b = lines.length;
  while (a < b && lines[a].trim() === '') a++;
  while (b > a && lines[b - 1].trim() === '') b--;
  return lines.slice(a, b);
};

function renderBody({ loose, subs }) {
  const out = [];
  const l = trimBlank(loose);
  if (l.length) out.push('', ...l);
  for (const s of subs) {
    const body = trimBlank(s.lines);
    out.push('', s.heading);
    if (body.length) out.push('', ...body);
  }
  out.push('');
  return out;
}

/**
 * @returns {{ text: string, moved: number, release: string | null }}
 *   `moved` counts the non-blank lines folded; `release` is the heading they
 *   went under (null when there was nothing to fold into).
 */
export function foldUnreleased(changelog) {
  const eol = changelog.includes('\r\n') ? '\r\n' : '\n';
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const u = lines.findIndex((l) => UNRELEASED.test(l));
  if (u === -1) return { text: changelog, moved: 0, release: null };
  let r = u + 1;
  while (r < lines.length && !H2.test(lines[r])) r++;
  if (r >= lines.length) return { text: changelog, moved: 0, release: null };
  let end = r + 1;
  while (end < lines.length && !H2.test(lines[end])) end++;

  const pending = parseBody(lines.slice(u + 1, r));
  const moved = [...pending.loose, ...pending.subs.flatMap((s) => [s.heading, ...s.lines])]
    .filter((l) => l.trim() !== '').length;
  const release = lines[r].trim();
  if (moved === 0) return { text: changelog, moved: 0, release };

  const target = parseBody(lines.slice(r + 1, end));
  const pendingLoose = trimBlank(pending.loose);
  const merged = {
    loose: pendingLoose.length ? [...pendingLoose, '', ...trimBlank(target.loose)] : target.loose,
    subs: target.subs.map((s) => ({ ...s, lines: [...s.lines] })),
  };
  for (const s of pending.subs) {
    const body = trimBlank(s.lines);
    const same = merged.subs.find((t) => t.heading === s.heading);
    if (same) same.lines = [...body, ...trimBlank(same.lines)];
    else merged.subs.unshift({ heading: s.heading, lines: body });
  }

  const out = [...lines.slice(0, u + 1), '', lines[r], ...renderBody(merged), ...lines.slice(end)];
  return { text: out.join('\n').replace(/\n/g, eol), moved, release };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] ?? 'CHANGELOG.md';
  const before = readFileSync(path, 'utf-8');
  const { text, moved, release } = foldUnreleased(before);
  if (release === null) {
    console.error(`fold-unreleased: ${path} has no \`## [Unreleased]\` with a release heading below it — nothing to fold into.`);
    process.exit(1);
  }
  if (moved === 0) {
    console.log(`fold-unreleased: \`## [Unreleased]\` is already empty — ${release} unchanged.`);
  } else {
    writeFileSync(path, text, 'utf-8');
    console.log(`fold-unreleased: moved ${moved} line(s) from \`## [Unreleased]\` into ${release}.`);
  }
}
