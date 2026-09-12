#!/usr/bin/env node
// The Claude Code wire-drift feed — every change to what Claude Code sends on
// the wire, as the template watcher observed it, published as a page + RSS +
// JSON Feed. Read from git history alone: each commit that touched
// src/cc-template-data.json is one observation, and the diff between
// consecutive observations is one entry. Nothing is captured here and nothing
// is stored; a redeploy rebuilds the whole feed from `git log`.
//
//   node scripts/drift-feed.mjs [--out docs/drift-feed] [--site https://…]
//
// The diff itself is pure (`diffTemplates`) so test/drift-feed.mjs can pin
// what an entry says without a git repository.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const TEMPLATE_PATH = 'src/cc-template-data.json';
const REPO = 'https://github.com/askalf/dario';

// ---------------------------------------------------------------------------
//  Pure: two template snapshots → what changed
// ---------------------------------------------------------------------------

const splitBetas = (s) => (typeof s === 'string' ? s.split(',').map((b) => b.trim()).filter(Boolean) : []);
const setDiff = (before, after) => ({ added: after.filter((x) => !before.includes(x)), removed: before.filter((x) => !after.includes(x)) });
const hash = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 10);

/**
 * What changed between two bundled templates, in the terms a reader cares
 * about. `wire` is false when only the version label / capture stamp moved —
 * a Claude Code release that changed nothing on the wire is worth a line too.
 */
export function diffTemplates(before, after) {
  const b = before ?? {};
  const a = after ?? {};
  const changes = [];
  const push = (kind, text, detail) => changes.push(detail === undefined ? { kind, text } : { kind, text, detail });

  const betas = setDiff(splitBetas(b.anthropic_beta), splitBetas(a.anthropic_beta));
  for (const x of betas.added) push('beta', `beta flag added: \`${x}\``);
  for (const x of betas.removed) push('beta', `beta flag removed: \`${x}\``);

  const toolsB = Array.isArray(b.tool_names) ? b.tool_names : [];
  const toolsA = Array.isArray(a.tool_names) ? a.tool_names : [];
  const tools = setDiff(toolsB, toolsA);
  for (const x of tools.added) push('tool', `tool added: \`${x}\``);
  for (const x of tools.removed) push('tool', `tool removed: \`${x}\``);
  const schemaB = new Map((Array.isArray(b.tools) ? b.tools : []).map((t) => [t?.name, hash(t)]));
  const schemaA = new Map((Array.isArray(a.tools) ? a.tools : []).map((t) => [t?.name, hash(t)]));
  const reschemaed = [...schemaA.keys()].filter((n) => schemaB.has(n) && schemaB.get(n) !== schemaA.get(n));
  if (reschemaed.length > 0) push('tool', `${reschemaed.length} tool schema${reschemaed.length === 1 ? '' : 's'} changed: ${reschemaed.map((n) => `\`${n}\``).join(', ')}`);

  const hdrB = b.header_values ?? {};
  const hdrA = a.header_values ?? {};
  for (const k of Object.keys(hdrA)) {
    if (!(k in hdrB)) push('header', `header added: \`${k}: ${String(hdrA[k])}\``);
    else if (String(hdrA[k]) !== String(hdrB[k])) push('header', `header \`${k}\`: \`${String(hdrB[k])}\` → \`${String(hdrA[k])}\``);
  }
  for (const k of Object.keys(hdrB)) if (!(k in hdrA)) push('header', `header removed: \`${k}\``);
  const orderB = Array.isArray(b.header_order) ? b.header_order : [];
  const orderA = Array.isArray(a.header_order) ? a.header_order : [];
  if (orderB.length > 0 && orderA.length > 0 && orderB.join('|') !== orderA.join('|') && setDiff(orderB, orderA).added.length === 0 && setDiff(orderB, orderA).removed.length === 0) push('header', 'header order changed');

  const bodyB = Array.isArray(b.body_field_order) ? b.body_field_order : [];
  const bodyA = Array.isArray(a.body_field_order) ? a.body_field_order : [];
  if (bodyB.length > 0 && bodyA.length > 0 && bodyB.join('|') !== bodyA.join('|')) push('body', `body field order changed: ${bodyA.join(', ')}`);

  const spB = typeof b.system_prompt === 'string' ? b.system_prompt : '';
  const spA = typeof a.system_prompt === 'string' ? a.system_prompt : '';
  if (spB !== spA) {
    const delta = spA.length - spB.length;
    push('prompt', `system prompt changed (${delta >= 0 ? '+' : ''}${delta} chars, now ${spA.length})`, firstDifference(spB, spA));
  }
  const varB = b.system_prompt_variants ?? {};
  const varA = a.system_prompt_variants ?? {};
  const variants = setDiff(Object.keys(varB), Object.keys(varA));
  for (const x of variants.added) push('prompt', `system prompt variant added: \`${x}\``);
  for (const x of variants.removed) push('prompt', `system prompt variant removed: \`${x}\``);
  for (const k of Object.keys(varA)) if (k in varB && hash(varA[k]) !== hash(varB[k])) push('prompt', `system prompt variant \`${k}\` changed`);

  if ((b.agent_identity ?? '') !== (a.agent_identity ?? '') && a.agent_identity !== undefined) push('prompt', `agent identity line: \`${String(a.agent_identity).slice(0, 80)}\``);

  const versionB = b._version ?? null;
  const versionA = a._version ?? null;
  return {
    version: versionA,
    previousVersion: versionB,
    versionChanged: versionA !== versionB,
    captured: a._captured ?? null,
    wire: changes.length > 0,
    changes,
  };
}

/** A short excerpt around the first differing character — enough to see what moved. */
function firstDifference(before, after) {
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  const from = Math.max(0, i - 40);
  const clip = (s) => s.slice(from, i + 120).replace(/\s+/g, ' ').trim();
  return { before: clip(before), after: clip(after) };
}

// ---------------------------------------------------------------------------
//  History → entries
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

/** Every commit that touched the template, oldest first: { sha, date, subject, pr }. */
export function templateCommits() {
  const out = git(['log', '--reverse', '--format=%H%x1f%aI%x1f%s', '--', TEMPLATE_PATH]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, date, subject] = line.split('\x1f');
    const pr = /\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? null;
    return { sha, date, subject, pr };
  });
}

function templateAt(sha) {
  try { return JSON.parse(git(['show', `${sha}:${TEMPLATE_PATH}`])); } catch { return null; }
}

/** Entries newest first. */
export function buildEntries() {
  const commits = templateCommits();
  const entries = [];
  let prev = null;
  for (const c of commits) {
    const cur = templateAt(c.sha);
    if (!cur) continue;
    const d = diffTemplates(prev, cur);
    prev = cur;
    if (!d.versionChanged && !d.wire) continue;   // a commit that touched the file without moving the template
    entries.push({ ...d, sha: c.sha, date: c.date, subject: c.subject, pr: c.pr });
  }
  return entries.reverse();
}

// ---------------------------------------------------------------------------
//  Rendering
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

export function entryTitle(e) {
  const v = e.version ? `Claude Code ${e.version}` : 'Claude Code';
  if (!e.wire) return `${v} shipped — nothing changed on the wire`;
  const kinds = [...new Set(e.changes.map((c) => c.kind))];
  const what = kinds.map((k) => ({ beta: 'beta flags', tool: 'tools', header: 'headers', body: 'body order', prompt: 'system prompt' })[k] ?? k).join(', ');
  return `${v}: ${what} changed on the wire`;
}

export function entryId(e) { return `${REPO}/commit/${e.sha}`; }

function entryHtml(e) {
  const when = new Date(e.date).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  const cap = e.captured ? new Date(e.captured).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : null;
  const link = e.pr ? `${REPO}/pull/${e.pr}` : entryId(e);
  const items = e.changes.map((c) => `<li class="${esc(c.kind)}">${md(c.text)}${c.detail ? `<details><summary>excerpt</summary><pre>- ${esc(c.detail.before)}\n+ ${esc(c.detail.after)}</pre></details>` : ''}</li>`).join('');
  return `<article class="${e.wire ? 'wire' : 'quiet'}" id="${esc(e.sha.slice(0, 10))}">
  <h2><a href="#${esc(e.sha.slice(0, 10))}">${esc(entryTitle(e))}</a></h2>
  <p class="meta">observed ${esc(when)}${cap ? ` · captured ${esc(cap)}` : ''}${e.previousVersion && e.versionChanged ? ` · ${esc(e.previousVersion)} → ${esc(e.version)}` : ''} · <a href="${esc(link)}">${e.pr ? `#${esc(e.pr)}` : esc(e.sha.slice(0, 10))}</a></p>
  ${items ? `<ul>${items}</ul>` : ''}
</article>`;
}

export function renderHtml(entries, site) {
  const wire = entries.filter((e) => e.wire).length;
  const first = entries.at(-1);
  const style = `
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--mute:#666;--line:#e5e5e5;--accent:#7c3aed;--code:#f3f0ff}
@media(prefers-color-scheme:dark){:root{--bg:#0a0a0f;--fg:#eaeaea;--mute:#9a9a9a;--line:#26262e;--accent:#a78bfa;--code:#1a1526}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:52rem;margin:0 auto;padding:2rem 1.25rem 4rem}
h1{font-size:1.6rem;margin:0 0 .25rem}h2{font-size:1.05rem;margin:0 0 .25rem}h2 a{color:inherit;text-decoration:none}
.lede,.meta{color:var(--mute);margin:.25rem 0}.meta{font-size:.85rem}
nav a{margin-right:1rem}article{padding:1rem 0;border-top:1px solid var(--line)}article.quiet h2{color:var(--mute);font-weight:500}
ul{margin:.5rem 0 0;padding-left:1.25rem}li{margin:.2rem 0}code{background:var(--code);padding:.05rem .3rem;border-radius:3px;font-size:.9em}
pre{white-space:pre-wrap;word-break:break-word;background:var(--code);padding:.5rem .75rem;border-radius:4px;font-size:.8rem}details{margin:.25rem 0}summary{cursor:pointer;color:var(--mute);font-size:.85rem}
li.beta::marker{color:var(--accent)}a{color:var(--accent)}footer{margin-top:2rem;color:var(--mute);font-size:.85rem}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code wire drift</title>
<link rel="alternate" type="application/rss+xml" title="Claude Code wire drift" href="feed.xml">
<link rel="alternate" type="application/feed+json" title="Claude Code wire drift" href="feed.json">
<style>${style}</style></head><body><main>
<h1>Claude Code wire drift</h1>
<p class="lede">Every change to what Claude Code sends on the wire — beta flags, headers, tools, the system prompt — as <a href="${REPO}">dario</a>'s template watcher observed it. The watcher captures a live Claude Code install every 30 minutes and re-bakes dario's bundled template when the shape moves; this page is that history, rebuilt from git on every publish. ${entries.length} entries, ${wire} wire changes${first ? `, since ${esc(new Date(first.date).toISOString().slice(0, 10))}` : ''}.</p>
<nav><a href="feed.xml">RSS</a><a href="feed.json">JSON Feed</a><a href="${REPO}/blob/master/docs/drift-monitor.md">how the watcher works</a><a href="${REPO}/blob/master/${TEMPLATE_PATH}">the template</a></nav>
${entries.map(entryHtml).join('\n')}
<footer>Generated by <code>scripts/drift-feed.mjs</code> from the commits that touched <code>${TEMPLATE_PATH}</code>. A "nothing changed on the wire" line is a Claude Code release the watcher checked and found identical on the wire.${site ? ` Canonical: <a href="${esc(site)}">${esc(site)}</a>.` : ''}</footer>
</main></body></html>
`;
}

export function renderRss(entries, site) {
  const base = site ? site.replace(/\/$/, '') : `${REPO}/tree/master/docs/drift-feed`;
  const item = (e) => `<item>
<title>${esc(entryTitle(e))}</title>
<link>${esc(base)}/#${esc(e.sha.slice(0, 10))}</link>
<guid isPermaLink="false">${esc(entryId(e))}</guid>
<pubDate>${new Date(e.date).toUTCString()}</pubDate>
<description>${esc(e.changes.length ? e.changes.map((c) => c.text).join('\n') : `Claude Code ${e.version ?? ''} — no wire change observed.`)}</description>
</item>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Claude Code wire drift</title>
<link>${esc(base)}/</link>
<description>Every change to what Claude Code sends on the wire, as dario's template watcher observed it.</description>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${entries.slice(0, 100).map(item).join('\n')}
</channel></rss>
`;
}

export function renderJsonFeed(entries, site) {
  const base = site ? site.replace(/\/$/, '') : `${REPO}/tree/master/docs/drift-feed`;
  return JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Claude Code wire drift',
    home_page_url: `${base}/`,
    feed_url: `${base}/feed.json`,
    description: "Every change to what Claude Code sends on the wire, as dario's template watcher observed it.",
    items: entries.slice(0, 200).map((e) => ({
      id: entryId(e),
      url: `${base}/#${e.sha.slice(0, 10)}`,
      title: entryTitle(e),
      date_published: e.date,
      content_text: e.changes.length ? e.changes.map((c) => c.text).join('\n') : `Claude Code ${e.version ?? ''} — no wire change observed.`,
      _dario: { version: e.version, previous_version: e.previousVersion, captured: e.captured, wire: e.wire, changes: e.changes, commit: e.sha, pr: e.pr },
    })),
  }, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
//  CLI
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
  const out = arg('--out', 'docs/drift-feed');
  const site = arg('--site', process.env.DRIFT_FEED_SITE ?? '');
  const entries = buildEntries();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.html'), renderHtml(entries, site));
  writeFileSync(join(out, 'feed.xml'), renderRss(entries, site));
  writeFileSync(join(out, 'feed.json'), renderJsonFeed(entries, site));
  writeFileSync(join(out, '.nojekyll'), '');
  console.log(`drift feed: ${entries.length} entries (${entries.filter((e) => e.wire).length} wire changes) → ${out}/`);
}
