/**
 * Config tab — view + edit the persistent ~/.dario/config.json.
 *
 * Renders a flat list of editable fields. Each field has a typed
 * editor: bool toggles inline, numbers / strings open an input prompt
 * at the bottom of the panel.
 *
 * Keys:
 *   ↑↓        navigate
 *   Enter     edit (bool: toggle; number/string: open input)
 *   Esc       cancel input
 *   s         save → write ~/.dario/config.json
 *   d         discard local changes
 *   r         reload from disk
 *
 * Coverage in v4.0: port, host, stealth, pacing/thinkTime/sessionStart
 * sub-knobs, drainOnClose. Additional fields (preserveTools, mergeTools,
 * etc.) can follow the same FieldDef pattern in v4.x without API
 * change. The DarioConfig schema is the source of truth — adding a
 * field there + a row here lights it up.
 */

import type { Tab } from '../tab.js';
import { fg, dim, brand, inverse, pad } from '../render.js';
import {
  CONFIG_SCHEMA_VERSION,
  defaultConfig,
  loadConfig,
  saveConfig,
  type DarioConfig,
} from '../../config-file.js';

type FieldType = 'bool' | 'number' | 'string';

interface FieldDef {
  /** Dotted path into DarioConfig (e.g. 'pacing.minMs'). */
  path: string;
  label: string;
  type: FieldType;
  /** Short hint shown to the right of the value. */
  hint?: string;
}

/**
 * The visible field registry. Order = display order. New fields just
 * append; the tab grows automatically. Path → DarioConfig is dotted.
 */
const FIELDS: FieldDef[] = [
  { path: 'port',                       label: 'Port',                  type: 'number', hint: 'default 3456' },
  { path: 'host',                       label: 'Host',                  type: 'string', hint: '127.0.0.1 (loopback only)' },
  { path: 'stealth',                    label: 'Stealth preset',        type: 'bool',   hint: 'enables behavioural pacing + jitter' },
  { path: 'drainOnClose',               label: 'Drain on close',        type: 'bool',   hint: 'finish upstream SSE after client disconnects' },
  { path: 'pacing.minMs',               label: 'Pacing min (ms)',       type: 'number', hint: 'min inter-request distance' },
  { path: 'pacing.jitterMs',            label: 'Pacing jitter (ms)',    type: 'number', hint: 'uniform-random extra delay' },
  { path: 'thinkTime.baseMs',           label: 'Think-time base (ms)',  type: 'number' },
  { path: 'thinkTime.perTokenMs',       label: 'Think-time per-token',  type: 'number', hint: 'ms per output token of last response' },
  { path: 'thinkTime.jitterMs',         label: 'Think-time jitter',     type: 'number' },
  { path: 'thinkTime.maxMs',            label: 'Think-time cap (ms)',   type: 'number', hint: 'upper bound for the whole formula' },
  { path: 'sessionStart.minMs',         label: 'Session-start min',     type: 'number', hint: 'first-request delay floor' },
  { path: 'sessionStart.jitterMs',      label: 'Session-start jitter',  type: 'number' },
  // ── Overage-guard (v4.1, dario#288) ─────────────────────────
  { path: 'overageGuard.enabled',       label: 'Overage-guard',         type: 'bool',   hint: 'halt proxy on any representative-claim=overage' },
  { path: 'overageGuard.behavior',      label: 'Overage behavior',      type: 'string', hint: '"halt" (default) or "warn"' },
  { path: 'overageGuard.cooldownMs',    label: 'Overage cooldown (ms)', type: 'number', hint: 'auto-resume delay; default 1800000 (30 min)' },
  { path: 'overageGuard.notifyOs',      label: 'Overage OS-notify',     type: 'bool',   hint: 'native desktop notification on halt' },
];

export interface ConfigState {
  config: DarioConfig;
  /** Loaded snapshot — used to compute dirty. */
  snapshot: DarioConfig;
  selectedIdx: number;
  /** Active edit buffer, or null when not in edit mode. */
  editBuffer: string | null;
  /** Transient status line (e.g. "Saved."). */
  statusMessage: string | null;
  statusKind: 'info' | 'success' | 'error' | null;
}

export const ConfigTab: Tab<ConfigState> = {
  id: 'config',
  label: 'Config',
  hotkey: 'c',

  initialState(): ConfigState {
    const loaded = loadConfig();
    return {
      config: loaded.config,
      snapshot: structuredClone(loaded.config),
      selectedIdx: 0,
      editBuffer: null,
      statusMessage: null,
      statusKind: null,
    };
  },

  onKey(state, key): ConfigState | undefined {
    // ── Edit mode key handling ─────────────────────────────────
    if (state.editBuffer !== null) {
      if (key.name === 'escape') {
        return { ...state, editBuffer: null, statusMessage: 'Edit cancelled.', statusKind: 'info' };
      }
      if (key.name === 'enter') {
        return commitEdit(state);
      }
      if (key.name === 'backspace') {
        return { ...state, editBuffer: state.editBuffer.slice(0, -1) };
      }
      if (key.name === 'printable' && !key.ctrl) {
        return { ...state, editBuffer: state.editBuffer + key.ch };
      }
      return undefined;
    }
    // ── Normal mode ────────────────────────────────────────────
    if (key.name === 'up') {
      return { ...state, selectedIdx: Math.max(0, state.selectedIdx - 1), statusMessage: null, statusKind: null };
    }
    if (key.name === 'down') {
      return { ...state, selectedIdx: Math.min(FIELDS.length - 1, state.selectedIdx + 1), statusMessage: null, statusKind: null };
    }
    if (key.name === 'enter') {
      return startEdit(state);
    }
    if (key.name === 'printable' && !key.ctrl) {
      if (key.ch === 's') return doSave(state);
      if (key.ch === 'd') return doDiscard(state);
      if (key.ch === 'r') return doReload();
    }
    return undefined;
  },

  render(state, dimv): string {
    const lines: string[] = [];
    const w = dimv.cols;
    const labelW = 26;
    const valueW = w - labelW - 6;

    const dirty = isDirty(state);
    const title = dirty
      ? brand('Config') + dim('  — ') + fg('yellow', '● unsaved changes')
      : brand('Config');
    lines.push(' ' + title);
    lines.push('');

    for (let i = 0; i < FIELDS.length; i++) {
      const field = FIELDS[i];
      const value = getByPath(state.config, field.path);
      const orig = getByPath(state.snapshot, field.path);
      const changed = !Object.is(value, orig);
      const valueRender = renderValue(field, value, changed);
      const hint = field.hint ? '  ' + dim('— ' + field.hint) : '';
      const row = '  ' + pad(field.label + ':', labelW) + pad(valueRender, valueW) + hint;
      lines.push(i === state.selectedIdx ? inverse(row) : row);
    }

    // ── Edit prompt or status line ─────────────────────────────
    lines.push('');
    if (state.editBuffer !== null) {
      const f = FIELDS[state.selectedIdx];
      lines.push(' ' + fg('cyan', `Edit ${f.label}:`) + ' ' + state.editBuffer + fg('cyan', '_'));
      lines.push(' ' + dim('Enter to confirm · Esc to cancel'));
    } else if (state.statusMessage) {
      const color = state.statusKind === 'error' ? 'red'
                 : state.statusKind === 'success' ? 'green'
                 : 'cyan';
      lines.push(' ' + fg(color as 'red' | 'green' | 'cyan', state.statusMessage));
    } else {
      lines.push(' ' + dim('↑↓ navigate · Enter edit · s save · d discard · r reload'));
    }
    return lines.join('\n');
  },
};

// ── Helpers ───────────────────────────────────────────────────

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((acc: unknown, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

function setByPath(obj: DarioConfig, path: string, value: unknown): DarioConfig {
  // Guard against prototype-pollution paths. `path` is always sourced
  // from FIELDS (the static registry at the top of this file), but
  // CodeQL flags the recursive descent as risky because it can't
  // prove that statically — and rightly so: if a future caller ever
  // passes a user-controlled path, walking `__proto__` or
  // `constructor` would mutate Object.prototype. Reject those
  // segments explicitly so the seam is safe by construction.
  const parts = path.split('.');
  for (const part of parts) {
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      throw new Error(`refusing to set forbidden path segment: ${part}`);
    }
  }
  const next = structuredClone(obj);
  let cursor: Record<string, unknown> = next as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    // Object.prototype.hasOwnProperty.call so we don't accidentally
    // pick up inherited keys when probing for existing nested groups.
    if (!Object.prototype.hasOwnProperty.call(cursor, part)
        || typeof cursor[part] !== 'object'
        || cursor[part] === null) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
  return next;
}

function renderValue(field: FieldDef, value: unknown, changed: boolean): string {
  let text: string;
  if (field.type === 'bool') text = value === true ? 'on' : 'off';
  else if (value === null || value === undefined) text = '—';
  else text = String(value);
  // Yellow if changed-from-snapshot; green for bool-on; default otherwise
  if (changed) return fg('yellow', text);
  if (field.type === 'bool' && value === true) return fg('green', text);
  return text;
}

function startEdit(state: ConfigState): ConfigState {
  const f = FIELDS[state.selectedIdx];
  if (f.type === 'bool') {
    // Toggle in place
    const current = getByPath(state.config, f.path);
    const next = setByPath(state.config, f.path, !current);
    return { ...state, config: next, statusMessage: null, statusKind: null };
  }
  // String / number: open the prompt with the current value
  const current = getByPath(state.config, f.path);
  return { ...state, editBuffer: current === null || current === undefined ? '' : String(current) };
}

function commitEdit(state: ConfigState): ConfigState {
  if (state.editBuffer === null) return state;
  const f = FIELDS[state.selectedIdx];
  let parsed: unknown;
  if (f.type === 'number') {
    if (state.editBuffer === '') {
      // Empty number → null (clears the override)
      parsed = null;
    } else {
      const n = Number(state.editBuffer);
      if (!Number.isFinite(n)) {
        return { ...state, editBuffer: null, statusMessage: `Not a number: "${state.editBuffer}"`, statusKind: 'error' };
      }
      // Path-specific guards. cooldownMs must be non-negative — silently
      // dropping a bad value on next config-file load is correct but lets
      // the user save an invalid file. Surface immediately. (v4.1.1)
      if (f.path === 'overageGuard.cooldownMs' && n < 0) {
        return { ...state, editBuffer: null, statusMessage: `overageGuard.cooldownMs must be >= 0 (got ${n})`, statusKind: 'error' };
      }
      parsed = n;
    }
  } else if (f.type === 'string') {
    // String enums: validate so we reject bad input at commit time rather
    // than let the proxy's sanitize() silently drop it on next load. v4.1.1
    // adds the overageGuard.behavior enum; future enums register here.
    const enumValues = STRING_ENUMS[f.path];
    if (enumValues && !enumValues.includes(state.editBuffer)) {
      return {
        ...state,
        editBuffer: null,
        statusMessage: `${f.label} must be one of: ${enumValues.join(', ')} (got "${state.editBuffer}")`,
        statusKind: 'error',
      };
    }
    parsed = state.editBuffer;
  } else {
    parsed = state.editBuffer;
  }
  const next = setByPath(state.config, f.path, parsed);
  return { ...state, config: next, editBuffer: null, statusMessage: `Updated ${f.label}.`, statusKind: 'success' };
}

/**
 * Allowed values for string-enum fields. Keyed by FIELDS path. Anything
 * absent here is treated as free-text (no enum validation). v4.1.1+ —
 * additive: registering a new entry forces enum validation on the next
 * commit without touching the rest of the editor.
 */
const STRING_ENUMS: Record<string, readonly string[]> = {
  'overageGuard.behavior': ['halt', 'warn'],
};

function doSave(state: ConfigState): ConfigState {
  try {
    saveConfig(undefined, { ...state.config, version: CONFIG_SCHEMA_VERSION });
    return {
      ...state,
      snapshot: structuredClone(state.config),
      statusMessage: 'Saved to ~/.dario/config.json',
      statusKind: 'success',
    };
  } catch (err) {
    return {
      ...state,
      statusMessage: `Save failed: ${(err as Error).message}`,
      statusKind: 'error',
    };
  }
}

function doDiscard(state: ConfigState): ConfigState {
  return {
    ...state,
    config: structuredClone(state.snapshot),
    statusMessage: 'Local changes discarded.',
    statusKind: 'info',
  };
}

function doReload(): ConfigState {
  const loaded = loadConfig();
  return {
    config: loaded.config,
    snapshot: structuredClone(loaded.config),
    selectedIdx: 0,
    editBuffer: null,
    statusMessage: loaded.source === 'file' ? 'Reloaded from disk.'
                 : loaded.source === 'missing' ? 'No file on disk — showing defaults.'
                 : `Invalid file: ${loaded.error}`,
    statusKind: loaded.source === 'invalid' ? 'error' : 'info',
  };
}

function isDirty(state: ConfigState): boolean {
  return JSON.stringify(state.config) !== JSON.stringify(state.snapshot);
}

// Avoid "unused" lint
void defaultConfig;
