#!/usr/bin/env node
// Renders .github/readme/dashboard-{dark,light}.png from the real dashboard:
// dist/analytics-ui.html opened from disk, which runs on its own sample data
// (the page decides by protocol, so no proxy is needed). Headless Chrome with
// a fresh profile in a temp dir, 1440x1150, the theme forced through the
// data-theme attribute on <html>, the same attribute the page's toggle sets.
// Needs `npm run build` first and a Chrome; DARIO_CHROME points at one when
// it is not in a usual place. Not part of `npm run readme:assets`, which
// stays Chrome-free.
//
//   node scripts/readme/dashboard.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, '.github', 'readme');
const CANDIDATES = [
  process.env.DARIO_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('no Chrome found; set DARIO_CHROME to one');
  process.exit(2);
}
const page = join(ROOT, 'dist', 'analytics-ui.html');
if (!existsSync(page)) {
  console.error('dist/analytics-ui.html is missing; run npm run build first');
  process.exit(2);
}
const html = readFileSync(page, 'utf8');
if (!html.includes('<html lang="en">')) throw new Error('the page has no <html lang="en"> to set the theme on');

const work = mkdtempSync(join(tmpdir(), 'dario-dashboard-'));
try {
  for (const theme of ['dark', 'light']) {
    const src = join(work, `${theme}.html`);
    writeFileSync(src, html.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`));
    const out = join(OUT, `dashboard-${theme}.png`);
    const r = spawnSync(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      `--user-data-dir=${join(work, 'profile')}`,
      '--virtual-time-budget=6000', '--window-size=1440,1150',
      `--screenshot=${out}`, pathToFileURL(src).href,
    ], { stdio: 'ignore' });
    if (r.status !== 0 || !existsSync(out)) {
      console.error(`chrome did not write the ${theme} screenshot (exit ${r.status})`);
      process.exit(1);
    }
    console.log(`wrote ${out}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
