/**
 * The account identity a built Claude Code body carries, and how it moves to
 * another seat when a request fails over mid-flight.
 *
 * The template build stamps `metadata.user_id` from the selected account's
 * device_id and account_uuid plus the session id the
 * `x-claude-code-session-id` header carries. A 429 or 401/403 failover sends
 * the same body to a different account, so the body must name that account
 * and the session id its header now carries; otherwise seat B is sent seat
 * A's device_id and account_uuid and a session_id that disagrees with its own
 * header. The cch stamp (src/cch.ts) hashes the body, user_id included, so a
 * rewritten body is stamped again.
 *
 * Pure, and imports nothing that reads the filesystem, so it is unit-testable
 * without a proxy or a ~/.dario.
 */
import { stampCch } from './cch.js';

/** The three values `metadata.user_id` is built from. */
export interface BodyIdentity {
  deviceId: string;
  accountUuid: string;
  sessionId: string;
}

/**
 * The `metadata.user_id` string Claude Code sends: a JSON object with
 * device_id, account_uuid and session_id in that order. Shared by the
 * template build and the failover rebind so both produce the same bytes.
 */
export function buildMetadataUserId(identity: BodyIdentity): string {
  return JSON.stringify({
    device_id: identity.deviceId,
    account_uuid: identity.accountUuid,
    session_id: identity.sessionId,
  });
}

/**
 * `body` with `metadata.user_id` rebuilt for `identity`, for a request that
 * fails over to another account. `cchVersion` is the Claude Code version to
 * stamp cch for after the rewrite, or null where the first serialize did not
 * stamp (DARIO_CCH=random); stampCch is itself a no-op without a seed.
 *
 * Returns `body` itself, the same Buffer, when there is nothing to rebind: no
 * body, a body that is not JSON, no string `metadata.user_id`, or a user_id
 * that already names `identity`. The body was serialized by JSON.stringify,
 * so parse and stringify again give the same bytes apart from user_id, and
 * user_id is replaced in place so key order is kept.
 */
export function rebindBodyIdentity(
  body: Buffer | undefined,
  identity: BodyIdentity,
  cchVersion: string | null,
): Buffer | undefined {
  if (!body) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  const metadata = (parsed as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return body;
  const meta = metadata as Record<string, unknown>;
  if (typeof meta.user_id !== 'string') return body;
  const userId = buildMetadataUserId(identity);
  if (meta.user_id === userId) return body;
  meta.user_id = userId;
  let text = JSON.stringify(parsed);
  if (cchVersion !== null) text = stampCch(text, cchVersion);
  return Buffer.from(text);
}
