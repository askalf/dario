/**
 * Reading the request log back over HTTP.
 *
 * `--log-file` keeps one JSON line per completed request, and it is the only
 * per-request record that outlives a restart: analytics holds a rolling window
 * in memory and the ledger holds daily totals. A reader in another container
 * could only reach the file by sharing the folder the credentials live in, so
 * the proxy serves it, by byte offset, behind the same read-only gate as the
 * rest of analytics.
 *
 * A page is whole lines. The last line of a read may still be on its way to
 * disk, so anything after the final newline waits for the next read.
 *
 * An offset means nothing in a different file, and a replacement can be longer
 * than the reader's offset, so the size alone cannot show it. Each page carries
 * a mark, a hash of the first and last KiB of what has been read. A reader hands
 * it back with the offset, and a mark that no longer matches sends it to the
 * start. Every line opens with its own timestamp, so a different log differs at
 * the head: that covers a rename, a truncation and a reused inode alike, where a
 * file identity would miss a log truncated in place and grown past the offset.
 *
 * The log is append-only, and the mark is built on that. Hashing all of what has
 * been read would cost a pass over the whole file per page, so an edit to the
 * middle of it that keeps both ends is the one change this cannot see. Nothing in
 * dario rewrites the file, and a rotation does not leave its first line in place.
 */

import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

export const REQUEST_LOG_PAGE_BYTES = 1024 * 1024;
/** Longer than a log line, so each end of a mark takes in a line's timestamp and request number. */
const MARK_BYTES = 1024;

export interface RequestLogPage {
  /** The file's size at this read. `size - next` is what is still unread. */
  size: number;
  /** The offset to ask for next. Equal to `after` when no whole line is ready. */
  next: number;
  /** Hand this back with `next`. Empty at the start of the file, where there is nothing to check. */
  mark: string;
  records: unknown[];
  /** Whole lines that did not parse. They are passed over, and counted here so that is visible. */
  unreadable: number;
}

/** `?after=` and `?mark=` from a request URL. Anything unusable reads as the start of the file. */
export function parseRequestLogQuery(url: string): { after: number; mark: string } {
  const params = new URL(url, 'http://dario.invalid').searchParams;
  const after = Number(params.get('after'));
  return {
    after: Number.isSafeInteger(after) && after > 0 ? after : 0,
    mark: params.get('mark') ?? '',
  };
}

async function markAt(file: FileHandle, offset: number): Promise<string> {
  const length = Math.min(MARK_BYTES, offset);
  if (length <= 0) return '';
  const hash = createHash('sha256');
  const window = Buffer.alloc(MARK_BYTES);
  for (const start of [0, offset - length]) {
    const { bytesRead } = await file.read(window, 0, length, start);
    hash.update(window.subarray(0, bytesRead));
  }
  return hash.digest('hex').slice(0, 32);
}

/**
 * One page of the log from byte `after`. A log with nothing in it yet is an
 * empty page, not an error. `pageBytes` is the caller's, never the request's.
 */
export async function readRequestLog(
  path: string,
  after: number = 0,
  mark: string = '',
  pageBytes: number = REQUEST_LOG_PAGE_BYTES,
): Promise<RequestLogPage> {
  let file: FileHandle;
  try {
    file = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { size: 0, next: 0, mark: '', records: [], unreadable: 0 };
    throw err;
  }
  try {
    const { size } = await file.stat();
    if (after > size || (after > 0 && mark && await markAt(file, after) !== mark)) {
      return { size, next: 0, mark: '', records: [], unreadable: 0 };
    }

    const page = Buffer.alloc(pageBytes);
    const { bytesRead } = await file.read(page, 0, pageBytes, after);
    const end = page.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end < 0) return { size, next: after, mark: await markAt(file, after), records: [], unreadable: 0 };

    const records: unknown[] = [];
    let unreadable = 0;
    for (const line of page.subarray(0, end).toString('utf-8').split('\n')) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        unreadable++;
      }
    }
    const next = after + end + 1;
    return { size, next, mark: await markAt(file, next), records, unreadable };
  } finally {
    await file.close();
  }
}
