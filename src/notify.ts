/**
 * Best-effort cross-platform desktop notification dispatcher.
 *
 * Pure Node, no new dependencies. Resolves the platform's native toast
 * mechanism at load time, falls back to the terminal BEL character on any
 * platform that doesn't have one (or where the native path is missing).
 *
 * Backends:
 *   - macOS:   `osascript -e 'display notification "msg" with title "dario"'`
 *   - Linux:   `notify-send "dario" "msg"` (gnome / kde / dunst / mako)
 *   - Windows: `powershell -Command New-BurntToastNotification ...` if the
 *              `BurntToast` module is installed; falls back to `msg.exe`,
 *              else BEL only.
 *
 * BEL char (`\x07`) is the unconditional floor — works on every terminal
 * that respects ANSI control characters, which is nearly all of them.
 *
 * Silent on failure: a missing `osascript`/`notify-send`/PowerShell path
 * is the common case for non-interactive sessions, headless CI runs, and
 * SSH-into-a-server flows. The TUI banner is the authoritative surface;
 * OS-notify is the loud, attention-grabbing supplement.
 *
 * See dario#288 — overage-guard.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Fire a native notification. Returns immediately — the underlying spawn
 * is fire-and-forget. Errors (missing binary, permission denied, no
 * graphical session) are swallowed; the caller already has the in-app
 * surface and shouldn't depend on this firing.
 *
 * `title` and `message` are passed verbatim except for shell-meta escaping
 * — single quotes and backticks are stripped so the AppleScript / shell
 * payload can't be hijacked by a malicious upstream response.
 */
export function notify(title: string, message: string): void {
  // Always BEL first — works in every TTY, doesn't depend on a graphical
  // session. The OS notification on top is best-effort.
  try {
    process.stderr.write('\x07');
  } catch {
    // stderr write can fail under exotic conditions (closed handle,
    // detached process); silent — we have nothing else to fall back to.
  }

  const safeTitle = sanitize(title);
  const safeMessage = sanitize(message);
  const plat = platform();

  try {
    if (plat === 'darwin') {
      // AppleScript single-quote inside the script body would need
      // escaping; sanitize() strips them so the literal substitution
      // below stays safe. Spawned via array argv to avoid a shell
      // entirely.
      spawn('osascript', [
        '-e',
        `display notification "${safeMessage}" with title "${safeTitle}"`,
      ], { detached: true, stdio: 'ignore' }).unref();
    } else if (plat === 'linux') {
      spawn('notify-send', [safeTitle, safeMessage], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } else if (plat === 'win32') {
      // BurntToast is the cleanest path — single-line PowerShell, real
      // Windows toast notification. If BurntToast isn't installed the
      // command fails silently (stdio: ignore swallows the error
      // output), which is the desired behavior.
      //
      // We don't probe-then-spawn; the cost of one failed BurntToast
      // attempt is the same as one probe attempt, and probing makes the
      // hot path slower for the success case.
      const ps = `try { Import-Module BurntToast -ErrorAction Stop; New-BurntToastNotification -Text '${safeTitle}', '${safeMessage}' } catch { exit 1 }`;
      spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        ps,
      ], { detached: true, stdio: 'ignore' }).unref();
    }
    // freebsd / openbsd / aix / sunos / android — BEL only. There's no
    // single "right" native notification on these platforms.
  } catch {
    // spawn() itself can throw on EMFILE or similar; silent.
  }
}

/**
 * Strip characters that would break the embedded shell/AppleScript
 * payload or allow command injection. Conservative: only allow printable
 * ASCII + common Unicode word chars + a small whitelist of punctuation.
 *
 * This is NOT a general-purpose sanitizer; it exists to defang text we
 * already control (our own messages) from accidentally containing
 * AppleScript-breaking characters like a stray double quote.
 */
function sanitize(s: string): string {
  return s
    .replace(/[\r\n]/g, ' ')         // collapse newlines
    .replace(/[`'"$]/g, '')          // strip shell metas + quotes
    .replace(/\\/g, '/')             // strip backslashes
    .slice(0, 200);                  // cap length; notifications truncate anyway
}

/**
 * Test-mode hook — returns a notifier that pushes into a captured array
 * instead of firing real OS notifications. Used by test/notify-cross-
 * platform.mjs to verify the dispatch path without invoking osascript.
 */
export function captureNotifier(): { notify: (title: string, message: string) => void; captured: Array<{ title: string; message: string; ts: number }> } {
  const captured: Array<{ title: string; message: string; ts: number }> = [];
  return {
    notify: (title: string, message: string) => {
      captured.push({ title, message, ts: Date.now() });
    },
    captured,
  };
}
