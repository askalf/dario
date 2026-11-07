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
  /**
   * Which file this page came from (device, inode and birth time). A reader
   * sends it back as `?file=` so that an offset into a file since replaced is
   * read from the start of the new one, whatever its size.
   */
  file: string;
  /** The file's size at this read. `size - next` is what is still unread. */
  size: number;
  /** The offset to ask for next. Equal to `after` when no whole line is ready. */
  next: number;
  records: unknown[];
  /** Whole lines that did not parse. They are passed over, and counted here so that is visible. */
  unreadable: number;
}

/** `?after=`, `?limit=` and `?file=` from a request URL. Anything unusable falls back to a safe value. */
export function parseRequestLogQuery(url: string): { after: number; limit: number; file?: string } {
  const params = new URL(url, 'http://dario.invalid').searchParams;
  const after = Number(params.get('after'));
  const limit = Number(params.get('limit'));
  const file = params.get('file');
  return {
    after: Number.isSafeInteger(after) && after > 0 ? after : 0,
    limit: Number.isSafeInteger(limit) && limit > 0
      ? Math.min(REQUEST_LOG_MAX_PAGE_BYTES, Math.max(REQUEST_LOG_MIN_PAGE_BYTES, limit))
      : REQUEST_LOG_PAGE_BYTES,
    ...(file ? { file } : {}),
  };
}

/**
 * One page of the log from byte `after`. A log with nothing in it yet is an
 * empty page, not an error. When `file` names a different file than the one at
 * `path` now, the offset belonged to a file since replaced, so the page is read
 * from the start of the new one. Without `file`, an offset past the end is the
 * only sign of a replacement, and `next` sends the reader back to the start.
 */
export async function readRequestLog(
  path: string,
  after: number = 0,
  limit: number = REQUEST_LOG_PAGE_BYTES,
  fileId?: string,
): Promise<RequestLogPage> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { file: '', size: 0, next: 0, records: [], unreadable: 0 };
    throw err;
  }
  try {
    const st = await file.stat({ bigint: true });
    const id = `${st.dev}-${st.ino}-${st.birthtimeNs}`;
    const size = Number(st.size);
    if (fileId !== undefined && fileId !== id) after = 0;
    if (after > size) return { file: id, size, next: 0, records: [], unreadable: 0 };

    const buffer = Buffer.alloc(Math.min(limit, size - after));
    const { bytesRead } = buffer.length ? await file.read(buffer, 0, buffer.length, after) : { bytesRead: 0 };
    const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end < 0) return { file: id, size, next: after, records: [], unreadable: 0 };

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
    return { file: id, size, next: after + end + 1, records, unreadable };
  } finally {
    await file.close();
  }
}
