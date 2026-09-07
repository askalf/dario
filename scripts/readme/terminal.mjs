#!/usr/bin/env node
// README quick-start terminal: an animated SVG "recording" generated from a
// script (quickstart.cast.json) rather than a GIF. Typed commands use a
// character-stepped clip; output appears line-by-line; the whole thing loops.
// Self-contained (embedded font), theme-specific, no JavaScript. Regenerate:
//
//   node scripts/readme/terminal.mjs
//
// Why a script and not a real recording: the banner lines are copied from
// what the proxy prints (src/proxy.ts) so they are exact, while the OAuth
// step cannot be recorded without publishing a real login. The file says so.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAR_W, OUT_DIR, THEMES, esc, svgDoc, windowChrome } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cast = JSON.parse(readFileSync(join(HERE, 'quickstart.cast.json'), 'utf8'));

const FS = 13.5;                 // font size
const CW = +(FS * CHAR_W).toFixed(3);
const LH = 21;                   // line height
const COLS = cast.cols;
const PAD = 22, CHROME = 38;
const TYPE_S = 0.045;            // seconds per typed character
const OUT_S = 0.08;              // seconds per output line
const HOLD_S = 6;                // hold the finished screen before looping

// ── flatten the script into timed rows ───────────────────────────────
const rows = [];                 // { kind: 'cmd'|'out', text, tone, t }
let t = 0.6;
for (const step of cast.steps) {
  if (step.cmd) {
    rows.push({ kind: 'cmd', text: step.cmd, t });
    t += step.cmd.length * TYPE_S + 0.55;
  } else {
    for (const line of step.out) {
      const text = typeof line === 'string' ? line : line.text;
      const tone = typeof line === 'string' ? 'dim' : line.tone;
      // wrap at COLS like a terminal would
      const chunks = [];
      for (let i = 0; i < Math.max(1, text.length); i += COLS) chunks.push(text.slice(i, i + COLS));
      for (const c of chunks) { rows.push({ kind: 'out', text: c, tone, t }); t += OUT_S; }
    }
    t += 0.35;
  }
}
const END = t;                   // everything visible
const LOOP = +(END + HOLD_S).toFixed(2);

const W = Math.round(PAD * 2 + COLS * CW);
const H = Math.round(CHROME + PAD + (rows.length + 1) * LH + PAD);

function render(th) {
  const tone = { dim: th.dim, text: th.text, bright: th.bright, green: th.green, cyan: th.cyan };
  const y = (i) => CHROME + PAD + i * LH + FS;
  const els = [];
  rows.forEach((r, i) => {
    const kt = (s) => Math.min(1, s / LOOP).toFixed(4);
    if (r.kind === 'cmd') {
      const n = r.text.length;
      const w = +(n * CW).toFixed(2);
      // clip width steps: 0..w during typing, hold to loop end, then 0
      const vals = [], keys = [];
      for (let k = 0; k <= n; k++) { vals.push((k * CW).toFixed(2)); keys.push(kt(r.t + k * TYPE_S)); }
      vals.push(w.toFixed(2)); keys.push('1');
      const id = `c${i}`;
      els.push(`<clipPath id="${id}"><rect x="${PAD + 2 * CW}" y="${y(i) - FS}" height="${LH}" width="0">
  <animate attributeName="width" values="0;${vals.join(';')}" keyTimes="0;${keys.join(';')}" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite"/></rect></clipPath>`);
      els.push(`<text x="${PAD}" y="${y(i)}" font-size="${FS}" fill="${th.accent}" opacity="0"><animate attributeName="opacity" values="0;0;1;1" keyTimes="0;${kt(r.t)};${kt(r.t)};1" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite"/>$</text>`);
      els.push(`<text x="${PAD + 2 * CW}" y="${y(i)}" font-size="${FS}" fill="${th.text}" xml:space="preserve" textLength="${w}" lengthAdjust="spacingAndGlyphs" clip-path="url(#${id})">${esc(r.text)}</text>`);
      // typing cursor: follows the clip edge, visible only while typing
      const xs = []; for (let k = 0; k <= n; k++) xs.push((PAD + 2 * CW + k * CW).toFixed(2));
      els.push(`<rect y="${y(i) - FS + 1}" width="${CW.toFixed(2)}" height="${LH - 3}" fill="${th.bright}" opacity="0">
  <animate attributeName="x" values="${xs[0]};${xs.join(';')};${xs[n]}" keyTimes="0;${keys.slice(0, -1).join(';')};1" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite"/>
  <animate attributeName="opacity" values="0;0;0.9;0.9;0;0" keyTimes="0;${kt(r.t)};${kt(r.t)};${kt(r.t + n * TYPE_S + 0.3)};${kt(r.t + n * TYPE_S + 0.3)};1" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite"/></rect>`);
    } else if (r.text.length) {
      const w = +(r.text.length * CW).toFixed(2);
      els.push(`<text x="${PAD}" y="${y(i)}" font-size="${FS}" fill="${tone[r.tone] || th.dim}" xml:space="preserve" textLength="${w}" lengthAdjust="spacingAndGlyphs" opacity="0"><animate attributeName="opacity" values="0;0;1;1" keyTimes="0;${kt(r.t)};${kt(r.t)};1" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite"/>${esc(r.text)}</text>`);
    }
  });
  // final prompt with a blinking cursor
  const last = rows.length;
  els.push(`<g opacity="0"><animate attributeName="opacity" values="0;0;1;1" keyTimes="0;${(END / LOOP).toFixed(4)};${(END / LOOP).toFixed(4)};1" calcMode="discrete" dur="${LOOP}s" repeatCount="indefinite"/>
  <text x="${PAD}" y="${y(last)}" font-size="${FS}" fill="${th.accent}">$</text>
  <rect class="blink" x="${PAD + 2 * CW}" y="${y(last) - FS + 1}" width="${CW.toFixed(2)}" height="${LH - 3}" fill="${th.bright}"/></g>`);

  const chrome = windowChrome({ w: W, h: H, chromeH: CHROME, title: 'quick start', right: 'localhost:3456', theme: th });

  return svgDoc({
    w: W, h: H, bold: false,
    title: 'dario quick start: install, log in, start the proxy, point a tool at it',
    desc: `Terminal transcript. ${cast.steps.filter((s) => s.cmd).map((s) => '$ ' + s.cmd).join(' ')} — the proxy prints: Your Claude subscription is now an API, with ANTHROPIC_BASE_URL=http://localhost:3456 and ANTHROPIC_API_KEY=dario.`,
    style: `.blink{animation:blink 1.1s steps(1) infinite}@keyframes blink{50%{opacity:0}}`,
    body: chrome + '\n' + els.join('\n'),
  });
}

mkdirSync(OUT_DIR, { recursive: true });
// The terminal is dark in both themes (a dark terminal reads fine on a light page);
// only the accent palette differs, so both variants are still emitted for <picture>.
for (const theme of Object.values(THEMES)) {
  const th = { ...THEMES.dark, accent: theme.accent === THEMES.light.accent ? THEMES.dark.accent : theme.accent, name: theme.name };
  const file = join(OUT_DIR, `quickstart-${theme.name}.svg`);
  writeFileSync(file, render(th));
  console.log('wrote', file, `${W}x${H}`, `loop ${LOOP}s`);
}
