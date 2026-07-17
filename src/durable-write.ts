/**
 * Durable atomic file writes for credential persistence.
 *
 * Why this exists (dario#790): the pool refresh loop already writes rotated
 * tokens back to `~/.dario/accounts/<alias>.json` and `credentials.json` via
 * writeFile(tmp) + rename. But a plain rename only guarantees atomicity of the
 * *directory entry*, not that the file's data blocks — or the rename itself —
 * have reached stable storage. On an abrupt container recreate (`docker rm -f`
 * → SIGKILL, the autodeploy path), the page cache is discarded before the
 * kernel flushes, so a bind-mounted `~/.dario` reverts to the last *durably*
 * persisted content: the mint-time file. That is the observed "credentials
 * frozen at the mint ms stamp after 25h of successful in-memory refreshes"
 * failure — every recreate after >8h loads a rotated-away refresh token and
 * every request 401s.
 *
 * The fix: fsync the temp file's data before the rename, then fsync the parent
 * directory after the rename so the rename itself is durable. This is the
 * standard write-temp → fsync(file) → rename → fsync(dir) sequence.
 */
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Atomically and durably write `data` to `targetPath`.
 *
 * Writes to a pid/random-qualified temp file in the same directory (so the
 * rename is same-filesystem and therefore atomic), fsyncs the temp file,
 * renames it over the target, then fsyncs the parent directory so the rename
 * survives power loss / SIGKILL.
 *
 * `mode` sets the temp file permissions (0o600 for credential files).
 *
 * On platforms/filesystems where a directory fsync isn't supported (some
 * Windows and network filesystems throw EINVAL/EPERM/ENOTSUP on fsync of a
 * directory handle), the dir-fsync failure is swallowed: the data fsync +
 * atomic rename already covers the common Linux container case this targets,
 * and a hard failure here would be worse than a best-effort flush.
 */
export async function durableWriteFile(
  targetPath: string,
  data: string,
  mode = 0o600,
): Promise<void> {
  const dir = dirname(targetPath);
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;

  // Write + fsync the temp file's contents to stable storage.
  const fh = await open(tmp, 'w', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }

  try {
    await rename(tmp, targetPath);
  } catch (err) {
    // Windows can fail a rename over a busy file. Fall back to a direct
    // (still-fsynced) overwrite so we never leave the caller without a write.
    try {
      const direct = await open(targetPath, 'w', mode);
      try {
        await direct.writeFile(data);
        await direct.sync();
      } finally {
        await direct.close();
      }
      try { await unlink(tmp); } catch { /* best effort */ }
      return;
    } catch {
      // Surface the original rename error — the fallback couldn't recover.
      try { await unlink(tmp); } catch { /* best effort */ }
      throw err;
    }
  }

  // fsync the parent directory so the rename (the new dirent) is durable.
  try {
    const dh = await open(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // Directory fsync unsupported on this fs/platform — data fsync + atomic
    // rename above is the meaningful guarantee for the Linux container case.
  }
}
