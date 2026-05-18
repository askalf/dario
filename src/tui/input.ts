/**
 * TUI input handling — stdin raw-mode key parser.
 *
 * Why not Node's `readline.emitKeypressEvents`: it works, but the Key
 * shape (`{ name, ctrl, meta, sequence }`) is loosely typed, the
 * legacy event flag is awkward to disable cleanly, and its escape-
 * sequence parser has historically lagged on edge cases (Windows
 * Terminal modifyOtherKeys, Kitty progressive enhancement, etc).
 *
 * Writing ~150 lines that handle the keys we ACTUALLY use is more
 * predictable. The keys we care about:
 *
 *   - Printable ASCII (0x20-0x7e)
 *   - Enter, Tab, Backspace, Escape
 *   - Arrow up/down/left/right
 *   - Home, End, PgUp, PgDn
 *   - Ctrl+C, Ctrl+D (exit), Ctrl+L (redraw)
 *
 * Standalone Esc vs Esc-led sequence (e.g. arrow): we use the same
 * heuristic xterm uses — if ESC arrives in the same buffer chunk as
 * subsequent bytes, treat as a CSI sequence. If ESC arrives alone in
 * a chunk, treat as a standalone Escape keypress. This is reliable
 * on real terminals and avoids the alternative (a wait-timer + lookahead)
 * which adds complexity and a delay every Esc keypress.
 */

export interface Key {
  /** A short name for the key. 'printable' for normal characters. */
  name:
    | 'printable'
    | 'enter'
    | 'tab'
    | 'backspace'
    | 'escape'
    | 'up' | 'down' | 'left' | 'right'
    | 'home' | 'end' | 'pageup' | 'pagedown'
    | 'delete'
    | 'unknown';
  /** The printable character (or the raw sequence for `unknown`). */
  ch: string;
  /** True if a Ctrl modifier was held. */
  ctrl: boolean;
  /** True if a Shift modifier was held (only detectable on some keys). */
  shift: boolean;
  /** True if an Alt/Meta modifier was held. */
  meta: boolean;
}

/**
 * Parse one stdin chunk into zero or more Key events. Pure function;
 * the caller drives stdin and accumulates the result. Most chunks
 * yield exactly one key (interactive typing); paste / IME burst can
 * yield several.
 */
export function parseKeys(chunk: Buffer): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    const b = chunk[i];

    // Backspace: ASCII 0x7f on most terminals, 0x08 (BS / Ctrl+H) on
    // Windows console + a few older ttys. Must check 0x08 BEFORE the
    // Ctrl+letter range below, otherwise BS gets reported as Ctrl+H.
    if (b === 0x7f || b === 0x08) {
      keys.push(k('backspace', ''));
      i++; continue;
    }

    // Control keys (Ctrl+letter): byte 0x01-0x1a (A-Z masked with 0x1f)
    if (b >= 0x01 && b <= 0x1a) {
      // Special-case the named ones that aren't really "Ctrl+letter".
      if (b === 0x09) { keys.push(k('tab', '\t')); i++; continue; }
      if (b === 0x0a || b === 0x0d) { keys.push(k('enter', '\n')); i++; continue; }
      // The rest are Ctrl+A through Ctrl+Z (skipping the named ones).
      keys.push({
        name: 'printable', ch: String.fromCharCode(b + 96), // 1 → 'a'
        ctrl: true, shift: false, meta: false,
      });
      i++; continue;
    }

    // Escape — either standalone or the start of a CSI sequence.
    if (b === 0x1b) {
      // Look at what follows in this same chunk
      if (i + 1 >= chunk.length) {
        // ESC alone in this chunk → standalone Escape keypress.
        keys.push(k('escape', ''));
        i++; continue;
      }
      // ESC + '[' → CSI sequence. Read up to the terminating byte
      // (0x40-0x7e per ECMA-48).
      if (chunk[i + 1] === 0x5b /* '[' */ || chunk[i + 1] === 0x4f /* 'O' for SS3 */) {
        const seqStart = i;
        const ss3 = chunk[i + 1] === 0x4f;
        i += 2;
        let paramBytes = '';
        while (i < chunk.length) {
          const c = chunk[i];
          if (c >= 0x40 && c <= 0x7e) {
            const final = String.fromCharCode(c);
            i++;
            keys.push(parseCsi(final, paramBytes, ss3, chunk.slice(seqStart, i)));
            break;
          }
          paramBytes += String.fromCharCode(c);
          i++;
        }
        continue;
      }
      // ESC + other byte → Alt/Meta + that byte
      const next = chunk[i + 1];
      if (next >= 0x20 && next <= 0x7e) {
        keys.push({
          name: 'printable', ch: String.fromCharCode(next),
          ctrl: false, shift: false, meta: true,
        });
        i += 2; continue;
      }
      // Fallback — emit ESC alone, advance one.
      keys.push(k('escape', ''));
      i++; continue;
    }

    // Printable ASCII (including space)
    if (b >= 0x20 && b <= 0x7e) {
      keys.push({
        name: 'printable', ch: String.fromCharCode(b),
        ctrl: false, shift: b >= 0x41 && b <= 0x5a, meta: false,
      });
      i++; continue;
    }

    // Anything else — pass through as unknown so the caller can see it.
    keys.push({ name: 'unknown', ch: String.fromCharCode(b), ctrl: false, shift: false, meta: false });
    i++;
  }
  return keys;
}

function k(name: Key['name'], ch: string): Key {
  return { name, ch, ctrl: false, shift: false, meta: false };
}

/**
 * Decode the body of a CSI sequence given the terminating byte and
 * the parameter bytes between `[` and the terminator.
 *
 *   ESC[A    → up
 *   ESC[B    → down
 *   ESC[C    → right
 *   ESC[D    → left
 *   ESC[H    → home
 *   ESC[F    → end
 *   ESC[5~   → pageup
 *   ESC[6~   → pagedown
 *   ESC[3~   → delete
 *   ESC[1~   → home (alternate)
 *   ESC[4~   → end (alternate)
 *
 * Modifier-bearing variants (e.g. `ESC[1;5A` for Ctrl-Up) parse the
 * second parameter as a modifier mask: bit 0 = Shift, bit 1 = Alt,
 * bit 2 = Ctrl. xterm spec §"Modifier-Encoding".
 */
function parseCsi(final: string, params: string, ss3: boolean, raw: Buffer): Key {
  // Parse semicolon-separated numeric params
  const parts = params.split(';').map(p => parseInt(p, 10) || 0);
  // Modifier byte is the second param when present.
  const mod = parts[1] ?? 1;
  const ctrl = (mod - 1) & 4 ? true : false;
  const shift = (mod - 1) & 1 ? true : false;
  const meta = (mod - 1) & 2 ? true : false;

  // Tilde-terminated: ESC[<n>~ where n is in parts[0]
  if (final === '~') {
    const n = parts[0];
    const map: Record<number, Key['name']> = {
      1: 'home', 2: 'home', 3: 'delete', 4: 'end',
      5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end',
    };
    return { name: map[n] ?? 'unknown', ch: raw.toString(), ctrl, shift, meta };
  }

  // Letter-terminated: arrow / home / end (and SS3 variants)
  void ss3;
  const letterMap: Record<string, Key['name']> = {
    A: 'up', B: 'down', C: 'right', D: 'left',
    H: 'home', F: 'end',
  };
  if (letterMap[final]) {
    return { name: letterMap[final], ch: raw.toString(), ctrl, shift, meta };
  }
  return { name: 'unknown', ch: raw.toString(), ctrl, shift, meta };
}

// ── Lifecycle helpers ──────────────────────────────────────────────

/**
 * Put stdin into raw mode and start emitting Key events to `handler`.
 * Returns a cleanup function that restores stdin's pre-raw mode and
 * unbinds the listener. ALWAYS call the cleanup on exit (including
 * abnormal exits — wire a process exit / signal hook).
 *
 * Defaults are picked so the caller doesn't have to think about them:
 * UTF-8 encoding (we don't see Buffer chunks split mid-character),
 * resume() so paused stdin doesn't drop key events.
 *
 * Throws if stdin isn't a TTY — the TUI doesn't make sense in a pipe.
 */
export function attachKeyHandler(
  stdin: NodeJS.ReadStream,
  handler: (key: Key) => void,
): () => void {
  if (!stdin.isTTY) {
    throw new Error('TUI requires a TTY on stdin — pipe / redirect not supported');
  }
  const prevRawMode = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  const onData = (chunk: Buffer) => {
    for (const key of parseKeys(chunk)) handler(key);
  };
  stdin.on('data', onData);
  return () => {
    stdin.off('data', onData);
    stdin.setRawMode(prevRawMode ?? false);
    stdin.pause();
  };
}
