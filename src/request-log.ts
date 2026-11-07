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
 */

import { open } from 'node:fs/promises';

export const REQUEST_LOG_PAGE_BYTES = 1024 * 1024;
/** Above any line the log can hold, so a page always has room for a whole one. */
export const REQUEST_LOG_MIN_PAGE_BYTES = 64 * 1024;
export const REQUEST_LOG_MAX_PAGE_BYTES = 8 * 1024 * 1024;

export interface RequestLogPage {
  /** The file's size at this read. `size - next` is what is still unread. */
  size: number;
  /** The offset to ask for next. Equal to `after` when no whole line is ready. */
  next: number;
  records: unknown[];
  /** Whole lines that did not parse. They are passed over, and counted here so that is visible. */
  unreadable: number;
}

/** `?after=` and `?limit=` from a request URL. Anything unusable falls back to a safe value. */
export function parseRequestLogQuery(url: string): { after: number; limit: number } {
  const params = new URL(url, 'http://dario.invalid').searchParams;
  const after = Number(params.get('after'));
  const limit = Number(params.get('limit'));
  return {
    after: Number.isSafeInteger(after) && after > 0 ? after : 0,
    limit: Number.isSafeInteger(limit) && limit > 0
      ? Math.min(REQUEST_LOG_MAX_PAGE_BYTES, Math.max(REQUEST_LOG_MIN_PAGE_BYTES, limit))
      : REQUEST_LOG_PAGE_BYTES,
  };
}

/**
 * One page of the log from byte `after`. A log with nothing in it yet is an
 * empty page, not an error. An offset past the end means the file was replaced
 * since the reader's last page, so `next` sends it back to the start.
 */
export async function readRequestLog(
  path: string,
  after: number = 0,
  limit: number = REQUEST_LOG_PAGE_BYTES,
): Promise<RequestLogPage> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { size: 0, next: 0, records: [], unreadable: 0 };
    throw err;
  }
  try {
    const { size } = await file.stat();
    if (after > size) return { size, next: 0, records: [], unreadable: 0 };

    const buffer = Buffer.alloc(Math.min(limit, size - after));
    const { bytesRead } = buffer.length ? await file.read(buffer, 0, buffer.length, after) : { bytesRead: 0 };
    const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end < 0) return { size, next: after, records: [], unreadable: 0 };

    const records: unknown[] = [];
    let unreadable = 0;
    for (const line of buffer.subarray(0, end).toString('utf-8').split('\n')) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        unreadable++;
      }
    }
    return { size, next: after + end + 1, records, unreadable };
  } finally {
    await file.close();
  }
}
