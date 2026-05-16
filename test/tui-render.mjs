#!/usr/bin/env node
// Tests for src/tui/render.ts — the ANSI primitives.
//
// Every function in render.ts is pure (no terminal state, no side
// effects), so the test surface is straightforward string equality.
//
// Coverage:
//   - ANSI cursor + screen primitives produce well-formed sequences
//   - Color helpers wrap text in matching open/close codes
//   - visibleWidth strips escapes
//   - truncate respects visible chars, preserves embedded ANSI
//   - pad fills correctly with each alignment
//   - progressBar maps value→cells correctly at boundaries
//   - drawBox produces correct corners + sides at small + large sizes
//   - Frame accumulates + flushes correctly

import {
  moveTo, hideCursor, showCursor, enterAltScreen, leaveAltScreen,
  clearScreen, reset, fg, bg, bold, dim, inverse, brand,
  visibleWidth, truncate, pad, progressBar, drawBox, BOX, Frame,
} from '../dist/tui/render.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  OK ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
}
function header(n) { console.log(`\n=== ${n} ===`); }

const ESC = '\x1b[';

// ─────────────────────────────────────────────────────────────
header('ANSI cursor + screen primitives');
{
  check('moveTo(5, 10) is well-formed', moveTo(5, 10) === `${ESC}5;10H`);
  check('moveTo(1, 1) is well-formed',  moveTo(1, 1)  === `${ESC}1;1H`);
  check('hideCursor present',           hideCursor === `${ESC}?25l`);
  check('showCursor present',           showCursor === `${ESC}?25h`);
  check('enterAltScreen',               enterAltScreen === `${ESC}?1049h`);
  check('leaveAltScreen',               leaveAltScreen === `${ESC}?1049l`);
  check('clearScreen + home',           clearScreen.endsWith(`${ESC}H`));
  check('reset',                        reset === `${ESC}0m`);
}

// ─────────────────────────────────────────────────────────────
header('Color + style wrappers');
{
  check('fg(green) wraps',              fg('green', 'OK') === `${ESC}32mOK${ESC}39m`);
  check('fg(red) wraps',                fg('red', 'NO') === `${ESC}31mNO${ESC}39m`);
  check('bg(blue) wraps',               bg('blue', 'x') === `${ESC}44mx${ESC}49m`);
  check('bold wraps',                   bold('x') === `${ESC}1mx${ESC}22m`);
  check('dim wraps',                    dim('x') === `${ESC}2mx${ESC}22m`);
  check('inverse wraps',                inverse('x') === `${ESC}7mx${ESC}27m`);
  check('brand uses 256-color 48',      brand('x') === `${ESC}38;5;48mx${ESC}39m`);

  // Color resets to default fg, not previous color — verifies no
  // "previous color" leakage between consecutive wraps.
  const combined = fg('green', 'A') + fg('red', 'B');
  check('consecutive colors reset cleanly',
    combined === `${ESC}32mA${ESC}39m${ESC}31mB${ESC}39m`);
}

// ─────────────────────────────────────────────────────────────
header('visibleWidth — ANSI-stripping length');
{
  check('plain ASCII',                  visibleWidth('hello') === 5);
  check('empty',                        visibleWidth('') === 0);
  check('color-wrapped',                visibleWidth(fg('green', 'hello')) === 5);
  check('multiple escapes',             visibleWidth(`${ESC}1m${ESC}32mhello${ESC}0m`) === 5);
  check('embedded cursor moves',        visibleWidth(`hello${moveTo(1,1)}world`) === 10);
}

// ─────────────────────────────────────────────────────────────
header('truncate — respect visible width + ANSI safety');
{
  check('short string passes through',  truncate('hi', 10) === 'hi');
  check('exact fit passes through',     truncate('hello', 5) === 'hello');
  check('clips with ellipsis',          truncate('hello world', 8) === 'hello w…');
  check('clips at boundary',            truncate('abcdef', 3) === 'ab…');
  check('maxWidth 0 → empty',           truncate('x', 0) === '');
  check('maxWidth 1 → just ellipsis',   truncate('hello', 1) === '…');
  // ANSI escapes inside the string don't count toward visible width
  const colored = `${ESC}32mhello world${ESC}39m`;
  const out = truncate(colored, 8);
  check('truncated keeps opening escape', out.startsWith(`${ESC}32m`));
  check('truncated visible width = 8',    visibleWidth(out) === 8);
}

// ─────────────────────────────────────────────────────────────
header('pad — alignment fills correctly');
{
  check('left align (default)',         pad('hi', 6) === 'hi    ');
  check('left align explicit',          pad('hi', 6, 'left') === 'hi    ');
  check('right align',                  pad('hi', 6, 'right') === '    hi');
  check('center align even',            pad('hi', 6, 'center') === '  hi  ');
  check('center align odd',             pad('hi', 7, 'center') === '  hi   ');
  check('already-wide truncates',       pad('hello', 3) === 'he…');
  check('exact width unchanged',        pad('hello', 5) === 'hello');
}

// ─────────────────────────────────────────────────────────────
header('progressBar — value → cells');
{
  check('0% → all empty',               progressBar(0, 10) === '░░░░░░░░░░');
  check('100% → all filled',            progressBar(1, 10) === '██████████');
  check('50% → half',                   progressBar(0.5, 10) === '█████░░░░░');
  check('clamps negative to 0',         progressBar(-0.5, 10) === '░░░░░░░░░░');
  check('clamps above 1 to full',       progressBar(1.5, 10) === '██████████');
  check('rounds 0.07 to 1 cell',        progressBar(0.07, 10) === '█░░░░░░░░░');
  // Custom characters
  check('custom filled/empty chars',    progressBar(0.5, 4, { filled: '=', empty: '-' }) === '==--');
}

// ─────────────────────────────────────────────────────────────
header('drawBox — corners + sides');
{
  // Minimum 2x2 — just corners
  const b2 = drawBox(1, 1, 2, 2);
  check('2x2 has both corners',         b2.includes(BOX.topLeft) && b2.includes(BOX.bottomRight));

  // 5x3 — full borders
  const b5 = drawBox(1, 1, 5, 3);
  check('5x3 top border',               b5.includes(BOX.topLeft + BOX.horizontal.repeat(3) + BOX.topRight));
  check('5x3 bottom border',            b5.includes(BOX.bottomLeft + BOX.horizontal.repeat(3) + BOX.bottomRight));

  // Width 1 or height 1 → empty (degenerate)
  check('width 1 returns empty',        drawBox(1, 1, 1, 5) === '');
  check('height 1 returns empty',       drawBox(1, 1, 5, 1) === '');
}

// ─────────────────────────────────────────────────────────────
header('Frame — buffer accumulator');
{
  const f = new Frame();
  check('empty frame',                  f.toString() === '');
  check('length 0',                     f.length === 0);
  f.write('hello');
  f.write(' world');
  check('accumulated chunks',           f.toString() === 'hello world');
  check('length 2',                     f.length === 2);
  f.writeAt(5, 10, 'x');
  check('writeAt prefixes with moveTo', f.toString().endsWith(`${moveTo(5, 10)}x`));
  f.clear();
  check('clear empties',                f.toString() === '');
  check('clear resets length',          f.length === 0);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
