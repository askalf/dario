#!/usr/bin/env node
// scripts/site-sitemap.mjs: which files of the Pages artifact are pages, the
// URL each is served at, and the XML. Then the script itself, run on a small
// site in a temporary directory, and the workflow that runs it last.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlFiles, pageUrl, sitemapXml } from '../scripts/site-sitemap.mjs';
import { buildSite } from '../scripts/site-tools.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://askalf.github.io/dario';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 600) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

header('the URL a file is served at');
{
  check('the root index is the site root, with its slash', pageUrl('index.html', SITE) === `${SITE}/`);
  check('a directory index is the directory, with its slash', pageUrl('tools/cursor/index.html', SITE) === `${SITE}/tools/cursor/` && pageUrl('drift-feed/index.html', SITE) === `${SITE}/drift-feed/`);
  check('any other page keeps its file name', pageUrl('drift-feed/archive.html', SITE) === `${SITE}/drift-feed/archive.html`);
  check('a site given with a trailing slash yields the same URLs', pageUrl('tools/index.html', `${SITE}/`) === `${SITE}/tools/`);
  check('a path segment is percent-encoded', pageUrl('a b/index.html', SITE) === `${SITE}/a%20b/`);
  check("GitHub's error page is not a page", pageUrl('404.html', SITE) === null);
  check('a search engine ownership file is not a page', pageUrl('google1a2b3c4d5e6f7a8b.html', SITE) === null && pageUrl('yandex_0123456789abcdef.html', SITE) === null);
  check('a page that only starts like one is', pageUrl('google-setup.html', SITE) === `${SITE}/google-setup.html`);
}

header('the XML');
{
  const body = sitemapXml(['tools/zed/index.html', 'index.html', '404.html', 'tools/index.html', 'tools/zed/index.html'], SITE);
  const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  check('declares itself and the sitemap namespace', body.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n') && body.endsWith('</urlset>\n'));
  check('one entry per page, the site root first, a repeat and a non-page dropped', JSON.stringify(locs) === JSON.stringify([`${SITE}/`, `${SITE}/tools/`, `${SITE}/tools/zed/`]), locs.join(' '));
  check('the order does not depend on the order the files were found in', sitemapXml(['index.html', 'tools/index.html', 'tools/zed/index.html'], SITE) === body);
  check('a character XML reserves is escaped', sitemapXml(['index.html'], 'https://example.test/a&b').includes('<loc>https://example.test/a&amp;b/</loc>'));
  check('no entries is still a well-formed sitemap', /<urlset[^>]*>\n\n<\/urlset>\n$/.test(sitemapXml([], SITE)));
}

header('the script, on a site in a temporary directory');
{
  const dir = mkdtempSync(join(tmpdir(), 'dario-sitemap-'));
  try {
    const { pages } = buildSite({
      toolsMd: readFileSync(join(ROOT, 'docs', 'tools.md'), 'utf8'),
      landingHtml: readFileSync(join(ROOT, 'site', 'index.html'), 'utf8'),
      site: SITE,
    });
    const put = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
    put('index.html', readFileSync(join(ROOT, 'site', 'index.html'), 'utf8'));
    for (const [path, html] of pages) put(path, html);
    put('drift-feed/index.html', '<!doctype html><title>feed</title>');
    put('drift-feed/feed.xml', '<rss/>');
    put('art/social.jpg', 'not a page');
    put('404.html', '<!doctype html>');
    put('.nojekyll', '');

    const found = htmlFiles(dir);
    check('finds the HTML files at every depth and nothing else', found.includes('index.html') && found.includes('tools/cursor/index.html') && found.includes('drift-feed/index.html') && found.includes('404.html') && found.every((f) => f.endsWith('.html')) && !found.some((f) => f.includes('\\')), found.slice(0, 6).join(' '));

    const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'site-sitemap.mjs'), '--dir', dir, '--site', SITE], { encoding: 'utf8' });
    check('exits 0 and says how many pages it listed', run.status === 0 && new RegExp(`site-sitemap: ${pages.size + 2} pages in `).test(run.stdout), run.stdout + run.stderr);
    const written = readFileSync(join(dir, 'sitemap.xml'), 'utf8');
    const locs = [...written.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    check('lists the landing page, the feed, the tools index and every tool page', locs.includes(`${SITE}/`) && locs.includes(`${SITE}/drift-feed/`) && [...pages.keys()].every((p) => locs.includes(`${SITE}/${p.replace(/index\.html$/, '')}`)), locs.join(' '));
    check('and nothing that is not a page', locs.length === pages.size + 2 && !locs.some((l) => /404|feed\.xml|social|nojekyll/.test(l)));
    // A page names itself in rel="canonical"; a sitemap that named it differently would list a URL the page disowns.
    const canonicals = [...pages.values()].map((html) => /rel="canonical" href="([^"]+)"/.exec(html)[1]);
    check('every tool page is listed under the URL it calls canonical', canonicals.every((c) => locs.includes(c)), canonicals.filter((c) => !locs.includes(c)).join(' '));
    const landingCanonical = /rel="canonical" href="([^"]+)"/.exec(readFileSync(join(ROOT, 'site', 'index.html'), 'utf8'))[1];
    check('and so is the landing page', locs.includes(landingCanonical), landingCanonical);
    const again = spawnSync(process.execPath, [join(ROOT, 'scripts', 'site-sitemap.mjs'), '--dir', dir, '--site', SITE], { encoding: 'utf8' });
    check('a second run writes the same file: the sitemap does not list itself', again.status === 0 && readFileSync(join(dir, 'sitemap.xml'), 'utf8') === written);

    const empty = mkdtempSync(join(tmpdir(), 'dario-sitemap-empty-'));
    try {
      const none = spawnSync(process.execPath, [join(ROOT, 'scripts', 'site-sitemap.mjs'), '--dir', empty, '--site', SITE], { encoding: 'utf8' });
      check('a directory with no site in it is an error, not an empty sitemap', none.status === 1 && /no index\.html/.test(none.stderr), `exit ${none.status}: ${none.stderr}`);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

header('the Pages job');
{
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'drift-feed.yml'), 'utf8');
  const build = workflow.slice(workflow.indexOf('- name: Build the site and the feed'), workflow.indexOf('upload-pages-artifact'));
  const at = (s) => build.indexOf(s);
  const SITEMAP = 'node scripts/site-sitemap.mjs --dir dist-feed --site "https://askalf.github.io/dario"';
  check('writes the sitemap into the artifact it uploads', at(SITEMAP) > 0 && /path: dist-feed/.test(workflow));
  check('after the landing page, the tool pages and the feed are in place', ['node scripts/drift-feed.mjs', 'cp -r site/. dist-feed/', 'node scripts/site-tools.mjs'].every((s) => at(s) > 0 && at(s) < at(SITEMAP)));
  check('with the same site the tool pages are built for', build.includes('node scripts/site-tools.mjs --out dist-feed/tools --site "https://askalf.github.io/dario"'));
  check('and reruns when the script changes', /-\s+scripts\/site-sitemap\.mjs/.test(workflow.slice(0, workflow.indexOf('jobs:'))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
