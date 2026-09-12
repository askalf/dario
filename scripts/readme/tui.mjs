#!/usr/bin/env node
// README TUI screenshots, rendered from the REAL TUI.
//
// Drives `startTuiApp()` from dist/ through a fake TTY against a fixture proxy
// (the same technique as tools/tui-audit), grabs the last frame of the tabs we
// want, and turns the raw ANSI frame into an SVG: text runs keep their SGR
// colours, box-drawing and block characters are drawn as vectors so the
// screenshot does not depend on any font carrying them. Because the pixels
// come from the shipped renderer, a layout change in src/tui/ changes the
// README picture on the next run instead of silently rotting a hand-drawn
// mock-up. The fixture data is illustrative; the rendering is not.
//
//   npm run build && node scripts/readme/tui.mjs

import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHAR_W, OUT_DIR, THEMES, esc, svgDoc, windowChrome } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const PORT = 39458;
const CLEAR = '\x1b[2J\x1b[H';

// ── fixture proxy: the endpoints the TUI reads, with plausible numbers ──
const ACCOUNTS = [
  { alias: 'work', expiresInMs: 28680000, util5h: 0.41, util7d: 0.62, status: 'active' },
  { alias: 'personal', expiresInMs: 11100000, util5h: 0.78, util7d: 0.88, status: 'active' },
  { alias: 'side', expiresInMs: 24000000, util5h: 0.03, util7d: 0.09, status: 'active' },
];
const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const json = (res, code, body) => { const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s); };
const record = (i, now) => ({
  timestamp: now - (40 - i) * 900, account: ACCOUNTS[i % 3].alias, model: MODELS[i % 5 === 0 ? 2 : i % 3 === 0 ? 1 : 0],
  inputTokens: 1800 + (i * 137) % 900, outputTokens: 240 + (i * 61) % 400, cacheReadTokens: i % 2 ? 4096 : 0,
  cacheCreateTokens: i % 4 ? 0 : 512, thinkingTokens: i % 3 ? 0 : 640, claim: 'subscription',
  util5h: ACCOUNTS[i % 3].util5h, util7d: ACCOUNTS[i % 3].util7d, overageUtil: 0,
  latencyMs: 900 + (i * 47) % 1400, status: 200, isStream: i % 2 === 0, isOpenAI: i % 4 === 3,
});
function startFixture() {
  const timers = new Set();
  const server = createServer((req, res) => {
    const now = Date.now();
    const path = req.url.split('?')[0];
    if (path === '/health') return json(res, 200, { status: 'ok', oauth: 'healthy', expiresIn: '7h 58m', requests: 24980 });
    if (path === '/v1/models') return json(res, 200, { data: ['claude-opus-5', 'claude-opus-5[1m]', 'claude-sonnet-5', 'claude-sonnet-5[1m]', 'claude-fable-5', 'claude-haiku-4-5'].map((id) => ({ id })) });
    if (path === '/admin/resume') return json(res, 200, { halted: false, state: null, config: { enabled: true, behavior: 'halt', cooldownMs: 1800000, notifyOs: true } });
    if (path === '/analytics') return json(res, 200, {
      window: { minutes: 60, requests: 247, totalInputTokens: 1428300, totalOutputTokens: 382000, totalThinkingTokens: 52600, estimatedCost: 21.86, avgLatencyMs: 1642, subscriptionPercent: 100, billingBucketBreakdown: { subscription: 247 } },
      allTime: { requests: 24980 },
      perModel: { 'claude-opus-5': { requests: 148, totalInputTokens: 991000, totalOutputTokens: 244000 }, 'claude-sonnet-5': { requests: 64, totalInputTokens: 318000, totalOutputTokens: 101000 }, 'claude-haiku-4-5': { requests: 35, totalInputTokens: 119300, totalOutputTokens: 37000 } },
      utilization: { lastUtil5h: 0.41, lastUtil7d: 0.62 },
      perAccount: Object.fromEntries(ACCOUNTS.map((a, i) => [a.alias, { requests: [131, 84, 32][i], currentUtil5h: a.util5h, currentUtil7d: a.util7d, lastClaim: 'subscription' }])),
      // The ledger's lifetime view (v6.6): ~25k requests over three weeks at
      // the rolling window's rate, so the number reads as what it is.
      lifetime: { apiEquivalentCost: 2187.4, since: '2026-08-22T14:03:11.000Z', recent: { today: 48.2 } },
    });
    if (path === '/accounts') return json(res, 200, { mode: 'pool', accounts: ACCOUNTS, stickyBindings: 4 });
    if (path === '/analytics/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (let i = 0; i < 40; i++) res.write(`data: ${JSON.stringify(record(i, now))}\n\n`);
      let n = 40;
      const tm = setInterval(() => { if (res.writableEnded) { clearInterval(tm); timers.delete(tm); return; } res.write(`data: ${JSON.stringify(record(n++, Date.now()))}\n\n`); }, 500);
      timers.add(tm); req.on('close', () => { clearInterval(tm); timers.delete(tm); });
      return;
    }
    json(res, 404, { error: 'not found', path });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve({
    close: () => new Promise((r) => { for (const tm of timers) clearInterval(tm); server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

// ── fake TTY + capture ────────────────────────────────────────────────
class FakeStdout extends EventEmitter { constructor(c, r) { super(); this.columns = c; this.rows = r; this.isTTY = true; this.chunks = []; } write(s) { this.chunks.push(String(s)); return true; } }
class FakeStdin extends EventEmitter { constructor() { super(); this.isTTY = true; this.isRaw = false; } setRawMode(v) { this.isRaw = v; return this; } resume() { return this; } pause() { return this; } send(s) { this.emit('data', Buffer.from(s, 'utf8')); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TABS = ['Status', 'Config', 'Analytics', 'Hits', 'Accounts', 'Backends'];

async function captureTab(startTuiApp, tab, cols, rows) {
  const out = new FakeStdout(cols, rows), inp = new FakeStdin();
  const realOut = Object.getOwnPropertyDescriptor(process, 'stdout'), realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdout', { value: out, configurable: true });
  Object.defineProperty(process, 'stdin', { value: inp, configurable: true });
  let frame = '';
  try {
    const done = startTuiApp({ version: process.env.npm_package_version || '6.0.30', proxyUrl: `http://127.0.0.1:${PORT}` });
    await wait(1200);
    for (let i = 0; i < TABS.indexOf(tab); i++) { inp.send('\t'); await wait(500); }
    await wait(600);
    const frames = out.chunks.join('').split(CLEAR).slice(1);
    frame = frames[frames.length - 1] || '';
    inp.send('\x03');
    await Promise.race([done, wait(1500)]);
  } finally {
    Object.defineProperty(process, 'stdout', realOut);
    Object.defineProperty(process, 'stdin', realIn);
  }
  return frame.replace(/\x1b\[\?1049l\x1b\[\?25h$/, '');
}

// ── ANSI → runs ───────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[([0-9;?]*)([A-Za-z])/g;
function parseLine(line) {
  const runs = []; let st = { fg: null, bold: false, dim: false, inv: false }; let last = 0;
  const push = (text) => { if (text) runs.push({ text, ...st }); };
  for (const m of line.matchAll(ANSI_RE)) {
    push(line.slice(last, m.index)); last = m.index + m[0].length;
    if (m[2] !== 'm') continue;
    const ps = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p === 0) st = { fg: null, bold: false, dim: false, inv: false };
      else if (p === 1) st = { ...st, bold: true };
      else if (p === 2) st = { ...st, dim: true };
      else if (p === 22) st = { ...st, bold: false, dim: false };
      else if (p === 7) st = { ...st, inv: true };
      else if (p === 27) st = { ...st, inv: false };
      else if (p === 39) st = { ...st, fg: null };
      else if (p === 38 && ps[i + 1] === 5) { st = { ...st, fg: `x${ps[i + 2]}` }; i += 2; }
      else if (p === 38 && ps[i + 1] === 2) { st = { ...st, fg: `rgb(${ps[i + 2]},${ps[i + 3]},${ps[i + 4]})` }; i += 4; }
      else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) st = { ...st, fg: `a${p}` };
    }
  }
  push(line.slice(last));
  return runs;
}

// ── runs → SVG ────────────────────────────────────────────────────────
const BOX = new Set('─│┌┐└┘├┤┬┴┼█▓▒░▎▏▊▋▍▌▐');
function fgColor(fg, th) {
  if (!fg) return th.text;
  if (fg.startsWith('rgb')) return fg;
  const map = { a31: th.red, a32: th.green, a33: th.amber, a34: th.accent, a35: th.magenta, a36: th.cyan, a37: th.text, a90: th.muted, a91: th.red, a92: th.green, a93: th.amber, a94: th.accent, a95: th.magenta, a96: th.cyan, a97: th.text, x48: th.green, x196: th.red, x220: th.amber };
  return map[fg] || th.text;
}
function frameToSvg(frame, cols, rows, th, title, desc) {
  const FS = 13.5, CW = +(FS * CHAR_W).toFixed(3), LH = 20, PAD = 18, CHROME = 36;
  const W = Math.round(PAD * 2 + cols * CW), H = Math.round(CHROME + PAD + rows * LH + PAD);
  const lines = frame.split('\n').slice(0, rows);
  const els = [];
  lines.forEach((line, r) => {
    const y = CHROME + PAD + r * LH + FS;
    let col = 0;
    for (const run of parseLine(line)) {
      const x = PAD + col * CW;
      const color = run.dim ? th.dim : fgColor(run.fg, th);
      if (run.inv) {
        els.push(`<rect x="${x.toFixed(2)}" y="${(y - FS - 2).toFixed(2)}" width="${(run.text.length * CW).toFixed(2)}" height="${LH}" fill="${th.accent}"/>`);
      }
      // split the run into text segments and vector glyph segments
      let seg = ''; let segCol = col;
      const flushText = () => {
        if (seg.trim().length) {
          const tx = PAD + segCol * CW;
          els.push(`<text x="${tx.toFixed(2)}" y="${y}" font-size="${FS}" fill="${run.inv ? th.termBg : color}"${run.bold ? ' font-weight="700"' : ''} xml:space="preserve" textLength="${(seg.length * CW).toFixed(2)}" lengthAdjust="spacingAndGlyphs">${esc(seg)}</text>`);
        }
        seg = '';
      };
      for (const ch of run.text) {
        if (BOX.has(ch)) {
          flushText();
          const cx = PAD + col * CW, cy = y - FS + LH / 2 - 2, x2 = cx + CW, top = y - FS - 2, bot = top + LH;
          const s = `stroke="${color}" stroke-width="1.2"`;
          const line = (a, b, c, d) => els.push(`<path d="M${a.toFixed(2)} ${b.toFixed(2)} L${c.toFixed(2)} ${d.toFixed(2)}" ${s}/>`);
          const block = (op, w = CW, off = 0) => els.push(`<rect x="${(cx + off).toFixed(2)}" y="${(top + 3).toFixed(2)}" width="${w.toFixed(2)}" height="${LH - 6}" fill="${color}" opacity="${op}"/>`);
          switch (ch) {
            case '─': line(cx, cy, x2, cy); break;
            case '│': line(cx + CW / 2, top, cx + CW / 2, bot); break;
            case '┌': line(cx + CW / 2, cy, x2, cy); line(cx + CW / 2, cy, cx + CW / 2, bot); break;
            case '┐': line(cx, cy, cx + CW / 2, cy); line(cx + CW / 2, cy, cx + CW / 2, bot); break;
            case '└': line(cx + CW / 2, top, cx + CW / 2, cy); line(cx + CW / 2, cy, x2, cy); break;
            case '┘': line(cx + CW / 2, top, cx + CW / 2, cy); line(cx, cy, cx + CW / 2, cy); break;
            case '├': line(cx + CW / 2, top, cx + CW / 2, bot); line(cx + CW / 2, cy, x2, cy); break;
            case '┤': line(cx + CW / 2, top, cx + CW / 2, bot); line(cx, cy, cx + CW / 2, cy); break;
            case '┬': line(cx, cy, x2, cy); line(cx + CW / 2, cy, cx + CW / 2, bot); break;
            case '┴': line(cx, cy, x2, cy); line(cx + CW / 2, top, cx + CW / 2, cy); break;
            case '┼': line(cx, cy, x2, cy); line(cx + CW / 2, top, cx + CW / 2, bot); break;
            case '█': block(1); break;
            case '▓': block(0.75); break;
            case '▒': block(0.5); break;
            case '░': block(0.22); break;
            case '▊': block(1, CW * 0.75); break;
            case '▋': block(1, CW * 0.6); break;
            case '▌': block(1, CW * 0.5); break;
            case '▍': block(1, CW * 0.4); break;
            case '▎': block(1, CW * 0.25); break;
            case '▏': block(1, CW * 0.12); break;
            case '▐': block(1, CW * 0.5, CW * 0.5); break;
          }
          col++; segCol = col;
        } else {
          if (!seg) segCol = col;
          seg += ch; col++;
        }
      }
      flushText();
    }
  });
  const chrome = windowChrome({ w: W, h: H, chromeH: CHROME, title: title.replace(/^dario — /, ''), right: 'live TUI · fixture data', theme: th });
  return svgDoc({ w: W, h: H, title, desc, body: chrome + '\n' + els.join('\n') });
}

// ── main ──────────────────────────────────────────────────────────────
const { startTuiApp } = await import(pathToFileURL(join(REPO, 'dist', 'tui', 'tui-app.js')).href).catch((e) => {
  console.error(`Cannot load dist/tui/tui-app.js (${e.message}). Run \`npm run build\` first.`);
  process.exit(2);
});
const fixture = await startFixture();
const shots = [
  { tab: 'Analytics', cols: 100, rows: 30, file: 'tui-analytics', desc: 'The dario TUI Analytics tab: requests per minute, tokens in and out, thinking tokens, average latency, subscription percentage, a per-model bar chart, per-account rate-limit bars for the 5-hour and 7-day windows, and a billing breakdown.' },
  { tab: 'Accounts', cols: 100, rows: 20, file: 'tui-accounts', desc: 'The dario TUI Accounts tab: a table of pooled seats with token expiry, 5-hour and 7-day utilization and status.' },
];
mkdirSync(OUT_DIR, { recursive: true });
try {
  for (const s of shots) {
    const frame = await captureTab(startTuiApp, s.tab, s.cols, s.rows);
    if (!frame.trim()) throw new Error(`empty frame for ${s.tab}`);
    for (const th of Object.values(THEMES)) {
      // The TUI is a dark terminal in both page themes; accents follow the theme.
      const t = { ...THEMES.dark, accent: th.accent, name: th.name };
      const svg = frameToSvg(frame, s.cols, s.rows, t, `dario — ${s.tab}`, s.desc);
      const file = join(OUT_DIR, `${s.file}-${th.name}.svg`);
      writeFileSync(file, svg);
      console.log('wrote', file);
    }
  }
} finally {
  await fixture.close();
}
