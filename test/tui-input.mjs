#!/usr/bin/env node
// Tests for src/tui/input.ts — the keypress parser.
//
// parseKeys is a pure function over a Buffer chunk → Key[]. Every key
// the TUI cares about is exercised here. The attachKeyHandler lifecycle
// helper is NOT tested at the unit level (it needs a real TTY); M4's
// tab tests will exercise it via integration.

import { parseKeys } from '../dist/tui/input.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// Helper: parse a string as if it arrived on stdin.
const k = (s) => parseKeys(Buffer.from(s, 'binary'));

// ─────────────────────────────────────────────────────────────
header('Printable ASCII');
{
  const result = k('a');
  check('length 1',                     result.length === 1);
  check('name = printable',             result[0].name === 'printable');
  check('ch = "a"',                     result[0].ch === 'a');
  check('ctrl false',                   result[0].ctrl === false);
  check('meta false',                   result[0].meta === false);

  const upper = k('A');
  check('uppercase: shift flag set',    upper[0].shift === true);

  const lower = k('a');
  check('lowercase: shift flag clear',  lower[0].shift === false);

  // Multi-char input (paste)
  const burst = k('hello');
  check('5-char burst → 5 keys',        burst.length === 5);
  check('burst preserves order',        burst.map(r => r.ch).join('') === 'hello');

  // Space is printable
  const space = k(' ');
  check('space is printable',           space[0].name === 'printable' && space[0].ch === ' ');
}

// ─────────────────────────────────────────────────────────────
header('Named control keys');
{
  check('Enter (CR)',                   k('\r')[0].name === 'enter');
  check('Enter (LF)',                   k('\n')[0].name === 'enter');
  check('Tab',                          k('\t')[0].name === 'tab');
  check('Backspace (0x7f)',             k('\x7f')[0].name === 'backspace');
  check('Backspace (0x08)',             k('\x08')[0].name === 'backspace');

  // Standalone Escape (chunk contains ONLY ESC)
  const esc = k('\x1b');
  check('standalone Esc',               esc.length === 1 && esc[0].name === 'escape');
}

// ─────────────────────────────────────────────────────────────
header('Ctrl+letter');
{
  const ctrlC = k('\x03');
  check('Ctrl+C → printable + ctrl',    ctrlC[0].name === 'printable' && ctrlC[0].ch === 'c' && ctrlC[0].ctrl === true);
  const ctrlD = k('\x04');
  check('Ctrl+D',                       ctrlD[0].ctrl && ctrlD[0].ch === 'd');
  const ctrlL = k('\x0c');
  check('Ctrl+L',                       ctrlL[0].ctrl && ctrlL[0].ch === 'l');
  const ctrlZ = k('\x1a');
  check('Ctrl+Z',                       ctrlZ[0].ctrl && ctrlZ[0].ch === 'z');
}

// ─────────────────────────────────────────────────────────────
header('Arrow keys (CSI sequences)');
{
  check('Up    \\x1b[A',                k('\x1b[A')[0].name === 'up');
  check('Down  \\x1b[B',                k('\x1b[B')[0].name === 'down');
  check('Right \\x1b[C',                k('\x1b[C')[0].name === 'right');
  check('Left  \\x1b[D',                k('\x1b[D')[0].name === 'left');

  // SS3 variants (some terminals send these instead of CSI for arrows)
  check('Up    \\x1bOA',                k('\x1bOA')[0].name === 'up');
  check('Right \\x1bOC',                k('\x1bOC')[0].name === 'right');
}

// ─────────────────────────────────────────────────────────────
header('Home / End / PgUp / PgDn / Delete');
{
  check('Home (letter)',                k('\x1b[H')[0].name === 'home');
  check('End (letter)',                 k('\x1b[F')[0].name === 'end');
  check('Home (tilde)',                 k('\x1b[1~')[0].name === 'home');
  check('End (tilde)',                  k('\x1b[4~')[0].name === 'end');
  check('PgUp',                         k('\x1b[5~')[0].name === 'pageup');
  check('PgDn',                         k('\x1b[6~')[0].name === 'pagedown');
  check('Delete',                       k('\x1b[3~')[0].name === 'delete');
}

// ─────────────────────────────────────────────────────────────
header('Modified arrows (Ctrl/Shift/Alt + arrow)');
{
  // ESC[1;5A = Ctrl+Up (modifier mask 5 = Ctrl)
  const ctrlUp = k('\x1b[1;5A');
  check('Ctrl+Up: name = up',           ctrlUp[0].name === 'up');
  check('Ctrl+Up: ctrl flag set',       ctrlUp[0].ctrl === true);

  // ESC[1;2A = Shift+Up
  const shiftUp = k('\x1b[1;2A');
  check('Shift+Up: shift flag set',     shiftUp[0].shift === true);
  check('Shift+Up: ctrl flag clear',    shiftUp[0].ctrl === false);

  // ESC[1;3A = Alt+Up
  const altUp = k('\x1b[1;3A');
  check('Alt+Up: meta flag set',        altUp[0].meta === true);
}

// ─────────────────────────────────────────────────────────────
header('Alt + printable (Meta)');
{
  // ESC + 'a' (no '[') = Alt+a
  const altA = k('\x1ba');
  check('Alt+a: length 1',              altA.length === 1);
  check('Alt+a: meta flag set',         altA[0].meta === true);
  check('Alt+a: ch = "a"',              altA[0].ch === 'a');
}

// ─────────────────────────────────────────────────────────────
header('Mixed chunks (Esc-led sequence + trailing printable)');
{
  // arrow up followed by printable letter — both should come through
  const mixed = k('\x1b[Ax');
  check('mixed: 2 keys',                mixed.length === 2);
  check('mixed[0] = up',                mixed[0].name === 'up');
  check('mixed[1] = printable x',       mixed[1].name === 'printable' && mixed[1].ch === 'x');
}

// ─────────────────────────────────────────────────────────────
header('Unknown sequences passthrough');
{
  // CSI with a final byte that's not in our map → name = 'unknown'
  const weird = k('\x1b[99Z');
  check('weird CSI → unknown',          weird[0].name === 'unknown');
  // Raw byte 0x1e (RS) → unknown
  const rs = k('\x1e');
  check('RS byte → unknown',            rs[0].name === 'unknown');
}

// ─────────────────────────────────────────────────────────────
header('Empty / edge inputs');
{
  check('empty buffer → no keys',       parseKeys(Buffer.from('')).length === 0);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
