#!/usr/bin/env node
// Per-tool pages for askalf.github.io/dario/tools/<slug>/, generated from
// docs/tools.md when the Pages job runs (.github/workflows/drift-feed.yml),
// so a tool's setup lives in one place and the page cannot drift from the
// doc. Every <details> block in that file is one tool: a <summary> with the
// name in <strong> and a tagline after it, a config block and the
// paragraphs that explain it. Each becomes one page; the paragraph before
// the first block and the "something not listed" paragraph after the last
// are shared by all of them. The landing page's stylesheet is inlined so
// the pages look like it without a second file to ship. Nothing is written
// to the repo: the output goes next to the landing page in the artifact.
//
//   node scripts/site-tools.mjs --out dist-feed/tools --site https://askalf.github.io/dario
//
// test/site-tools.mjs builds the pages in memory and checks every link.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/askalf/dario';
const DOCS_BASE = `${REPO}/blob/master/docs/`;
const MIDDOT = String.fromCharCode(0xb7);
// What joins the name and the tagline in a summary, in the order tried.
const JOINERS = [String.fromCharCode(0x2014), MIDDOT, '-', ':'];

// A few names make a poor slug or a poor headline on their own.
const SLUGS = {
  [`Cline ${MIDDOT} Roo Code ${MIDDOT} Kilo Code`]: 'cline-roo-kilo',
  [`Codex CLI ${MIDDOT} OpenAI SDK ${MIDDOT} any OpenAI-compatible tool`]: 'openai-compatible',
  [`Claude Agent SDK ${MIDDOT} Anthropic SDK`]: 'sdk',
};
const HEADLINES = {
  'claude-code': 'Claude Code through dario: every seat you hold behind one URL',
  'cline-roo-kilo': 'Cline, Roo Code and Kilo Code on the Claude plan you already pay for',
  'openai-compatible': 'Codex CLI, the OpenAI SDK and any OpenAI-compatible tool on the plans you already pay for',
  'sdk': 'The Claude Agent SDK and the Anthropic SDK on the plan you already pay for',
  'curl': 'curl against the plan you already pay for',
  'docker': 'dario in Docker, on Kubernetes, on a Pi in a closet',
};

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Text outside code spans: entities kept, the inline tags the docs use kept, every other < escaped.
const INLINE_TAG = /^<\/?(?:kbd|code|strong|em|b|i|br|sup|sub)\b/;
const escText = (s) => s
  .replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;')
  .replace(/</g, (m, off, str) => (INLINE_TAG.test(str.slice(off)) ? '<' : '&lt;'));

// A link in the doc is relative to docs/; on the page it points at the file on GitHub.
export const resolveDocLink = (url) => {
  if (/^(?:https?:|mailto:)/.test(url)) return url;
  if (url.startsWith('#')) return `${DOCS_BASE}tools.md${url}`;
  return new URL(url, DOCS_BASE).href;
};

// The inline subset the doc uses: code spans, links, bold, italic.
export function renderInline(md) {
  return md.split(/(`[^`]*`)/).map((part) => {
    if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1, -1))}</code>`;
    let t = escText(part);
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => `<a href="${esc(resolveDocLink(url))}">${text}</a>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)]|$)/g, '$1<em>$2</em>');
    return t;
  }).join('');
}

// The block subset: fenced code (with a copy button), paragraphs, flat lists.
export function renderBlocks(md) {
  const out = [];
  let para = [], list = [], fence = null;
  const flush = () => {
    if (para.length) { out.push(`<p>${renderInline(para.join(' '))}</p>`); para = []; }
    if (list.length) { out.push(`<ul>${list.map((l) => `<li>${renderInline(l)}</li>`).join('')}</ul>`); list = []; }
  };
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    if (fence) {
      if (line.startsWith('```')) {
        const code = fence.lines.join('\n');
        out.push(`<div class="snippet"><pre class="code" data-lang="${esc(fence.lang)}"><code>${esc(code)}</code></pre><button class="copy" type="button" data-copy="${esc(code)}">copy</button></div>`);
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    if (line.startsWith('```')) { flush(); fence = { lang: line.slice(3).trim(), lines: [] }; continue; }
    if (!line.trim()) { flush(); continue; }
    if (/^[-*] /.test(line)) { if (para.length) flush(); list.push(line.slice(2)); continue; }
    if (list.length && /^\s+\S/.test(line)) { list[list.length - 1] += ' ' + line.trim(); continue; }
    if (list.length) flush();
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

// Tags out of a text fragment, run until nothing changes: one pass turns "<<b>script>" into "<script>". The input is this repo's own docs and every insertion goes through esc(), so this is readability, not the sanitizer; the loop keeps it honest either way.
const stripTags = (s) => { let prev; do { prev = s; s = s.replace(/<[^>]*>/g, ''); } while (s !== prev); return s; };
// Plain text of a markdown fragment, for descriptions.
const plain = (md) => stripTags(md.replace(/```[\s\S]*?```/g, ' '))
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[`*]/g, '')
  .replace(/\s+/g, ' ')
  .trim();
const firstSentence = (text) => { const m = /^(.*?[.!?])(?:\s|$)/.exec(text); return (m ? m[1] : text).trim(); };
// A tagline follows the name in the doc, so it starts lowercase; on its own it opens a sentence.
const cap = (s) => s.replace(/^[a-z]/, (c) => c.toUpperCase());
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '.');

export function parseToolsDoc(md) {
  const src = md.replace(/\r\n/g, '\n');
  const first = src.indexOf('<details>');
  const lastEnd = src.lastIndexOf('</details>') + '</details>'.length;
  if (first < 0 || lastEnd < '</details>'.length) throw new Error('docs/tools.md has no <details> blocks');
  const intro = src.slice(0, first).replace(/^#[^\n]*\n/, '').trim();
  const outro = src.slice(lastEnd).split('\n---')[0].trim();
  const tools = [];
  const re = /<details>\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)<\/details>/g;
  let m;
  while ((m = re.exec(src))) {
    const summary = m[1].trim();
    const strong = /<strong>([\s\S]*?)<\/strong>/.exec(summary);
    const name = stripTags(strong ? strong[1] : summary).trim();
    // The summary reads "<strong>Name</strong> (joiner) tagline"; the tagline is what follows the name, without the punctuation that joined them.
    let tagline = summary.replace(/<strong>[\s\S]*?<\/strong>/, '').trim();
    for (const j of JOINERS) if (tagline.startsWith(j)) { tagline = tagline.slice(j.length).trim(); break; }
    tagline = tagline.replace(/^\(([^)]*)\)\s*$/, '$1').trim();
    const slug = SLUGS[name] || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const body = m[2].trim();
    const taglineText = plain(tagline);
    // A block that is only a config fence has no sentence of its own; the card and the description then say what every page says.
    const sentence = firstSentence(plain(body)) || `Point ${name} at dario, the local endpoint that serves every tool from the Claude and ChatGPT plans you already pay for.`;
    tools.push({ name, slug, tagline, taglineText, body, blurb: tagline || sentence, headline: HEADLINES[slug] || `${name} on the Claude plan you already pay for`, description: clip((taglineText ? taglineText.replace(/[.!?]$/, '') + '. ' : '') + sentence, 160) });
  }
  return { intro, outro, tools };
}

const EXTRA_CSS = `
.doc-hero{padding:56px 0 28px}
.doc-hero h1{font-family:var(--font-mono);font-size:clamp(24px,3vw,36px);font-weight:700;margin-top:12px;max-width:28ch}
.doc-hero .lede{max-width:78ch}
.doc p,.doc ul{max-width:78ch}
.doc .snippet{position:relative;margin:0 0 16px}
.doc pre.code{margin:0;padding:16px 18px;background:var(--term);border:1px solid var(--line);border-radius:12px;color:var(--term-text);font-size:13.5px;line-height:1.7;overflow-x:auto}
.doc pre.code code{background:transparent;border:0;padding:0;font-size:inherit}
.doc .snippet .copy{position:absolute;top:10px;right:10px}
.tools-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:22px}
.tools-grid a.card{display:block;color:var(--text)}
.tools-grid a.card:hover{text-decoration:none;border-color:var(--accent)}
.tools-grid a.card p{color:var(--dim)}
.term.solo{max-width:720px;margin-top:18px}
@media (max-width:920px){.tools-grid{grid-template-columns:repeat(2,1fr)}}
@media (max-width:640px){.tools-grid{grid-template-columns:1fr}}
`;

const THEME_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

const installTerminal = () => `<div class="term solo" aria-label="Install and run">
  <div class="chrome"><i></i><i></i><i></i><span>terminal</span></div>
<pre><span class="cmd"><span><span class="p">$</span> npm install -g @askalf/dario</span><button class="copy" type="button" data-copy="npm install -g @askalf/dario">copy</button></span>
<span class="cmd"><span><span class="p">$</span> dario login        <span class="c"># your Claude plan: Pro, Max 5x or Max 20x</span></span><button class="copy" type="button" data-copy="dario login">copy</button></span>
<span class="o">  Login successful.</span>
<span class="cmd"><span><span class="p">$</span> dario proxy        <span class="c"># leave it running</span></span><button class="copy" type="button" data-copy="dario proxy">copy</button></span>
<span class="o">  dario ${MIDDOT} http://localhost:3456</span>
<span class="c">  Your Claude subscription is now an API.</span></pre>
</div>`;

const installSection = () => `<section>
  <div class="wrap">
    <div class="eyebrow">Before that</div>
    <h2>Install dario, log in, leave it running</h2>
    <p class="sub">Three commands, once. The proxy binds <code>127.0.0.1:3456</code> and holds your login; every tool on the machine shares it. Add a ChatGPT plan with <code>dario add altman</code> and the two fail over to each other.</p>
    ${installTerminal()}
    <div class="facts">
      <span><b>0</b> runtime dependencies</span>
      <span><b>SLSA-attested</b> every release</span>
      <span><b>Nothing</b> phones home</span>
      <span><b>MIT</b>, independent, unofficial</span>
    </div>
  </div>
</section>`;

// The document around a page body: head, nav, footer, the theme and copy script. depth = how many levels below the site root the page sits.
function shell({ site, style, depth, title, description, canonical, body, jsonLd }) {
  const rel = '../'.repeat(depth);
  const css = style.replace(/url\(fonts\//g, `url(${rel}fonts/`) + EXTRA_CSS;
  const sep = ` ${MIDDOT} `;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="theme-color" content="#0a0a0f" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta property="og:type" content="article">
<meta property="og:site_name" content="dario">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${site}/art/social.jpg">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@ask_alf">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/<\//g, '<\\/')}</script>
<style>${css}</style>
</head>
<body>
<nav class="nav" aria-label="Site">
  <div class="wrap">
    <a class="brand" href="${rel}" aria-label="dario home">d<b>a</b>rio <small>Own Your Stack</small></a>
    <div class="links">
      <a href="${rel}#start">Start</a><a href="${rel}tools/">Tools</a><a href="${rel}#dashboard">Dashboard</a><a href="${rel}#docs">Docs</a><a href="${rel}drift-feed/">Drift feed</a><a class="gh" href="${REPO}">GitHub</a>
    </div>
    <button class="tbtn" id="themeBtn" type="button" aria-label="Theme: follows the system" title="Theme: follows the system">${THEME_ICON}</button>
  </div>
</nav>
<main>
${body}
</main>
<footer>
  <div class="wrap">
    <div class="brand">d<b>a</b>rio</div>
    <p style="margin-top:8px">The routing layer of <a href="https://github.com/askalf">Own Your Stack</a>, open tools for owning your AI infrastructure instead of renting it by the token. Built by Thomas Sprayberry at <a href="https://sprayberrylabs.com">Sprayberry Labs</a>, in the open. Follow the build: <a href="https://x.com/ask_alf">@ask_alf</a>.</p>
    <p><a href="${rel}">dario</a>${sep}<a href="${REPO}">GitHub</a>${sep}<a href="https://www.npmjs.com/package/@askalf/dario">npm</a>${sep}<a href="${REPO}/pkgs/container/dario">GHCR</a>${sep}<a href="${rel}drift-feed/">Claude Code wire drift</a>${sep}<a href="https://github.com/sponsors/askalf">Sponsor</a></p>
    <p class="fine">dario is an independent, unofficial, third-party project. Not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or any vendor named here. Provided as-is, no warranty. You are solely responsible for compliance with your subscription's terms, the security of your credentials, and the content you send through the proxy. <a href="${REPO}/blob/master/DISCLAIMER.md">DISCLAIMER.md</a>${sep}<a href="${REPO}/blob/master/LICENSE">MIT license</a>. Space Mono is used under the SIL Open Font License. This page loads nothing from a third party.</p>
  </div>
</footer>
<script>
(function(){
  'use strict';
  var root=document.documentElement, btn=document.getElementById('themeBtn'), order=['system','dark','light'], cur='system';
  try{ cur=localStorage.getItem('dario.site.theme')||'system'; }catch(e){}
  function apply(){ if(cur==='system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme',cur); var label='Theme: '+(cur==='system'?'follows the system':cur); btn.setAttribute('aria-label',label); btn.title=label; try{ localStorage.setItem('dario.site.theme',cur); }catch(e){} }
  btn.addEventListener('click',function(){ cur=order[(order.indexOf(cur)+1)%order.length]; apply(); });
  apply();
  var copies=document.querySelectorAll('button.copy');
  for(var i=0;i<copies.length;i++){ copies[i].addEventListener('click',function(e){ var b=e.currentTarget, text=b.getAttribute('data-copy'); function done(ok){ b.textContent=ok?'copied':'copy failed'; setTimeout(function(){ b.textContent='copy'; },1400); } if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(function(){ done(true); },function(){ done(false); }); } else { done(false); } }); }
})();
</script>
</body>
</html>
`;
}

const chip = (href, text) => `<a class="chip" href="${esc(href)}">${esc(text)}</a>`;

function toolPage({ site, style, doc, tool }) {
  const canonical = `${site}/tools/${tool.slug}/`;
  const title = `${tool.headline} ${MIDDOT} dario`;
  const siblings = doc.tools.filter((t) => t.slug !== tool.slug).map((t) => chip(`../${t.slug}/`, t.name)).join('\n      ');
  const body = `<section class="hero doc-hero">
  <div class="wrap">
    <div class="eyebrow"><a href="../">Point your tools at it</a> ${MIDDOT} ${esc(tool.name)}</div>
    <h1>${esc(tool.headline)}</h1>
    <p class="lede">${tool.tagline ? renderInline(cap(tool.tagline)).replace(/[.]?$/, '. ') : ''}${renderInline(doc.intro)}</p>
  </div>
</section>
<section class="doc">
  <div class="wrap">
    <div class="eyebrow">Setup</div>
    <h2>${esc(tool.name)}</h2>
    ${renderBlocks(tool.body)}
  </div>
</section>
${installSection()}
<section>
  <div class="wrap">
    <div class="eyebrow">Other tools</div>
    <h2>Same URL, same key</h2>
    <div class="chips">
      ${siblings}
      ${chip(`${DOCS_BASE}integrations/compat-matrix.md`, 'Compatibility matrix')}
    </div>
    <p class="sub" style="margin-top:16px">${renderInline(doc.outro)}</p>
  </div>
</section>`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: tool.headline,
    description: tool.description,
    url: canonical,
    about: { '@type': 'SoftwareApplication', name: 'dario', url: `${site}/` },
    isPartOf: { '@type': 'WebSite', name: 'dario', url: `${site}/` },
  };
  return shell({ site, style, depth: 2, title, description: tool.description, canonical, body, jsonLd });
}

function indexPage({ site, style, doc }) {
  const canonical = `${site}/tools/`;
  const title = 'Every tool you own, one URL: per-tool setup for dario';
  const description = clip(`Point ${doc.tools.map((t) => t.name).join(', ')} at the Claude and ChatGPT plans you already pay for. One config block per tool, with the gotchas each one has.`, 160);
  const cards = doc.tools.map((t) => `<a class="card" href="${t.slug}/"><h3>${esc(t.name)}</h3><p>${renderInline(cap(t.blurb))}</p></a>`).join('\n      ');
  const body = `<section class="hero doc-hero">
  <div class="wrap">
    <div class="eyebrow">Point your tools at it</div>
    <h1>Every tool you own, one URL</h1>
    <p class="lede">${renderInline(doc.intro)}</p>
    <div class="tools-grid">
      ${cards}
    </div>
    <p class="sub" style="margin-top:22px">${renderInline(doc.outro)}</p>
  </div>
</section>
${installSection()}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description,
    url: canonical,
    isPartOf: { '@type': 'WebSite', name: 'dario', url: `${site}/` },
  };
  return shell({ site, style, depth: 1, title, description, canonical, body, jsonLd });
}

// Every page as {path relative to the site root: html}.
export function buildSite({ toolsMd, landingHtml, site }) {
  const style = (/<style>([\s\S]*?)<\/style>/.exec(landingHtml) || [, ''])[1];
  if (!style.includes('--font-mono')) throw new Error('site/index.html has no stylesheet to inline');
  const doc = parseToolsDoc(toolsMd);
  const root = site.replace(/\/$/, '');
  const pages = new Map();
  pages.set('tools/index.html', indexPage({ site: root, style, doc }));
  for (const tool of doc.tools) pages.set(`tools/${tool.slug}/index.html`, toolPage({ site: root, style, doc, tool }));
  return { doc, pages };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
  const out = resolve(opt('--out', 'dist-feed/tools'));
  const site = opt('--site', 'https://askalf.github.io/dario');
  const { pages } = buildSite({
    toolsMd: readFileSync(join(ROOT, 'docs', 'tools.md'), 'utf8'),
    landingHtml: readFileSync(join(ROOT, 'site', 'index.html'), 'utf8'),
    site,
  });
  for (const [path, html] of pages) {
    const file = join(out, path.replace(/^tools\//, ''));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  }
  console.log(`site-tools: ${pages.size} pages under ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
