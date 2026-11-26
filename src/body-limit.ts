/**
 * The request body limit: `--max-body-mb=N` / `DARIO_MAX_BODY_MB` on the CLI,
 * `maxBodyMb` on the proxy options.
 *
 * The body is buffered in memory before it is parsed, so the limit is also the
 * largest buffer one request can hold. Kept apart from cli.ts and proxy.ts so
 * both read the same bounds without either importing the other.
 */

const BYTES_PER_MIB = 1024 * 1024;

/** The limit in MiB when none is set. */
export const DEFAULT_MAX_BODY_MB = 10;

/** The largest limit in MiB whose byte count is still a safe integer (8589934591). */
export const MAX_BODY_MB_CEILING = Math.floor(Number.MAX_SAFE_INTEGER / BYTES_PER_MIB);

/**
 * The request body limit in bytes. A missing size, or one that is not a
 * positive number whose byte count is a safe integer, keeps the default, so
 * the result is always finite.
 */
export function resolveMaxBodyBytes(maxBodyMb: number | undefined): number {
  if (maxBodyMb !== undefined && Number.isFinite(maxBodyMb) && maxBodyMb > 0) {
    const bytes = maxBodyMb * BYTES_PER_MIB;
    if (Number.isSafeInteger(bytes)) return bytes;
  }
  return DEFAULT_MAX_BODY_MB * BYTES_PER_MIB;
}

/**
 * A whole number of MiB written as digits only, from 1 to the ceiling. Anything
 * else (`64MiB`, `6.4`, `-1`, ` `, `0`) is undefined: `parseInt` would read
 * `64MiB` as 64.
 */
export function parseMaxBodyMb(raw: string): number | undefined {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= MAX_BODY_MB_CEILING ? n : undefined;
}

/**
 * The limit the command line and environment ask for, in MiB, or undefined for
 * the default. The flag wins over the env var, even as `--max-body-mb=0`, which
 * keeps the default. An env value that is not a whole number of MiB is
 * ignored. A flag value that is not one throws, naming the unit; the caller
 * exits with the message.
 */
export function resolveMaxBodyMb(argv: readonly string[], env: string | undefined): number | undefined {
  const prefix = '--max-body-mb=';
  const found = argv.find((a) => a.startsWith(prefix));
  if (found !== undefined) {
    const raw = found.slice(prefix.length);
    if (raw.trim() === '0') return undefined;
    const mb = parseMaxBodyMb(raw);
    if (mb === undefined) {
      throw new Error(`Invalid --max-body-mb value: ${JSON.stringify(raw)}. Must be a whole number of MiB from 1 to ${MAX_BODY_MB_CEILING} (0 keeps the default of ${DEFAULT_MAX_BODY_MB}).`);
    }
    return mb;
  }
  return env === undefined ? undefined : parseMaxBodyMb(env);
}
