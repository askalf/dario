/**
 * Panel fitting — let a tab spend its row budget deliberately instead of
 * rendering everything and being clipped from the bottom.
 *
 * Background (#862, #866, #868): tabs used to push every panel
 * unconditionally. `renderTui` clips an over-long body so the header and
 * tab strip survive, but clipping is dumb — it drops whatever happens to
 * sort last. On the Status tab that was the Overage-guard panel, so the
 * one tab that tells you the proxy has HALTED hid that fact first, on a
 * default 80x24 terminal.
 *
 * The fix is for each tab to decide what to give up. A panel declares:
 *
 *   - `lines`      full rendering
 *   - `collapsed`  a shorter stand-in (typically one summary row)
 *   - `priority`   lower = more important; drives what degrades first
 *   - `required`   never drop entirely, even if it doesn't fit
 *
 * `fitPanels` keeps DISPLAY order (the order given) and uses priority
 * only to choose what degrades. Users navigate by position, so reordering
 * panels under pressure would be its own kind of surprise.
 */

export interface Panel {
  /** Full rendering, including the panel's own trailing blank line if it wants one. */
  lines: string[];
  /** Shorter stand-in used when the full form doesn't fit. */
  collapsed?: string[];
  /** Lower = more important. Least important degrades first. */
  priority: number;
  /** Never dropped entirely (it may still be collapsed). */
  required?: boolean;
}

const size = (p: Panel, isCollapsed: boolean): number =>
  (isCollapsed && p.collapsed ? p.collapsed : p.lines).length;

/**
 * Fit `panels` into `budget` rows.
 *
 * Degrades in two passes, least-important first: collapse everything that
 * offers a `collapsed` form, then drop whole panels that aren't
 * `required`. Returns the flattened lines in the original display order.
 *
 * If even the required panels overflow, the result is still returned
 * over-budget — `renderTui`'s clamp is the final floor, and returning a
 * truncated required panel here would hide the very thing marked
 * essential.
 */
export function fitPanels(panels: Panel[], budget: number): string[] {
  const collapsed = new Set<number>();
  const dropped = new Set<number>();

  const total = () => panels.reduce(
    (n, p, i) => n + (dropped.has(i) ? 0 : size(p, collapsed.has(i))), 0);

  // Least important first — ties broken by later position, so a trailing
  // panel degrades before an equally-ranked one above it.
  const byLeastImportant = panels
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.priority - a.p.priority) || (b.i - a.i));

  for (const { p, i } of byLeastImportant) {
    if (total() <= budget) break;
    if (p.collapsed && p.collapsed.length < p.lines.length) collapsed.add(i);
  }
  for (const { p, i } of byLeastImportant) {
    if (total() <= budget) break;
    if (!p.required) dropped.add(i);
  }

  const out: string[] = [];
  panels.forEach((p, i) => {
    if (dropped.has(i)) return;
    out.push(...(collapsed.has(i) && p.collapsed ? p.collapsed : p.lines));
  });
  return out;
}
