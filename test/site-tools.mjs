#!/usr/bin/env node
// The per-tool pages (scripts/site-tools.mjs), built in memory from the real
// docs/tools.md and site/index.html and checked the way test/site.mjs checks
// the landing page: every tool block became a page, the markdown subset is
// rendered with nothing left over, every link and font resolves to what the
// Pages job ships or to a file in this repo, the metadata a share or a
// search result reads is there, nothing loads from a third party, the
// landing page points at these pages, and the workflow builds them.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, parseToolsDoc, renderBlocks, renderInline, resolveDocLink } from '../scripts/site-tools.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://askalf.github.io/dario';
const REPO_FILE = /^https:\/\/github\.com\/askalf\/dario\/(?:blob|tree)\/master\/([^#]+)/;
// An en dash or an em dash, named by code so this file carries neither.
const DASH = new RegExp('[' + String.fromCharCode(0x2013) + String.fromCharCode(0x2014) + ']');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 600) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const toolsMd = readFileSync(join(ROOT, 'docs', 'tools.md'), 'utf8');
const landingHtml = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'drift-feed.yml'), 'utf8');
const { doc, pages } = buildSite({ toolsMd, landingHtml, site: SITE });

// What the Pages job puts at the site root (see drift-feed.yml and test/site.mjs).
const shipped = (p) => {
  if (p === '' || p === 'index.html') return true;
  if (p === 'drift-feed/' || p.startsWith('drift-feed/')) return true;
  if (p.startsWith('art/')) return existsSync(join(ROOT, '.github', 'readme', p.slice(4)));
  if (p.startsWith('fonts/')) return existsSync(join(ROOT, 'scripts', 'readme', 'fonts', p.slice(6)));
  if (p.startsWith('tools/')) return pages.has(p.endsWith('/') ? p + 'index.html' : p);
  return existsSync(join(ROOT, 'site', p));
};

header('the doc parses into one page per tool');
{
  const blocks = (toolsMd.match(/<details>/g) || []).length;
  check(`every <details> block in docs/tools.md is a tool (${blocks})`, doc.tools.length === blocks && blocks >= 10, doc.tools.length);
  check('names and slugs are unique and the slugs are URL-safe', new Set(doc.tools.map((t) => t.name)).size === doc.tools.length && new Set(doc.tools.map((t) => t.slug)).size === doc.tools.length && doc.tools.every((t) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t.slug)), doc.tools.map((t) => t.slug).join(','));
  check('a page per tool plus the index', pages.size === doc.tools.length + 1 && pages.has('tools/index.html') && doc.tools.every((t) => pages.has(`tools/${t.slug}/index.html`)));
  check('the shared intro and outro came through', /Two base URLs, one key/.test(doc.intro) && /Something not listed/.test(doc.outro));
  const cursor = doc.tools.find((t) => t.slug === 'cursor');
  check('the tagline after the name is kept, the dash before it is not', !!cursor && /^needs a public HTTPS tunnel/.test(cursor.tagline) && !DASH.test(cursor.tagline[0]), cursor && cursor.tagline);
  check('every tool has a headline and a description between 40 and 160 characters', doc.tools.every((t) => t.headline.length > 10 && t.description.length >= 40 && t.description.length <= 160), doc.tools.map((t) => `${t.slug}:${t.description.length}`).join(' '));
}

header('the markdown subset renders with nothing left over');
{
  const sample = 'run `a <b>` then [docs](usage.md#x) and **bold** or *this*';
  check('code spans, links, bold and italic', renderInline(sample) === 'run <code>a &lt;b&gt;</code> then <a href="https://github.com/askalf/dario/blob/master/docs/usage.md#x">docs</a> and <strong>bold</strong> or <em>this</em>', renderInline(sample));
  check('inline tags the docs use pass through, other angle brackets are escaped', renderInline('<kbd>Cmd</kbd> + <code>x</code> and a <random> thing') === '<kbd>Cmd</kbd> + <code>x</code> and a &lt;random> thing');
  check('a relative link resolves against docs/, a parent link against the repo root, an absolute one is untouched', resolveDocLink('integrations/codex-cli.md') === 'https://github.com/askalf/dario/blob/master/docs/integrations/codex-cli.md' && resolveDocLink('../README.md#reference') === 'https://github.com/askalf/dario/blob/master/README.md#reference' && resolveDocLink('https://example.com/x') === 'https://example.com/x');
  const html = renderBlocks('para one\nstill one\n\n```bash\nexport A=1\n\necho "<x>"\n```\n\n- first\n- second\n\nlast');
  check('paragraphs, a fence with a blank line and a copy button, a list', html.includes('<p>para one still one</p>') && html.includes('<pre class="code" data-lang="bash"><code>export A=1\n\necho &quot;&lt;x&gt;&quot;</code></pre>') && html.includes('data-copy="export A=1') && html.includes('<ul><li>first</li><li>second</li></ul>') && html.endsWith('<p>last</p>'), html);
  const leftovers = [];
  for (const [path, page] of pages) {
    const main = (/<main>([\s\S]*?)<\/main>/.exec(page) || [, ''])[1].replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/data-copy="[^"]*"/g, '');
    if (/\*\*|\]\(|`|<details>|<summary>|^#+ /m.test(main)) leftovers.push(path);
  }
  check('no markdown markers survive on any page', leftovers.length === 0, leftovers.join(', '));
  const fences = doc.tools.reduce((n, t) => n + (t.body.match(/^```/gm) || []).length / 2, 0);
  const pres = [...pages.values()].reduce((n, p) => n + (p.match(/<pre class="code"/g) || []).length, 0);
  check(`every fence became a code block (${fences})`, fences === pres && Number.isInteger(fences), `${fences} fences, ${pres} blocks`);
}

header('links and fonts');
{
  const broken = [], anchors = [], external = [];
  for (const [path, page] of pages) {
    const dir = posix.dirname(path);
    const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const hrefs = [...page.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    for (const m of page.matchAll(/url\(([^)]+)\)/g)) hrefs.push(m[1]);
    for (const m of page.matchAll(/\bcontent="(https:\/\/askalf\.github\.io\/dario\/[^"]*)"/g)) hrefs.push(m[1]);
    for (const raw of hrefs) {
      const [target, anchor] = raw.split('#');
      if (raw.startsWith('#')) { if (!ids.has(anchor)) anchors.push(`${path}: ${raw}`); continue; }
      if (target.startsWith(SITE + '/')) { if (!shipped(target.slice(SITE.length + 1))) broken.push(`${path}: ${raw}`); continue; }
      const repo = REPO_FILE.exec(target);
      if (repo) { if (!existsSync(join(ROOT, repo[1]))) broken.push(`${path}: ${raw}`); continue; }
      if (/^(?:https?:|mailto:)/.test(target)) continue;
      const rel = posix.normalize(posix.join(dir, target));
      if (rel.startsWith('..')) { broken.push(`${path}: ${raw} leaves the site`); continue; }
      if (!shipped(rel === '.' ? '' : rel)) broken.push(`${path}: ${raw}`);
    }
    if (/<script[^>]*\ssrc=/.test(page) || /<link[^>]*rel="(?:stylesheet|preconnect|preload)"/.test(page) || /@import|fonts\.g/.test(page) || /<img[^>]*\ssrc="https?:/.test(page)) external.push(path);
  }
  check('every relative link, image and font resolves to something the Pages job ships', broken.length === 0, broken.join(' | '));
  check('every in-page anchor has its target', anchors.length === 0, anchors.join(' | '));
  // A link into this repo is one whose parsed host is github.com; a substring test would also match a path that merely mentions it.
  const intoRepo = (b) => { try { return new URL(b.slice(b.indexOf(': ') + 2)).hostname === 'github.com'; } catch { return false; } };
  check('every link into this repo points at a file that exists', !broken.some(intoRepo), broken.filter(intoRepo).join(' | '));
  check('nothing loads from a third party', external.length === 0, external.join(', '));
  const cursor = pages.get('tools/cursor/index.html');
  check('a tool page reaches the brand font two levels up, the index one level up', /url\(\.\.\/\.\.\/fonts\/SpaceMono-400-latin\.woff2\)/.test(cursor) && /url\(\.\.\/fonts\/SpaceMono-400-latin\.woff2\)/.test(pages.get('tools/index.html')));
  check('a tool page links every other tool and the compatibility matrix', doc.tools.filter((t) => t.slug !== 'cursor').every((t) => cursor.includes(`href="../${t.slug}/"`)) && cursor.includes('integrations/compat-matrix.md'));
}

header('what a share or a search result reads');
{
  const bad = [];
  for (const [path, page] of pages) {
    const canonical = `${SITE}/${path.replace(/index\.html$/, '')}`;
    const ok = /<html lang="en">/.test(page)
      && /<title>[^<]{10,}<\/title>/.test(page)
      && /name="description" content="[^"]{40,}"/.test(page)
      && page.includes(`rel="canonical" href="${canonical}"`)
      && page.includes(`property="og:url" content="${canonical}"`)
      && page.includes(`property="og:image" content="${SITE}/art/social.jpg"`)
      && (page.match(/<h1[\s>]/g) || []).length === 1
      && /<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org"/.test(page)
      && [...page.matchAll(/<img\b[^>]*>/g)].every((m) => /\salt="[^"]+"/.test(m[0]));
    if (!ok) bad.push(path);
  }
  check('title, description, canonical, Open Graph, JSON-LD, one h1 on every page', bad.length === 0, bad.join(', '));
  const titles = [...pages.values()].map((p) => /<title>([^<]+)<\/title>/.exec(p)[1]);
  check('titles are distinct and name the tool', new Set(titles).size === titles.length && doc.tools.every((t) => pages.get(`tools/${t.slug}/index.html`).includes(`<h1>${t.headline.replace(/&/g, '&amp;')}</h1>`)), titles.join(' | '));
  // The template adds no em or en dash; the doc's own punctuation flows through unchanged.
  const stub = buildSite({ toolsMd: '# t\n\nintro.\n\n<details>\n<summary><strong>Tool</strong> tagline</summary>\n\n```bash\nx=1\n```\n\nbody.\n</details>\n\noutro.\n', landingHtml, site: SITE });
  check('the page template carries no em or en dash', [...stub.pages.values()].every((p) => !DASH.test(p)));
}

header('the landing page and the Pages job');
{
  const chips = [...landingHtml.matchAll(/href="tools\/([a-z0-9-]+)\/"/g)].map((m) => m[1]);
  check('the landing page links every tool page', doc.tools.every((t) => chips.includes(t.slug)) && chips.every((c) => pages.has(`tools/${c}/index.html`)), `linked: ${chips.join(',')}; pages: ${doc.tools.map((t) => t.slug).join(',')}`);
  check('and the index', landingHtml.includes('href="tools/"'));
  check('drift-feed.yml builds the pages into the artifact and runs when the doc or the generator changes', /node scripts\/site-tools\.mjs --out dist-feed\/tools/.test(workflow) && /-\s+docs\/tools\.md/.test(workflow) && /-\s+scripts\/site-tools\.mjs/.test(workflow), workflow.split('\n').filter((l) => l.includes('site-tools')).join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
