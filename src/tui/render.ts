/**
 * TUI rendering primitives — pure ANSI escape sequence helpers.
 *
 * Every function in this module is a pure string-returning helper. No
 * side effects, no console writes. The App's render() loop accumulates
 * these strings into a single buffer, then flushes once to stdout. This
 * keeps render testable (assert string equality against fixtures) and
 * keeps flicker minimal (single write call per frame).
 *
 * Color set: a deliberate 16-color subset of the ANSI palette plus a
 * handful of 256-color brand accents. Reasoning: 16-color is universal,
 * the brand greens (#00ff88-ish) are used sparingly for the dario
 * accent and degrade gracefully on terminals that can't render them.
 *
 * What this module deliberately does NOT do:
 *   - Track cursor position (callers pass row/col explicitly)
 *   - Diff frames (full-screen redraw per frame is fast enough at
 *     ~3000 cells; complexity not worth it)
 *   - Handle terminal capabilities probing (use ANSI + assume modern)
 */

// ── Escape sequences ────────────────────────────────────────────────

/** Control Sequence Introducer. */
const ESC = '\x1b[';

/**
 * Move the cursor to (row, col). 1-indexed, matching the ANSI spec —
 * row=1 is the top line, col=1 is the leftmost column.
 */
export function moveTo(row: number, col: number): string {
  return `${ESC}${row};${col}H`;
}

/** Hide the blinking cursor (TUI doesn't need it). */
export const hideCursor = `${ESC}?25l`;

/** Restore the cursor. ALWAYS run on exit to leave the terminal sane. */
export const showCursor = `${ESC}?25h`;

/** Enter the alternate screen buffer — TUI lives here so quit restores prior shell content. */
export const enterAltScreen = `${ESC}?1049h`;

/** Leave the alternate screen buffer. Pair with enterAltScreen on exit. */
export const leaveAltScreen = `${ESC}?1049l`;

/** Clear the entire screen and move cursor to home. */
export const clearScreen = `${ESC}2J${ESC}H`;

/** Clear from cursor to end of line. */
export const clearLineRight = `${ESC}K`;

/** Reset all SGR (color + style) attributes. */
export const reset = `${ESC}0m`;

// ── Colors (16-color ANSI + brand accent) ──────────────────────────

/**
 * Foreground color names mapped to ANSI codes. `default` resets to
 * the terminal's default foreground.
 */
export const FG = {
  default: 39,
  black: 30, red: 31, green: 32, yellow: 33,
  blue: 34, magenta: 35, cyan: 36, white: 37,
  brightBlack: 90, brightRed: 91, brightGreen: 92, brightYellow: 93,
  brightBlue: 94, brightMagenta: 95, brightCyan: 96, brightWhite: 97,
} as const;

/** Background color names mapped to ANSI codes. */
export const BG = {
  default: 49,
  black: 40, red: 41, green: 42, yellow: 43,
  blue: 44, magenta: 45, cyan: 46, white: 47,
  brightBlack: 100, brightRed: 101, brightGreen: 102, brightYellow: 103,
  brightBlue: 104, brightMagenta: 105, brightCyan: 106, brightWhite: 107,
} as const;

export type FgColor = keyof typeof FG;
export type BgColor = keyof typeof BG;

/**
 * Wrap text in foreground-color SGR codes. Resets to default fg at
 * the end so subsequent uncolored text isn't accidentally colored.
 *
 * Example: `fg('green', 'OK')` → `\x1b[32mOK\x1b[39m`
 */
export function fg(color: FgColor, text: string): string {
  return `${ESC}${FG[color]}m${text}${ESC}${FG.default}m`;
}

export function bg(color: BgColor, text: string): string {
  return `${ESC}${BG[color]}m${text}${ESC}${BG.default}m`;
}

export function bold(text: string): string {
  return `${ESC}1m${text}${ESC}22m`;
}

export function dim(text: string): string {
  return `${ESC}2m${text}${ESC}22m`;
}

export function inverse(text: string): string {
  return `${ESC}7m${text}${ESC}27m`;
}

export function underline(text: string): string {
  return `${ESC}4m${text}${ESC}24m`;
}

/**
 * Brand accent — the askalf green (#00ff88-ish) via the 256-color
 * palette index 48. Falls back gracefully on terminals that don't
 * render 256-color (they show as bright green).
 */
export function brand(text: string): string {
  return `${ESC}38;5;48m${text}${ESC}${FG.default}m`;
}

// ── String helpers ─────────────────────────────────────────────────

/**
 * Visible-width of a string. ANSI escape sequences and zero-width
 * sequences contribute 0. Tabs count as 1 (terminals vary; better
 * to under- than over-estimate). Multi-byte characters (CJK, emoji)
 * are NOT special-cased in v4.0 — the TUI's content is ASCII-dominant
 * (model names, numbers, labels). A future revision can add a
 * `string-width`-style lookup if non-ASCII becomes common.
 */
export function visibleWidth(s: string): number {
  // Strip ANSI escape sequences (CSI + everything up to terminating byte).
  const stripped = s.replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '');
  return stripped.length;
}

/**
 * Truncate `text` to at most `maxWidth` visible chars, appending `…`
 * if anything was clipped. ANSI sequences within the truncated portion
 * are preserved verbatim; truncation only counts visible characters.
 *
 * Example: truncate('hello world', 8) → 'hello w…'
 */
export function truncate(text: string, maxWidth: number, ellipsis: string = '…'): string {
  if (maxWidth <= 0) return '';
  if (visibleWidth(text) <= maxWidth) return text;
  const ellipsisWidth = visibleWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) return ellipsis.slice(0, maxWidth);
  // Walk the string, counting visible chars, stop when we'd exceed
  // maxWidth - ellipsisWidth so we have room to append.
  const target = maxWidth - ellipsisWidth;
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < text.length && visible < target) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      // Copy the full escape sequence
      const m = text.slice(i).match(/^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += text[i];
    visible++;
    i++;
  }
  return out + ellipsis;
}

/** Pad `text` (right-aligned by default 'left' fills right side) to `width`. */
export function pad(text: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const w = visibleWidth(text);
  if (w >= width) return truncate(text, width);
  const gap = width - w;
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    const right = gap - left;
    return ' '.repeat(left) + text + ' '.repeat(right);
  }
  return text + ' '.repeat(gap);
}

/**
 * Render a horizontal progress bar.
 *
 *   value:   0..1 (clamped)
 *   width:   total cell count of the bar
 *
 * Uses the full-block ▓ / shade ░ characters; passes through as plain
 * ASCII on terminals that don't render the box-drawing set (they look
 * like `?` but the layout still works).
 */
export function progressBar(value: number, width: number, opts: { filled?: string; empty?: string } = {}): string {
  const filled = opts.filled ?? '█';
  const empty = opts.empty ?? '░';
  const clamped = Math.max(0, Math.min(1, value));
  const cells = Math.round(clamped * width);
  return filled.repeat(cells) + empty.repeat(width - cells);
}

/**
 * Box-drawing characters for borders. Set picked to render well on
 * most terminals (Unicode box-drawing). Override via `customChars` if
 * a terminal renders these badly — but the default targets the
 * 99%-of-users case.
 */
export const BOX = {
  topLeft: '┌',  topRight: '┐',
  bottomLeft: '└', bottomRight: '┘',
  horizontal: '─', vertical: '│',
  cross: '┼', tLeft: '├', tRight: '┤',
  tTop: '┬', tBottom: '┴',
} as const;

/**
 * Render a box at (row, col) with the given width and height. Returns
 * the full ANSI string (positioned writes + box characters). The
 * interior is NOT cleared — callers paint inside the box separately.
 */
export function drawBox(row: number, col: number, width: number, height: number): string {
  if (width < 2 || height < 2) return '';
  const out: string[] = [];
  // Top border
  out.push(moveTo(row, col));
  out.push(BOX.topLeft + BOX.horizontal.repeat(width - 2) + BOX.topRight);
  // Sides
  for (let r = 1; r < height - 1; r++) {
    out.push(moveTo(row + r, col));
    out.push(BOX.vertical);
    out.push(moveTo(row + r, col + width - 1));
    out.push(BOX.vertical);
  }
  // Bottom border
  out.push(moveTo(row + height - 1, col));
  out.push(BOX.bottomLeft + BOX.horizontal.repeat(width - 2) + BOX.bottomRight);
  return out.join('');
}

// ── Frame buffer ───────────────────────────────────────────────────

/**
 * Frame builder. The App's render() collects strings into one of these
 * then calls `flush(stdout)` for a single write. Single-write rendering
 * eliminates flicker on most terminals.
 */
export class Frame {
  private chunks: string[] = [];

  /** Append a string. No positioning — caller is responsible. */
  write(s: string): void {
    this.chunks.push(s);
  }

  /** Append a positioned write at (row, col). */
  writeAt(row: number, col: number, s: string): void {
    this.chunks.push(moveTo(row, col));
    this.chunks.push(s);
  }

  /** Return the accumulated frame as a single string. */
  toString(): string {
    return this.chunks.join('');
  }

  /** Number of accumulated chunks (debugging aid). */
  get length(): number {
    return this.chunks.length;
  }

  /** Drop everything. Reuses the array allocation. */
  clear(): void {
    this.chunks.length = 0;
  }
}
