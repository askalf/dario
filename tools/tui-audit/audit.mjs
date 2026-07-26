#!/usr/bin/env node
/**
 * Live TUI audit — drives the REAL startTuiApp() through a fake TTY against
 * a local stub proxy, and audits every frame the app actually writes.
 *
 *   npm run build && npm run audit:tui
 *
 * This is not a unit test. It exercises App.start(), raw-mode key parsing,
 * tab mount/unmount, ProxyClient over real sockets and the SSE stream, and
 * captures frames exactly as the terminal would receive them. `test/` has
 * the fast pure-render assertions; this catches what only shows up when the
 * whole loop runs against moving data.
 *
 * Complementary, not redundant — and neither alone is sufficient:
 * this harness found three tabs rendering taller than the terminal, but
 * MISSED progressBar() throwing RangeError on a negative width (Analytics
 * crashed at any width <= 31) because its narrowest geometry was 40 cols.
 * A fixture sweep down to 24x6 in test/tui-frame.mjs caught that instead.
 * Live runs are better evidence for what real data does; fixture sweeps are
 * better for edge geometry. If you extend this, go narrower.
 *
 * Safety: sends navigation keys only (Tab, arrows). Never s/d/r/R/Enter,
 * which would write config or POST /admin/resume.
 *
 * Exit code is 0 unless --strict is passed, in which case any finding fails.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startStub, DEFAULT_PORT } from './stub-proxy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = process.env.TUI_AUDIT_OUT || join(REPO, '.tui-audit');
const STRICT = process.argv.includes('--strict');
const CLEAR = '\x1b[2J\x1b[H';

const GEOMETRIES = [
  [200, 50], [160, 45], [120, 40], [100, 30], [80, 24],
  [70, 20], [60, 18], [55, 16], [45, 14], [40, 12], [32, 10], [24, 8],
];

// ── fake TTY ────────────────────────────────────────────────────────
class FakeStdout extends EventEmitter {
  constructor(cols, rows) { super(); this.columns = cols; this.rows = rows; this.isTTY = true; this.chunks = []; }
  write(s) { this.chunks.push(String(s)); return true; }
  get raw() { return this.chunks.join(''); }
}
class FakeStdin extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.isRaw = false; }
  setRawMode(v) { this.isRaw = v; return this; }
  resume() { return this; }
  pause() { return this; }
  send(seq) { this.emit('data', Buffer.from(seq, 'utf8')); }
}

// ── SGR state machine ───────────────────────────────────────────────
const DEFAULT_SGR = { intensity: 0, underline: 0, inverse: 0, fg: 39, bg: 49 };
function sgrFold(line, start) {
  const st = { ...start };
  for (const m of line.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const ps = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p === 0) Object.assign(st, DEFAULT_SGR);
      else if (p === 1 || p === 2) st.intensity = p;
      else if (p === 22) st.intensity = 0;
      else if (p === 4) st.underline = 4;
      else if (p === 24) st.underline = 0;
      else if (p === 7) st.inverse = 7;
      else if (p === 27) st.inverse = 0;
      else if (p === 38 || p === 48) { const k = p === 38 ? 'fg' : 'bg'; if (ps[i + 1] === 5) { st[k] = p; i += 2; } else if (ps[i + 1] === 2) { st[k] = p; i += 4; } }
      else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) st.fg = p;
      else if (p === 39) st.fg = 39;
      else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) st.bg = p;
      else if (p === 49) st.bg = 49;
    }
  }
  return st;
}
const isDefaultSgr = (st) => JSON.stringify(st) === JSON.stringify(DEFAULT_SGR);
const stripAnsi = (s) => s.replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '');
const vw = (s) => stripAnsi(s).length;

const TAB_NAMES = ['Status', 'Config', 'Analytics', 'Hits', 'Accounts', 'Backends'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runGeometry(cols, rows, startTuiApp, port) {
  const out = new FakeStdout(cols, rows);
  const inp = new FakeStdin();
  const realOut = Object.getOwnPropertyDescriptor(process, 'stdout');
  const realIn = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdout', { value: out, configurable: true });
  Object.defineProperty(process, 'stdin', { value: inp, configurable: true });

  let err = null;
  try {
    const done = startTuiApp({ version: 'audit', proxyUrl: `http://127.0.0.1:${port}` });
    await wait(900);                       // health + models + guard + SSE backlog
    for (let t = 1; t < TAB_NAMES.length; t++) {
      inp.send('\t');
      await wait(400);
      for (let k = 0; k < 4; k++) { inp.send('\x1b[B'); await wait(60); }
      inp.send('\x1b[A'); await wait(60);
    }
    inp.send('\t');
    await wait(350);
    inp.send('\x03');                      // Ctrl-C -> stop
    await Promise.race([done, wait(1500)]);
  } catch (e) {
    err = e;
  } finally {
    Object.defineProperty(process, 'stdout', realOut);
    Object.defineProperty(process, 'stdin', realIn);
  }

  const frames = out.raw.split(CLEAR).slice(1)
    .map((p) => p.replace(/\x1b\[\?1049l\x1b\[\?25h$/, ''));
  return { frames, err };
}

function auditFrame(frame, cols, rows) {
  const lines = frame.split('\n');
  const found = [];
  if (lines.length > rows) found.push({ kind: 'frame-too-tall', detail: `${lines.length} lines > ${rows} rows` });
  let carry = { ...DEFAULT_SGR };
  lines.forEach((line, n) => {
    const w = vw(line);
    if (w > cols) found.push({ kind: 'row-too-wide', detail: `line ${n}: ${w} > ${cols}`, sample: stripAnsi(line).slice(0, 60) });
    carry = sgrFold(line, carry);
    if (!isDefaultSgr(carry)) {
      found.push({ kind: 'sgr-open-at-eol', detail: `line ${n}: ${JSON.stringify(carry)}`, sample: stripAnsi(line).slice(0, 60) });
      carry = { ...DEFAULT_SGR };
    }
  });
  return found;
}

// ── main ────────────────────────────────────────────────────────────
let startTuiApp;
const distEntry = join(REPO, 'dist', 'tui', 'tui-app.js');
try {
  // pathToFileURL, not the bare path: a Windows absolute path (`C:\…`) is
  // not a valid import specifier.
  ({ startTuiApp } = await import(pathToFileURL(distEntry).href));
} catch (e) {
  console.error(`Cannot load ${distEntry}\n  ${e.message}\n  Run \`npm run build\` first.`);
  process.exit(2);
}

const stub = await startStub({ port: Number(process.env.STUB_PORT) || DEFAULT_PORT });
mkdirSync(OUT, { recursive: true });
console.log(`stub proxy on 127.0.0.1:${stub.port}   output -> ${OUT}\n`);

const all = [];
for (const [cols, rows] of GEOMETRIES) {
  const { frames, err } = await runGeometry(cols, rows, startTuiApp, stub.port);
  const byKind = new Map();
  for (const f of frames) {
    for (const finding of auditFrame(f, cols, rows)) {
      const key = finding.kind;
      if (!byKind.has(key)) byKind.set(key, { ...finding, cols, rows, count: 0 });
      byKind.get(key).count++;
    }
  }
  const findings = [...byKind.values()];
  all.push({ cols, rows, frames: frames.length, findings, err: err?.message ?? null });
  if (frames.length) {
    writeFileSync(join(OUT, `frames-${cols}x${rows}.txt`),
      frames.map((f, i) => `\n===== frame ${i} =====\n` + stripAnsi(f)).join(''));
  }
  const n = findings.reduce((a, b) => a + b.count, 0);
  console.log(`${String(cols).padStart(3)}x${String(rows).padEnd(3)}  frames=${String(frames.length).padStart(3)}  findings=${n}${err ? '  ERR ' + err.message : ''}`);
}

await stub.close();

const flat = all.flatMap((g) => g.findings);
console.log('\n================ FINDINGS ================');
if (!flat.length) console.log('none');
const order = { 'row-too-wide': 0, 'frame-too-tall': 1, 'sgr-open-at-eol': 2 };
for (const f of flat.sort((a, b) => (order[a.kind] - order[b.kind]) || (b.cols - a.cols))) {
  console.log(`[${f.kind}] ${f.cols}x${f.rows} (x${f.count})  ${f.detail}`);
  if (f.sample) console.log(`    ${JSON.stringify(f.sample)}`);
}
writeFileSync(join(OUT, 'findings.json'), JSON.stringify(all, null, 2));

process.exit(STRICT && flat.length ? 1 : 0);
