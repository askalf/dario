#!/usr/bin/env node
/**
 * test/cli-help.mjs
 *
 * `dario --help` printed 635 lines with the Quick start at line 619, so a first run scrolled past
 * everything it needed. The default is now one screen; `--help --all` keeps the full reference.
 *
 * Covers the pure selector, the short text's shape (it fits a terminal, names both plans, every
 * command it shows exists and is in the full reference, it points at --all), and two spawned runs.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FULL_HELP, SHORT_HELP, helpText } from '../dist/cli.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); fail++; }
};

const lines = SHORT_HELP.split('\n');
check('the short help fits one screen (at most 25 lines)', lines.length <= 25, `${lines.length} lines`);
check('no line is wider than 80 columns', lines.every((l) => l.length <= 80), lines.find((l) => l.length > 80));
check('its title names both plans', /Claude or ChatGPT subscription/.test(lines.find((l) => l.trim()) ?? ''));
check('the full reference has the same title', /^\n  dario: use your Claude or ChatGPT subscription as an API\.\n/.test(FULL_HELP));
check('it ends by pointing at the full reference', SHORT_HELP.includes('dario --help --all'));
check('it carries the start: login, proxy, the ChatGPT seat, and the two base URLs',
  ['dario login --no-proxy', 'dario proxy', 'dario add altman', 'ANTHROPIC_BASE_URL=http://localhost:3456', 'OPENAI_BASE_URL=http://localhost:3456/v1'].every((s) => SHORT_HELP.includes(s)));

// Every `dario <command>` the short help shows is a command the full reference documents.
const shown = [...SHORT_HELP.matchAll(/^ {4}dario ([a-z]+)/gm)].map((m) => m[1]);
check('every command it shows is in the full reference', shown.length >= 6 && shown.every((c) => new RegExp(`^ {4}dario ${c}\\b`, 'm').test(FULL_HELP)), shown.join(' '));
check('the full reference is still the long one', FULL_HELP.split('\n').length > 400 && FULL_HELP.includes('Quick start:'));

check('--all selects the full reference, anything else the short one',
  helpText(['--help', '--all']) === FULL_HELP && helpText(['help', '--all']) === FULL_HELP
  && helpText(['--help']) === SHORT_HELP && helpText(['-h']) === SHORT_HELP && helpText([]) === SHORT_HELP);

// Spawned, against a scratch HOME so no real login is read.
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'dario-help-'));
const run = (...a) => spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 30000 });
const short = run('--help');
check('dario --help prints the short help and exits 0', short.status === 0 && short.stdout.trim() === SHORT_HELP.trim(), short.stderr.slice(0, 200));
const all = run('--help', '--all');
check('dario --help --all prints the full reference and exits 0', all.status === 0 && all.stdout.trim() === FULL_HELP.trim(), all.stderr.slice(0, 200));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
