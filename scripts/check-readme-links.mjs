#!/usr/bin/env node
// Every relative link, image and anchor in README.md must resolve.
//
// The line-count guard (check-readme-line-count.mjs) exists because a claim
// nobody re-measures drifts. Links drift the same way: a doc gets renamed, a
// heading gets reworded, and the README keeps pointing at the old name — the
// reader gets a 404 or a page that scrolls to the top, and nobody notices
// because nobody clicks every link on every PR. This does, on every PR.
//
// Checks, with no network access:
//   - relative file targets exist (links, <img src>, <picture><source srcset>)
//   - #fragments resolve to a heading (GitHub's slug rules) or an explicit
//     <a id="…"> / <a name="…"> in the target file, README included
//   - mailto: / http(s): targets are left alone (external reachability is not
//     a property of this repo)
//
// Usage: node scripts/check-readme-links.mjs [README.md ...]

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const files = process.argv.slice(2).length ? process.argv.slice(2) : ['README.md'];
let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL: ${msg}`); };

/** GitHub-style heading slug: lowercase, drop punctuation, spaces → hyphens; duplicates get -1, -2 … */
function slugify(text) {
  // Inline HTML in a heading (<kbd>, <code>…) does not reach the slug, so drop
  // the tags. Looping until nothing changes handles nested/split tags; this is
  // slug derivation for comparison, not sanitization of anything rendered.
  let s = text.toLowerCase();
  for (let prev = null; prev !== s; ) { prev = s; s = s.replace(/<[^>]*>/g, ''); }
  return s
    .replace(/[`*_~]/g, '')             // markdown emphasis / code
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
    .replace(/[^\p{L}\p{N}\s-]/gu, '')  // punctuation and emoji
    .trim()
    .replace(/\s/g, '-');
}
function anchorsOf(path) {
  const src = readFileSync(path, 'utf8');
  const seen = new Map(); const out = new Set();
  let inFence = false;
  for (const line of src.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) {
      const base = slugify(m[1]);
      const n = seen.get(base) ?? 0; seen.set(base, n + 1);
      out.add(n === 0 ? base : `${base}-${n}`);
    }
  }
  for (const m of src.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1]);
  return out;
}

const anchorCache = new Map();
const anchors = (p) => { if (!anchorCache.has(p)) anchorCache.set(p, anchorsOf(p)); return anchorCache.get(p); };

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const base = dirname(resolve(file));
  const targets = [];
  let inFence = false;
  src.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    // inline links and images: [text](target "title"), ![alt](target)
    for (const m of line.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) targets.push({ t: m[1], line: i + 1 });
    // reference definitions: [label]: target "title" — the target for every
    // [text][label] / ![alt][label] use, so checking the definition covers them.
    // A footnote definition ([^label]: prose) is not a link.
    for (const m of line.matchAll(/^\s{0,3}\[(?!\^)[^\]]+\]:\s*<?([^\s>]+)>?(?:\s+.*)?$/g)) targets.push({ t: m[1], line: i + 1 });
    // raw html: <a href>, <img src>, <source srcset>
    for (const m of line.matchAll(/\b(?:href|src|srcset)="([^"]+)"/g)) targets.push({ t: m[1], line: i + 1 });
  });
  let checked = 0;
  for (const { t, line } of targets) {
    if (/^(https?:|mailto:|data:)/i.test(t)) continue;
    checked++;
    const [pathPart, frag] = t.split('#');
    let target = file;
    if (pathPart) {
      const p = resolve(base, decodeURIComponent(pathPart));
      if (!existsSync(p)) { fail(`${file}:${line} → ${t} (file not found)`); continue; }
      if (statSync(p).isDirectory()) { if (frag) fail(`${file}:${line} → ${t} (fragment on a directory)`); continue; }
      target = p;
    }
    if (frag !== undefined) {
      if (!/\.md$/i.test(target)) { fail(`${file}:${line} → ${t} (fragment on a non-markdown file)`); continue; }
      if (!anchors(target).has(frag)) fail(`${file}:${line} → ${t} (no heading or anchor "#${frag}" in ${target === file ? 'this file' : pathPart})`);
    }
  }
  console.log(`${failures ? 'checked' : 'ok '} ${file}: ${checked} relative link${checked === 1 ? '' : 's'}/anchors checked`);
}
process.exit(failures ? 1 : 0);
