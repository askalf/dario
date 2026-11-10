#!/usr/bin/env node
// sitemap.xml for askalf.github.io/dario, written into the Pages artifact after
// everything else has been built there (.github/workflows/drift-feed.yml).
//
// The site is a project page under a github.io host with no robots.txt of its
// own, and nothing told a search engine which pages exist: the landing page,
// the per-tool pages and the drift feed were reachable only by following links
// from the landing page. This lists every HTML page the artifact holds, so the
// list cannot fall behind what is deployed. Submitting it to a search console
// is a step for whoever owns the property.
//
//   node scripts/site-sitemap.mjs --dir dist-feed --site https://askalf.github.io/dario
//
// test/site-sitemap.mjs holds the listing and the XML.

import { readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pages that are not content: GitHub's error page, and a search engine's ownership file (google<token>.html and the like).
const SKIP = [/^404\.html$/, /^google[0-9a-f]+\.html$/i, /^BingSiteAuth\.xml$/i, /^yandex_[0-9a-f]+\.html$/i];

/** Every .html file under `dir`, as paths relative to it with forward slashes. */
export function htmlFiles(dir) {
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.html')) out.push(p);
    }
  };
  walk('');
  return out;
}

/**
 * The URL a file is served at: a directory's index.html is the directory, with
 * its trailing slash, which is the form the pages name as their canonical.
 * Null for a file that is not a page.
 */
export function pageUrl(file, site) {
  const name = file.split('/').pop();
  if (SKIP.some((re) => re.test(name))) return null;
  const root = site.replace(/\/+$/, '');
  const path = file === 'index.html' ? '' : file.endsWith('/index.html') ? file.slice(0, -'index.html'.length) : file;
  return `${root}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The sitemap for a list of files: the site root first, then by URL, each once. */
export function sitemapXml(files, site) {
  const urls = [...new Set(files.map((f) => pageUrl(f, site)).filter(Boolean))].sort();
  const lines = urls.map((u) => `  <url><loc>${xml(u)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join('\n')}\n</urlset>\n`;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
  const dir = resolve(opt('--dir', 'dist-feed'));
  const site = opt('--site', 'https://askalf.github.io/dario');
  const files = htmlFiles(dir);
  if (!files.includes('index.html')) {
    console.error(`site-sitemap: ${dir} has no index.html; build the site there first`);
    process.exit(1);
  }
  const body = sitemapXml(files, site);
  writeFileSync(join(dir, 'sitemap.xml'), body);
  console.log(`site-sitemap: ${(body.match(/<loc>/g) || []).length} pages in ${join(dir, 'sitemap.xml')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
