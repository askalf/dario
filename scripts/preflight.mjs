#!/usr/bin/env node
/**
 * preflight — the artifact-level checks a green `npm test` cannot make.
 *
 * WHY THIS EXISTS. On 2026-08-25 four version-bumping PRs were in flight at
 * once, so every merge invalidated the others on the same two files and each
 * one had to be hand-resolved. Three separate defects came out of that hand
 * work, and NONE of them could fail a unit test:
 *
 *   1. `package-lock.json` was committed with unresolved `<<<<<<<` markers —
 *      invalid JSON. `npm test` passed anyway because `node_modules` was
 *      already installed, so nothing ever parsed the lockfile. `npm ci` would
 *      have died on it.
 *   2. A CHANGELOG entry was inserted INSIDE the release-convention HTML
 *      comment (a script anchored on the first `## [`, which is the
 *      `## [X.Y.Z]` placeholder in that comment) — so the entry never
 *      rendered and the real heading was corrupted.
 *   3. Version fields drifted between package.json, the lockfile's two
 *      version slots, and the CHANGELOG's top heading.
 *
 * Every one is a five-second mechanical check. That is what this is.
 *
 * Usage:  node scripts/preflight.mjs [--fix-hint]
 * Exit 0 = clean, 1 = at least one finding (each printed with its file).
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
let findings = 0;
const fail = (file, msg) => { console.error(`  ✗ ${file}: ${msg}`); findings++; };
const ok = (msg) => console.log(`  ✓ ${msg}`);

/** Tracked files, via git — never walks node_modules or untracked scratch. */
function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

// ── 1. No unresolved merge-conflict markers ─────────────────────────────────
// Anchored at line start so prose that merely QUOTES a marker does not trip it
// — CHANGELOG.md legitimately documents Cline's `<<<<<<< SEARCH` diff fence,
// and a checker that cried wolf on its own changelog would be turned off.
{
  const marker = /^(<{7} |={7}$|>{7} )/m;
  const skip = /\.(png|jpg|jpeg|gif|ico|pdf|woff2?|zip|gz|mid)$/i;
  let hits = 0;
  for (const f of trackedFiles()) {
    if (skip.test(f)) continue;
    const p = join(repoRoot, f);
    if (!existsSync(p)) continue;
    let text;
    try { text = readFileSync(p, 'utf8'); } catch { continue; }
    // A file may hold marker-shaped text on purpose — the resolver's own test
    // fixtures ARE conflicts. Opting out is explicit and greppable rather than
    // a path allowlist that silently grows.
    if (text.includes('preflight:allow-conflict-markers')) continue;
    if (marker.test(text)) {
      const line = text.split('\n').findIndex((l) => /^(<{7} |={7}$|>{7} )/.test(l)) + 1;
      fail(f, `unresolved merge-conflict marker at line ${line}`);
      hits++;
    }
  }
  if (hits === 0) ok('no merge-conflict markers in tracked files');
}

// ── 2. Every tracked .json parses ───────────────────────────────────────────
// The lockfile check that `npm test` skips when node_modules is warm.
{
  let bad = 0;
  for (const f of trackedFiles()) {
    if (!f.endsWith('.json')) continue;
    const p = join(repoRoot, f);
    if (!existsSync(p)) continue;
    try { JSON.parse(readFileSync(p, 'utf8')); }
    catch (e) { fail(f, `invalid JSON — ${String(e.message).slice(0, 90)}`); bad++; }
  }
  if (bad === 0) ok('every tracked .json parses');
}

// ── 3. Version agreement: package.json ↔ lockfile (both slots) ──────────────
let pkgVersion = null;
{
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    pkgVersion = pkg.version;
    const lockPath = join(repoRoot, 'package-lock.json');
    if (existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      const rootV = lock.version;
      const selfV = lock.packages?.['']?.version;
      if (rootV !== pkgVersion) fail('package-lock.json', `version ${rootV} ≠ package.json ${pkgVersion}`);
      else if (selfV !== pkgVersion) fail('package-lock.json', `packages[""].version ${selfV} ≠ package.json ${pkgVersion}`);
      else ok(`version agrees across package.json + lockfile (${pkgVersion})`);
    }
  } catch (e) {
    fail('package.json', `could not compare versions — ${String(e.message).slice(0, 80)}`);
  }
}

// ── 4. CHANGELOG's top release heading is real and matches the version ──────
// Strips HTML comments FIRST. The release-convention comment contains a
// literal `## [X.Y.Z] - YYYY-MM-DD` placeholder, and treating that as the top
// heading is exactly how an entry ended up buried inside the comment.
{
  const p = join(repoRoot, 'CHANGELOG.md');
  if (existsSync(p) && pkgVersion) {
    const raw = readFileSync(p, 'utf8');
    const stripped = raw.replace(/<!--[\s\S]*?-->/g, '');
    const heads = [...stripped.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
    const firstRelease = heads.find((h) => h !== 'Unreleased');
    if (!firstRelease) {
      fail('CHANGELOG.md', 'no release heading found outside the template comment');
    } else if (firstRelease !== pkgVersion) {
      fail('CHANGELOG.md', `top release heading [${firstRelease}] ≠ package.json ${pkgVersion}`);
    } else {
      ok(`CHANGELOG top heading matches the version ([${firstRelease}])`);
    }
    // The defect itself: a REAL release entry sitting inside the HTML comment.
    // Stripping comments (which the heading check above must do) is precisely
    // what blinds you to it — the buried entry vanishes from the parse and the
    // placeholder is still there, so every other check reads clean. So look
    // inside the comments explicitly for a heading carrying a real version;
    // `## [X.Y.Z]` and `## [Unreleased]` belong there, a semver never does.
    for (const c of raw.match(/<!--[\s\S]*?-->/g) || []) {
      const buried = [...c.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
      if (buried.length) {
        fail('CHANGELOG.md', `release heading(s) [${buried.join('], [')}] are INSIDE an HTML comment — the entry will not render; an inserter anchored on the \`## [X.Y.Z]\` placeholder instead of the first real heading`);
      }
    }
    // The placeholder must survive intact — if it is gone, something wrote
    // over the comment.
    if (!/## \[X\.Y\.Z\] - YYYY-MM-DD/.test(raw)) {
      fail('CHANGELOG.md', 'the release-convention placeholder `## [X.Y.Z] - YYYY-MM-DD` is missing — an edit likely overwrote the header comment');
    }
    // Duplicate release headings mean two entries claimed one version.
    const rel = heads.filter((h) => h !== 'Unreleased');
    const dupes = rel.filter((h, i) => rel.indexOf(h) !== i);
    if (dupes.length) fail('CHANGELOG.md', `duplicate release heading(s): ${[...new Set(dupes)].join(', ')}`);
  }
}

console.log('');
if (findings > 0) {
  console.error(`preflight: ${findings} finding${findings === 1 ? '' : 's'} — fix before pushing.`);
  process.exit(1);
}
console.log('preflight: clean.');
