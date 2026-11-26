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

/**
 * The largest limit in MiB. The body is buffered and decoded as one string
 * before it is parsed, so the limit has to stay inside what that can hold, 32-bit
 * Node's string length (256 MiB less 16 code units) included.
 */
export const MAX_BODY_MB_CEILING = 128;

/**
 * The request body limit in bytes. A missing size, or one that is not a whole
 * number of MiB from 1 to the ceiling, keeps the default.
 */
export function resolveMaxBodyBytes(maxBodyMb: number | undefined): number {
  if (maxBodyMb !== undefined && Number.isInteger(maxBodyMb) && maxBodyMb >= 1 && maxBodyMb <= MAX_BODY_MB_CEILING) {
    return maxBodyMb * BYTES_PER_MIB;
  }
  return DEFAULT_MAX_BODY_MB * BYTES_PER_MIB;
}

/**
 * A whole number of MiB written as digits only, from 1 to the ceiling, with no
 * surrounding whitespace. Anything else (`64MiB`, `6.4`, `-1`, ` 64`, `0`) is
 * undefined: `parseInt` would read `64MiB` as 64.
 */
export function parseMaxBodyMb(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 && n <= MAX_BODY_MB_CEILING ? n : undefined;
}

/**
 * The limit the command line and environment ask for, in MiB, or undefined for
 * the default. The flag wins over the env var, even as `--max-body-mb=0`, which
 * keeps the default. An env value that is not a whole number of MiB is
 * ignored. A flag value that is not one, a bare `--max-body-mb` with no
 * value, or the flag given more than once throws, naming the unit; the caller
 * exits with the message.
 */
export function resolveMaxBodyMb(argv: readonly string[], env: string | undefined): number | undefined {
  const prefix = '--max-body-mb=';
  const given = argv.filter((a) => a === '--max-body-mb' || a.startsWith(prefix));
  if (given.length > 1) {
    throw new Error(`Invalid --max-body-mb: given ${given.length} times. Give it once, as a whole number of MiB from 1 to ${MAX_BODY_MB_CEILING}.`);
  }
  const found = given[0];
  if (found !== undefined) {
    const raw = found.startsWith(prefix) ? found.slice(prefix.length) : '';
    if (raw === '0') return undefined;
    const mb = parseMaxBodyMb(raw);
    if (mb === undefined) {
      throw new Error(`Invalid --max-body-mb value: ${JSON.stringify(raw)}. Must be a whole number of MiB from 1 to ${MAX_BODY_MB_CEILING} (0 keeps the default of ${DEFAULT_MAX_BODY_MB}).`);
    }
    return mb;
  }
  return env === undefined ? undefined : parseMaxBodyMb(env);
}
