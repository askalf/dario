/**
 * Transcripts: what a named key's requests said and what came back, kept for a
 * short while so one reader can take them away.
 *
 * WHY THIS SHAPE. The request log says who called and what it cost, and holds no
 * text on purpose. A reader that wants to learn from the words needs the words,
 * but only for the keys its operator chose, so a key is armed by name
 * (`dario keys transcript <name> on`) and nothing else is ever written. A client
 * cannot arm it, and a key that was never armed leaves no file.
 *
 * ONE FILE PER RECORD. A request can run to megabytes, past any page a line
 * reader could promise, and a record that outlives its welcome has to be easy to
 * remove. File names sort by time, so a name is also the reader's place: it needs
 * no offset, and a pruned file cannot move anything after it.
 *
 * ORDER IS THE PROMISE, SO THE WRITE IS SYNCHRONOUS. A reader that has passed a
 * name never looks behind it. An asynchronous write could land after a later
 * record was already read, and that record would be lost with no sign. A record
 * appears under its final name whole, so a reader cannot see half of one.
 *
 * THESE FILES ARE RAW. They hold whatever was sent, secrets included, so they are
 * private to dario's user and readable over HTTP only with a token of their own.
 * A record is served for TRANSCRIPT_KEEP_MS, read or not, then the hourly pass
 * removes it. The pass needs a running proxy, so the read is what holds the limit.
 */

import { linkSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const TRANSCRIPT_DIR = join(homedir(), '.dario', 'transcripts');

/** How long a record is served, read or not. Long enough to cover a reader that missed a day. */
export const TRANSCRIPT_KEEP_MS = 48 * 60 * 60 * 1000;

/** A record larger than this keeps its facts and loses its text. */
export const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;

/** Most a page holds. A page always carries at least one record. */
export const TRANSCRIPT_PAGE_BYTES = 8 * 1024 * 1024;

const NAME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z-\d{4}\.json(\.tmp)?$/;

/** Most records sharing one millisecond before a write gives up. */
const MAX_SAME_MS = 10_000;

export interface TranscriptRecord {
  ts: string;
  /** The named key. */
  consumer: string;
  path: string;
  status: number | null;
  ms: number;
  /** The request body as the client sent it, or null when it was not JSON. */
  request: unknown;
  /** The response exactly as written: SSE text or a JSON body. */
  response: string | null;
  /** Why the text is gone, when it is. */
  dropped?: 'too large';
}

export interface TranscriptPage {
  /** Pass back as `after` for the next page. Holds its place on an empty page. */
  next: string;
  records: Array<TranscriptRecord & { id: string }>;
  /** Files in this page's range that would not parse. Passed over, and counted. */
  unreadable: number;
  /** Records past this page. */
  left: number;
}

/** A record's time, read from its name, or NaN for a name that is not one of ours. */
function nameTime(name: string): number {
  const m = NAME_RE.exec(name);
  return m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : NaN;
}

/**
 * Keep one record. Returns its name, or null on failure: a transcript that cannot
 * be written is not worth failing a served request over.
 */
export function writeTranscript(record: TranscriptRecord, dir: string = TRANSCRIPT_DIR): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let payload = JSON.stringify(record);
    if (Buffer.byteLength(payload) > TRANSCRIPT_MAX_BYTES) {
      payload = JSON.stringify({ ...record, request: null, response: null, dropped: 'too large' });
    }
    const stamp = record.ts.replace(/[:.]/g, '-');
    for (let n = 0; n < MAX_SAME_MS; n++) {
      const name = `${stamp}-${String(n).padStart(4, '0')}.json`;
      const tmp = join(dir, `${name}.tmp`);
      try {
        // `wx` and link both refuse a name that exists, so two records in one
        // millisecond get two names, across processes too. The link is what makes
        // the record appear whole.
        writeFileSync(tmp, payload, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
        try {
          linkSync(tmp, join(dir, name));
        } finally {
          unlinkSync(tmp);
        }
        return name;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Remove every record past its time, and any write that never finished. Returns how many went. */
export function pruneTranscripts(dir: string = TRANSCRIPT_DIR, now: number = Date.now(), keepMs: number = TRANSCRIPT_KEEP_MS): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    // A file that is not one of ours has no time, so it stays.
    if (!(now - nameTime(name) > keepMs)) continue;
    try {
      unlinkSync(join(dir, name));
      removed++;
    } catch { /* gone already, or the next pass will have it */ }
  }
  return removed;
}

/** The reader's place from a request URL. Anything that is not a record's name is the start. */
export function parseTranscriptQuery(url: string): { after: string } {
  const after = new URL(url, 'http://dario.local').searchParams.get('after') ?? '';
  return { after: NAME_RE.test(after) && !after.endsWith('.tmp') ? after : '' };
}

/**
 * Read the records after a name, oldest first, up to `pageBytes`. Walking `next`
 * reads every record exactly once. A record older than the reader's place is
 * never served again, and a record past its time is not served at all, whether
 * or not the pass has removed its file yet.
 */
export async function readTranscripts(dir: string = TRANSCRIPT_DIR, after: string = '', pageBytes: number = TRANSCRIPT_PAGE_BYTES, now: number = Date.now()): Promise<TranscriptPage> {
  let all: string[];
  try {
    all = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { next: after, records: [], unreadable: 0, left: 0 };
    throw err;
  }
  const names = all.filter((n) => NAME_RE.test(n) && !n.endsWith('.tmp') && n > after && now - nameTime(n) <= TRANSCRIPT_KEEP_MS).sort();
  const page: TranscriptPage = { next: after, records: [], unreadable: 0, left: 0 };
  let bytes = 0;
  let taken = 0;
  for (const name of names) {
    let text: string;
    try {
      text = await readFile(join(dir, name), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      taken++; // pruned since the listing
      page.next = name;
      continue;
    }
    const size = Buffer.byteLength(text);
    if (page.records.length > 0 && bytes + size > pageBytes) break;
    bytes += size;
    taken++;
    page.next = name;
    try {
      page.records.push({ ...(JSON.parse(text) as TranscriptRecord), id: name });
    } catch {
      page.unreadable++;
    }
  }
  page.left = names.length - taken;
  return page;
}
