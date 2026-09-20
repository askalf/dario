/**
 * Named keys — one credential per developer on a shared dario (dario#1318).
 *
 * A team runs one proxy for several people. `DARIO_API_KEY` is one secret for
 * all of them, so nothing says whose traffic is whose except an
 * `x-dario-consumer` header any client can set to anything. A named key ties
 * attribution to the credential: the request authenticated with alice's key
 * IS alice's, in `/analytics`, in the ledger, on every log line.
 *
 * What a key can carry, all optional:
 *   seat     the pool account this key's traffic prefers. Honoured when that
 *            seat is eligible; otherwise the request routes like any other,
 *            and failover mid-request is unchanged. A developer's key can
 *            ride the developer's own subscription without anyone else's
 *            requests landing on it.
 *   models   an allowlist; a request for any other model is refused (403)
 *            before anything goes upstream.
 *   expires  after which the key is refused like a revoked one.
 *
 * Storage is one file, `~/.dario/keys.json`, mode 0600, holding hashes and
 * never secrets: the secret is printed once at creation and is not
 * recoverable. The running proxy re-reads the file when its mtime moves, so
 * `dario keys create` and the admin API's `/admin/keys` both take effect on
 * the next request with no restart.
 *
 * The wire is untouched. dario already replaces the inbound key with the
 * seat's own bearer before upstream, so a named key changes what dario
 * knows, not what Anthropic sees — passthrough stays byte-identical.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const KEYS_VERSION = 1;
export const KEY_PREFIX = 'dk_';
/** Same charset as a pool alias — a key name is printed next to one. */
export const KEY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_\-.]{0,63}$/;
export const KEYS_FLUSH_DELAY_MS = 3_000;
const SECRET_BYTES = 24;

export interface KeyRecord {
  /** Stable short id (8 hex), for logs and rotation; never the secret. */
  id: string;
  name: string;
  /** sha256 hex of the secret. */
  hash: string;
  /** ISO timestamp. */
  created: string;
  /** ISO timestamp of the last request this key authenticated. */
  lastUsed?: string;
  /** Refused, kept for the record. `dario keys revoke` sets it; `list` shows it. */
  disabled?: boolean;
  /** ISO timestamp; refused after. */
  expires?: string;
  /** Preferred pool seat alias. */
  seat?: string;
  /** Model allowlist: exact ids, or `prefix*`. Empty / absent = any model. */
  models?: string[];
  /** Daily caps, UTC day, enforced from the ledger (dario#1318 follow-up). Absent = unlimited. */
  budget?: KeyBudget;
}

/**
 * A key's daily budget. Both caps are per UTC day and both are read from the
 * ledger's per-consumer rows at request time, so they survive a restart and
 * every dollar can be traced to `dario usage --by-key`. `usdPerDay` is the
 * API-equivalent price of the key's traffic (covered + metered); `tokensPerDay`
 * counts every token the key sent or received, cache reads included.
 */
export interface KeyBudget {
  usdPerDay?: number;
  tokensPerDay?: number;
}

/** What the ledger says a key has used today; the budget is compared against this. */
export interface KeyBudgetUsage {
  usd: number;
  tokens: number;
  requests: number;
}

export interface KeyBudgetVerdict {
  over: boolean;
  /** Which cap tripped first. */
  reason: 'usd' | 'tokens' | null;
  usage: KeyBudgetUsage;
  budget: KeyBudget;
  /** Epoch ms of the next UTC midnight — when the day's counters reset. */
  resetAt: number;
  retryAfterSec: number;
}

/** Throws on a cap that is not a positive finite number; returns undefined when neither cap is set. */
export function normalizeBudget(b: KeyBudget | null | undefined): KeyBudget | undefined {
  if (!b) return undefined;
  const out: KeyBudget = {};
  if (b.usdPerDay !== undefined && b.usdPerDay !== null) {
    if (!Number.isFinite(b.usdPerDay) || b.usdPerDay <= 0) throw new Error('budget: usdPerDay must be a positive number');
    out.usdPerDay = Math.round(b.usdPerDay * 100) / 100;
  }
  if (b.tokensPerDay !== undefined && b.tokensPerDay !== null) {
    if (!Number.isFinite(b.tokensPerDay) || b.tokensPerDay <= 0) throw new Error('budget: tokensPerDay must be a positive number');
    out.tokensPerDay = Math.round(b.tokensPerDay);
  }
  return out.usdPerDay === undefined && out.tokensPerDay === undefined ? undefined : out;
}

/** `$5`, `5`, `5.00`, `$5/day`, `5/d` → dollars per day; null when unparseable. */
export function parseUsdBudget(value: string): number | null {
  const m = /^\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:\/\s*(?:day|d))?$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `250000`, `250k`, `2M`, `1.5m/day` → tokens per day (integer); null when unparseable. */
export function parseTokenBudget(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmM]?)\s*(?:tok(?:ens)?)?\s*(?:\/\s*(?:day|d))?$/.exec(value.trim());
  if (!m) return null;
  const mult = m[2]?.toLowerCase() === 'k' ? 1_000 : m[2]?.toLowerCase() === 'm' ? 1_000_000 : 1;
  const n = Math.round(Number(m[1]) * mult);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `{ usdPerDay: 5, tokensPerDay: 2_000_000 }` → `$5/day · 2.0M tok/day`; `-` for none. */
export function formatBudget(b: KeyBudget | null | undefined): string {
  if (!b || (b.usdPerDay === undefined && b.tokensPerDay === undefined)) return '-';
  const parts: string[] = [];
  if (b.usdPerDay !== undefined) parts.push(`$${b.usdPerDay % 1 === 0 ? b.usdPerDay : b.usdPerDay.toFixed(2)}/day`);
  if (b.tokensPerDay !== undefined) {
    const t = b.tokensPerDay;
    const s = t >= 1_000_000 ? `${(t / 1_000_000).toFixed(t % 1_000_000 === 0 ? 0 : 1)}M` : t >= 1_000 ? `${(t / 1_000).toFixed(t % 1_000 === 0 ? 0 : 1)}k` : String(t);
    parts.push(`${s} tok/day`);
  }
  return parts.join(' · ');
}

/** Next UTC midnight after `now`, epoch ms. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Over or under, given what the ledger has counted for the key today. The
 * check is at request START against completed requests, so one request can
 * carry a key past its cap; the next one is refused. `retryAfterSec` is the
 * time to the UTC day boundary, when the counters reset.
 */
export function budgetVerdict(budget: KeyBudget, usage: KeyBudgetUsage, now: number = Date.now()): KeyBudgetVerdict {
  const resetAt = nextUtcMidnight(now);
  let reason: KeyBudgetVerdict['reason'] = null;
  if (budget.usdPerDay !== undefined && usage.usd >= budget.usdPerDay) reason = 'usd';
  else if (budget.tokensPerDay !== undefined && usage.tokens >= budget.tokensPerDay) reason = 'tokens';
  return { over: reason !== null, reason, usage, budget, resetAt, retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
}

/** The response headers a budgeted key's request carries, served or refused. */
export function budgetHeaders(v: KeyBudgetVerdict, keyName: string): Record<string, string> {
  const h: Record<string, string> = { 'x-dario-budget-key': keyName, 'x-dario-budget-resets-at': new Date(v.resetAt).toISOString() };
  if (v.budget.usdPerDay !== undefined) {
    h['x-dario-budget-usd'] = String(v.budget.usdPerDay);
    h['x-dario-budget-used-usd'] = v.usage.usd.toFixed(4);
  }
  if (v.budget.tokensPerDay !== undefined) {
    h['x-dario-budget-tokens'] = String(v.budget.tokensPerDay);
    h['x-dario-budget-used-tokens'] = String(v.usage.tokens);
  }
  return h;
}

/** Replace (or clear, with null) a key's budget. Null result: no such key. */
export function setKeyBudget(file: KeysFile, name: string, budget: KeyBudget | null): KeyRecord | null {
  const k = file.keys.find((x) => x.name === name);
  if (!k) return null;
  const normalized = normalizeBudget(budget);
  if (normalized) k.budget = normalized; else delete k.budget;
  return k;
}

export interface KeysFile {
  version: number;
  keys: KeyRecord[];
}

export function keysPathFor(home: string = homedir()): string {
  return join(home, '.dario', 'keys.json');
}

export function resolveKeysPath(env: NodeJS.ProcessEnv = process.env): string {
  const p = env['DARIO_KEYS_PATH'];
  return typeof p === 'string' && p.trim().length > 0 ? p.trim() : keysPathFor();
}

/**
 * sha256, not a slow KDF, on purpose: a key is 24 bytes from `randomBytes`
 * (192 bits of entropy), never a human-chosen password, so a guess is not
 * a threat a KDF could slow down, and this hash runs once per request on the
 * hot path. This is how GitHub and Stripe store their API tokens.
 * (CodeQL's js/insufficient-password-hash fires on the x-api-key source and
 * is dismissed as a false positive for exactly this reason.)
 */
export function hashKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** `dk_` + 48 hex characters. The prefix lets a reject log say "a named key" without the value. */
export function mintSecret(): string {
  return KEY_PREFIX + randomBytes(SECRET_BYTES).toString('hex');
}

export function looksLikeNamedKey(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith(KEY_PREFIX);
}

export function emptyKeysFile(): KeysFile {
  return { version: KEYS_VERSION, keys: [] };
}

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * Parse a keys file's text, keeping only well-formed records. A file that is
 * not a keys file at all throws; the caller decides whether to move it aside.
 */
export function parseKeysFile(text: string): KeysFile {
  const raw = JSON.parse(text) as Partial<KeysFile>;
  if (!raw || typeof raw !== 'object' || raw.version !== KEYS_VERSION || !Array.isArray(raw.keys)) {
    throw new Error('not a dario keys file');
  }
  const keys: KeyRecord[] = [];
  const seen = new Set<string>();
  for (const k of raw.keys as Partial<KeyRecord>[]) {
    if (!k || typeof k !== 'object') continue;
    if (typeof k.name !== 'string' || !KEY_NAME_RE.test(k.name) || seen.has(k.name)) continue;
    if (typeof k.hash !== 'string' || !/^[0-9a-f]{64}$/.test(k.hash)) continue;
    if (typeof k.id !== 'string' || !/^[0-9a-f]{8}$/.test(k.id)) continue;
    const rec: KeyRecord = { id: k.id, name: k.name, hash: k.hash, created: isIso(k.created) ? k.created : new Date(0).toISOString() };
    if (isIso(k.lastUsed)) rec.lastUsed = k.lastUsed;
    if (k.disabled === true) rec.disabled = true;
    if (isIso(k.expires)) rec.expires = k.expires;
    if (typeof k.seat === 'string' && KEY_NAME_RE.test(k.seat)) rec.seat = k.seat;
    if (Array.isArray(k.models)) {
      const models = k.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0).map((m) => m.trim());
      if (models.length > 0) rec.models = models;
    }
    // Daily caps (dario#1318 follow-up): kept only when they parse as positive numbers.
    if (k.budget && typeof k.budget === 'object') {
      const b = k.budget as Partial<KeyBudget>;
      try {
        const budget = normalizeBudget({ usdPerDay: typeof b.usdPerDay === 'number' ? b.usdPerDay : undefined, tokensPerDay: typeof b.tokensPerDay === 'number' ? b.tokensPerDay : undefined });
        if (budget) rec.budget = budget;
      } catch { /* a malformed cap is dropped, never a reason to refuse the whole file */ }
    }
    seen.add(rec.name);
    keys.push(rec);
  }
  return { version: KEYS_VERSION, keys };
}

/** Missing file → empty. Unreadable or malformed → throws (never silently empty: that would "revoke" everyone). */
export function readKeysFile(path: string): KeysFile {
  if (!existsSync(path)) return emptyKeysFile();
  return parseKeysFile(readFileSync(path, 'utf8'));
}

/** Atomic, 0600, parent 0700 — the same primitive config.json uses. */
export function writeKeysFile(path: string, file: KeysFile): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  const json = JSON.stringify({ version: KEYS_VERSION, keys: file.keys }, null, 2) + '\n';
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, json, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export interface CreateKeyOptions {
  seat?: string;
  models?: string[];
  /** Daily caps; see KeyBudget. */
  budget?: KeyBudget;
  /** Absolute expiry, epoch ms. */
  expiresAt?: number;
  now?: number;
}

function newId(existing: KeysFile): string {
  for (;;) {
    const id = randomBytes(4).toString('hex');
    if (!existing.keys.some((k) => k.id === id)) return id;
  }
}

/** Mint a key. Returns the record (stored) and the secret (shown once). Mutates `file`. */
export function createKey(file: KeysFile, name: string, opts: CreateKeyOptions = {}): { record: KeyRecord; secret: string } {
  const trimmed = name.trim();
  if (!KEY_NAME_RE.test(trimmed)) throw new Error(`invalid key name "${name}": letters, digits, _ - . only, up to 64, starting with a letter or digit`);
  if (file.keys.some((k) => k.name === trimmed)) throw new Error(`a key named "${trimmed}" already exists (rotate it, or pick another name)`);
  if (opts.seat !== undefined && !KEY_NAME_RE.test(opts.seat)) throw new Error(`invalid seat alias "${opts.seat}"`);
  const secret = mintSecret();
  const record: KeyRecord = { id: newId(file), name: trimmed, hash: hashKey(secret), created: new Date(opts.now ?? Date.now()).toISOString() };
  if (opts.seat) record.seat = opts.seat;
  if (opts.models && opts.models.length > 0) record.models = opts.models.map((m) => m.trim()).filter(Boolean);
  const budget = normalizeBudget(opts.budget);
  if (budget) record.budget = budget;
  if (opts.expiresAt !== undefined) {
    if (!Number.isFinite(opts.expiresAt) || opts.expiresAt <= (opts.now ?? Date.now())) throw new Error('expiry must be in the future');
    record.expires = new Date(opts.expiresAt).toISOString();
  }
  file.keys.push(record);
  return { record, secret };
}

/** Mark a key refused. Returns false when there is no such key. The record stays, for the list. */
export function revokeKey(file: KeysFile, name: string): boolean {
  const k = file.keys.find((x) => x.name === name);
  if (!k) return false;
  k.disabled = true;
  return true;
}

/** Forget a key entirely (list no longer shows it). */
export function deleteKey(file: KeysFile, name: string): boolean {
  const i = file.keys.findIndex((x) => x.name === name);
  if (i < 0) return false;
  file.keys.splice(i, 1);
  return true;
}

/** New secret, same name, seat, models and expiry; the old secret stops working at once. */
export function rotateKey(file: KeysFile, name: string, now: number = Date.now()): { record: KeyRecord; secret: string } | null {
  const k = file.keys.find((x) => x.name === name);
  if (!k) return null;
  const secret = mintSecret();
  k.hash = hashKey(secret);
  k.created = new Date(now).toISOString();
  delete k.lastUsed;
  delete k.disabled;
  return { record: k, secret };
}

export function keyIsUsable(k: KeyRecord, now: number = Date.now()): boolean {
  if (k.disabled) return false;
  if (k.expires && Date.parse(k.expires) <= now) return false;
  return true;
}

/**
 * The record a presented secret belongs to, or null. Compares hashes in
 * constant time, every record every time, so a miss takes as long as a hit
 * and neither the count of keys nor which one matched leaks through timing.
 * A disabled or expired key matches nothing — the caller cannot tell it from
 * a wrong secret, on purpose.
 */
export function matchKey(file: KeysFile, provided: string, now: number = Date.now()): KeyRecord | null {
  if (typeof provided !== 'string' || provided.length === 0) return null;
  const h = Buffer.from(hashKey(provided), 'hex');
  let found: KeyRecord | null = null;
  for (const k of file.keys) {
    const stored = Buffer.from(k.hash, 'hex');
    if (stored.length === h.length && timingSafeEqual(stored, h) && keyIsUsable(k, now)) found = k;
  }
  return found;
}

/** `models` entries are exact ids, or `prefix*`; case-insensitive. Absent list = any model. */
export function keyAllowsModel(k: Pick<KeyRecord, 'models'>, model: string | null | undefined): boolean {
  if (!k.models || k.models.length === 0) return true;
  const m = (model ?? '').toLowerCase();
  for (const entry of k.models) {
    const e = entry.toLowerCase();
    if (e.endsWith('*') ? m.startsWith(e.slice(0, -1)) : m === e) return true;
  }
  return false;
}

/** What `dario keys list` and `GET /admin/keys` show: everything but the hash. */
export interface KeyPublic {
  id: string;
  name: string;
  created: string;
  last_used: string | null;
  status: 'active' | 'revoked' | 'expired';
  expires: string | null;
  seat: string | null;
  models: string[];
  /** Daily caps, or null when the key has none. */
  budget: { usd_per_day: number | null; tokens_per_day: number | null } | null;
}

export function publicKey(k: KeyRecord, now: number = Date.now()): KeyPublic {
  const status: KeyPublic['status'] = k.disabled ? 'revoked' : k.expires && Date.parse(k.expires) <= now ? 'expired' : 'active';
  const budget = k.budget ? { usd_per_day: k.budget.usdPerDay ?? null, tokens_per_day: k.budget.tokensPerDay ?? null } : null;
  return { id: k.id, name: k.name, created: k.created, last_used: k.lastUsed ?? null, status, expires: k.expires ?? null, seat: k.seat ?? null, budget, models: k.models ?? [] };
}

/** `--expires=30d` / `12h` / `2026-12-31` → epoch ms, or null when unparseable. */
export function parseExpiry(value: string, now: number = Date.now()): number | null {
  const v = value.trim();
  const rel = /^(\d+)([hdw])$/i.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 7 * 86_400_000;
    return n > 0 ? now + n * ms : null;
  }
  const abs = Date.parse(v);
  return Number.isNaN(abs) ? null : abs;
}

/**
 * The proxy's live view of the file. Reloads when the file's mtime moves (a
 * stat per auth — the cost of "no restart"), records last-used with a
 * debounced write that re-reads first so it never clobbers an edit the CLI
 * made in between.
 */
export class KeyStore {
  private file: KeysFile = emptyKeysFile();
  private mtimeMs = -1;
  private loadError: string | null = null;
  private dirtyLastUsed = new Map<string, string>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(readonly path: string) {}

  /** Read the file now. A malformed file is reported and leaves the last good state in place. */
  load(): void {
    let mtime = -1;
    try { mtime = statSync(this.path).mtimeMs; } catch { mtime = -1; }
    if (mtime === this.mtimeMs) return;
    try {
      this.file = readKeysFile(this.path);
      this.loadError = null;
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
    }
    this.mtimeMs = mtime;
  }

  get error(): string | null { return this.loadError; }

  size(): number { return this.file.keys.length; }

  list(now: number = Date.now()): KeyPublic[] {
    this.load();
    return this.file.keys.map((k) => publicKey(k, now));
  }

  /** The record a request's credential names, or null. Reloads first when the file moved. */
  match(provided: string | undefined, now: number = Date.now()): KeyRecord | null {
    this.load();
    if (!provided || this.file.keys.length === 0) return null;
    return matchKey(this.file, provided, now);
  }

  /** Note a use; written to disk after a quiet moment. */
  touch(k: KeyRecord, now: number = Date.now()): void {
    const iso = new Date(now).toISOString();
    k.lastUsed = iso;
    this.dirtyLastUsed.set(k.id, iso);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, KEYS_FLUSH_DELAY_MS);
      this.flushTimer.unref?.();
    }
  }

  /** Apply a mutation to the file on disk (re-read first), then adopt it. */
  mutate<T>(fn: (file: KeysFile) => T): T {
    const current = readKeysFile(this.path);
    const out = fn(current);
    writeKeysFile(this.path, current);
    this.file = current;
    try { this.mtimeMs = statSync(this.path).mtimeMs; } catch { this.mtimeMs = -1; }
    return out;
  }

  /** Persist pending last-used stamps. Safe to call at any time; a no-op when nothing is pending. */
  flush(): void {
    if (this.dirtyLastUsed.size === 0) return;
    const pending = new Map(this.dirtyLastUsed);
    this.dirtyLastUsed.clear();
    try {
      this.mutate((file) => {
        for (const k of file.keys) {
          const iso = pending.get(k.id);
          if (iso && (!k.lastUsed || Date.parse(iso) > Date.parse(k.lastUsed))) k.lastUsed = iso;
        }
      });
    } catch (err) {
      // The stamp is a convenience; losing it is not worth failing a request over.
      console.error(`[dario] keys: could not record last-used: ${err instanceof Error ? err.message : err}`);
    }
  }

  close(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flush();
  }
}
