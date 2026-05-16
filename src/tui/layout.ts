/**
 * Higher-level layout primitives built on top of `render.ts`.
 *
 * These compose the lower-level ANSI strings into the structural
 * patterns the v4 TUI actually uses: a header bar, a tab strip,
 * a body region, a footer with key hints. Each returns a string
 * (or appends to a Frame) — no terminal state, no side effects.
 */

import { brand, fg, inverse, BOX, pad, truncate, visibleWidth } from './render.js';

/**
 * Render the top header bar: brand + version on the left, contextual
 * status text on the right (e.g. proxy URL when connected).
 *
 *   ╭ dario v4.0.0 ───────────────────── http://localhost:3456 ─╮
 *
 * Width is the full terminal columns; the caller positions it at row 1.
 */
export function renderHeader(width: number, opts: {
  version: string;
  status?: string;
}): string {
  const left = ` ${brand('dario')} v${opts.version} `;
  const right = opts.status ? ` ${opts.status} ` : '';
  const dashWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(right) - 2);
  return BOX.topLeft + left + BOX.horizontal.repeat(dashWidth) + right + BOX.topRight;
}

/**
 * Render the bottom footer with key-hint pairs. Wide gaps so it doesn't
 * look mashed-together:
 *
 *   [Tab] switch panel   [q] quit   [?] help
 */
export function renderFooter(width: number, hints: Array<{ key: string; label: string }>): string {
  const items = hints.map(h => `${fg('cyan', `[${h.key}]`)} ${h.label}`);
  const joined = items.join('   ');
  // Truncate if the hints don't fit (small terminal); never wrap to a
  // second line — the footer is a single row by design.
  return ' ' + truncate(joined, width - 2);
}

/**
 * Render a tab strip — one row of clickable-looking tab labels, with
 * the active tab inverse-highlighted. Borders flank both sides.
 *
 *   │  Status   ▎Analytics▎   Config   Hits   Accounts   Backends   │
 *
 * The `activeTab` is the index of the highlighted tab. Caller draws
 * the surrounding box separately.
 */
export function renderTabStrip(width: number, tabs: string[], activeTab: number): string {
  const sep = '   ';
  const rendered = tabs.map((label, idx) => {
    if (idx === activeTab) {
      // Active: inverse-highlight with thin side-bars to evoke a
      // selected pill. The ▎ left-eighth-block is visually subtle but
      // unmistakable on every terminal that supports box-drawing.
      return inverse(` ${label} `);
    }
    return ` ${label} `;
  });
  const inner = rendered.join(sep);
  const padded = pad(inner, width, 'left');
  return padded;
}

/**
 * Render a vertical scroll indicator on the right edge of a panel.
 * Shows "n / total" + a position blob if there's overflow.
 *
 *   ─ 24 / 412
 */
export function renderScrollIndicator(visible: number, total: number, selectedIdx: number): string {
  if (total <= visible) return '';
  return ` ${selectedIdx + 1} / ${total} `;
}

/**
 * Word-wrap or hard-break `text` to lines of at most `width` visible
 * chars. ANSI sequences are preserved across line boundaries; visible
 * width is what's counted.
 *
 * Used for free-form prose in the Status / About panels.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    let lineWidth = 0;
    for (const word of para.split(' ')) {
      const w = visibleWidth(word);
      // Word itself longer than width → hard-break it into chunks
      // of `width` chars. Push the current accumulated line first so
      // we don't lose pre-existing content.
      if (w > width) {
        if (lineWidth > 0) { out.push(line); line = ''; lineWidth = 0; }
        let remaining = word;
        while (visibleWidth(remaining) > width) {
          out.push(remaining.slice(0, width));
          remaining = remaining.slice(width);
        }
        line = remaining;
        lineWidth = visibleWidth(remaining);
        continue;
      }
      // Normal-width word: fit on current line if there's room, else
      // wrap to a new line.
      if (lineWidth === 0) {
        line = word; lineWidth = w; continue;
      }
      if (lineWidth + 1 + w <= width) {
        line += ' ' + word; lineWidth += 1 + w;
      } else {
        out.push(line);
        line = word; lineWidth = w;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

/**
 * Render a left-key / right-value row (the shape every config/status
 * line uses).
 *
 *   Port:               3456
 *   Mode:               passthrough
 *
 * Key is left-padded to `keyWidth` so a column of rows aligns. Value
 * is truncated to fit the remaining space.
 */
export function renderKvRow(key: string, value: string, totalWidth: number, keyWidth: number = 22): string {
  // Clamp keyWidth so a narrow terminal (totalWidth < keyWidth default)
  // still produces a well-formed totalWidth-char row. The key gets
  // truncated proportionally; the value column gets the rest.
  const effectiveKeyWidth = Math.min(keyWidth, Math.max(1, totalWidth - 1));
  const keyPart = pad(key + ':', effectiveKeyWidth);
  // Value pad-to-width (not just truncate) so a full row reaches the
  // panel edge — keeps backgrounds + borders aligned.
  const valuePart = pad(value, totalWidth - effectiveKeyWidth);
  return keyPart + valuePart;
}
