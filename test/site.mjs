#!/usr/bin/env node
// The landing page at askalf.github.io/dario (site/index.html), checked the
// way check-readme-links.mjs checks the README: every relative link and image
// resolves to a file the Pages build ships next to it, every link into this
// repo on GitHub points at a file that exists, every in-page anchor has its
// target, nothing loads from a third party, the page carries the metadata a
// share or a search result reads, and drift-feed.yml ships the pieces.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToolsDoc } from '../scripts/site-tools.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'drift-feed.yml'), 'utf8');
// The per-tool pages the same job generates from docs/tools.md (test/site-tools.mjs checks them).
const toolSlugs = new Set(parseToolsDoc(readFileSync(join(ROOT, 'docs', 'tools.md'), 'utf8')).tools.map((t) => t.slug));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 600) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const SITE = 'https://askalf.github.io/dario/';
const REPO_BLOB = 'https://github.com/askalf/dario/blob/master/';
const REPO_TREE = 'https://github.com/askalf/dario/tree/master/';

// What the Pages job puts next to index.html (see drift-feed.yml).
const shipped = (p) => {
  if (p === '' || p === './' || p === 'index.html') return true;
  if (p === 'drift-feed/' || p.startsWith('drift-feed/')) return true; // built by scripts/drift-feed.mjs in the same job
  if (p === 'tools/') return true;
  if (p.startsWith('tools/')) return /^tools\/([a-z0-9-]+)\/$/.test(p) && toolSlugs.has(p.slice(6, -1));
  if (p.startsWith('art/')) return existsSync(join(ROOT, '.github', 'readme', p.slice('art/'.length)));
  if (p.startsWith('fonts/')) return existsSync(join(ROOT, 'scripts', 'readme', 'fonts', p.slice('fonts/'.length)));
  return existsSync(join(ROOT, 'site', p));
};

// Links and images by attribute; a meta `content` counts only when it is a URL on the site (og:image, canonical).
const attrs = [
  ...[...html.matchAll(/\b(?:href|src|data-dark|data-light)="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/\bcontent="(https:\/\/askalf\.github\.io\/dario\/[^"]*)"/g)].map((m) => m[1]),
];
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

header('links and images');
{
  const broken = [];
  const anchors = [];
  for (const raw of attrs) {
    const [target, anchor] = raw.split('#');
    if (raw.startsWith('#')) { if (!ids.has(anchor)) anchors.push(raw); continue; }
    if (target.startsWith(SITE)) { if (!shipped(target.slice(SITE.length))) broken.push(raw); continue; }
    if (target.startsWith(REPO_BLOB) || target.startsWith(REPO_TREE)) {
      const rel = target.slice((target.startsWith(REPO_BLOB) ? REPO_BLOB : REPO_TREE).length);
      if (!existsSync(join(ROOT, rel))) broken.push(raw);
      continue;
    }
    if (/^(https?:|mailto:)/.test(target)) continue;
    if (!/^[\w./-]+$/.test(target) || target.includes(' ')) continue; // a meta content value, not a path
    if (!shipped(target)) broken.push(raw);
  }
  check('every relative link and image resolves to something the Pages job ships', broken.length === 0, broken.join(', '));
  check('every in-page anchor has its target', anchors.length === 0, anchors.join(', '));
  check('every link into this repo points at a file that exists', !broken.some((b) => b.startsWith('https://github.com/')), broken.filter((b) => b.startsWith('https://github.com/')).join(', '));
  check('the drift feed is linked from the page', html.includes('href="drift-feed/"'));
}

header('nothing from a third party');
{
  check('no external script', !/<script[^>]*\ssrc=/.test(html));
  const loads = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]).filter((l) => /rel="(?:stylesheet|preconnect|preload|modulepreload)"/.test(l));
  check('no external stylesheet or font', !loads.some((l) => /href="https?:/.test(l)) && !/@import/.test(html) && !/fonts\.g/.test(html), loads.join(' | '));
  check('the brand font is the one shipped with the README art', /url\(fonts\/SpaceMono-400-latin\.woff2\)/.test(html) && existsSync(join(ROOT, 'scripts', 'readme', 'fonts', 'SpaceMono-400-latin.woff2')));
  check('no third-party image', ![...html.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].some((m) => /^https?:/.test(m[1])));
}

header('what a share or a search result reads');
{
  check('title, description, canonical', /<title>[^<]{10,}<\/title>/.test(html) && /name="description" content="[^"]{40,}"/.test(html) && html.includes(`rel="canonical" href="${SITE}"`));
  check('open graph with an image the job ships', html.includes('property="og:title"') && html.includes('property="og:description"') && /property="og:image" content="https:\/\/askalf\.github\.io\/dario\/art\/[\w.-]+"/.test(html));
  check('one h1', (html.match(/<h1[\s>]/g) || []).length === 1);
  check('images carry alt text', [...html.matchAll(/<img\b[^>]*>/g)].every((m) => /\salt="[^"]+"/.test(m[0])));
  const dash = [0x2013, 0x2014].some((c) => html.includes(String.fromCharCode(c)));
  check('no em or en dash (public-text)', !dash);
}

header('the Pages job ships the page, the art and the fonts');
{
  check('drift-feed.yml copies site/, the README art and the fonts into the artifact', /cp -r site\/\. dist-feed\//.test(workflow) && /\.github\/readme\/\*\.(?:jpg|png|\{jpg,png\}) dist-feed\/art\//.test(workflow) && /scripts\/readme\/fonts\/\*\.woff2 dist-feed\/fonts\//.test(workflow), workflow.split('\n').filter((l) => l.includes('dist-feed')).join(' | '));
  check('drift-feed.yml runs when the page, the art or the fonts change', /-\s+site\/\*\*/.test(workflow) && /-\s+\.github\/readme\/\*\*/.test(workflow) && /-\s+scripts\/readme\/fonts\/\*\*/.test(workflow));
  check('the redirect stub is gone: index.html is the page', !workflow.includes('http-equiv="refresh"'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
