#!/usr/bin/env node
/**
 * test/failover-body-identity.mjs
 *
 * A request that fails over from seat A to seat B (429, or 401/403) is sent
 * the body dario built for A. The body's metadata.user_id has to name B: B's
 * device_id and account_uuid, and the session id B's x-claude-code-session-id
 * header carries. The cch stamp hashes the body, so it is stamped again.
 * A request that does not fail over keeps its bytes.
 *
 * Imports only dist/body-identity.js and dist/cch.js, which read no files:
 * no proxy is started and no ~/.dario is read.
 */
import { readFileSync } from 'node:fs';
import { buildMetadataUserId, rebindBodyIdentity } from '../dist/body-identity.js';
import { stampCch, cchForBody } from '../dist/cch.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const SEEDED = '2.1.177';
const UNSEEDED = '2.1.310';
const A = { deviceId: 'dev-aaaa', accountUuid: 'acct-aaaa-0000', sessionId: 'sess-aaaa-1111' };
const B_IDS = { deviceId: 'dev-bbbb', accountUuid: 'acct-bbbb-0000' };
const B_SESSION = 'sess-bbbb-2222'; // what resolveOutboundSession hands seat B's header
const B = { ...B_IDS, sessionId: B_SESSION };
const C = { deviceId: 'dev-cccc', accountUuid: 'acct-cccc-0000', sessionId: 'sess-cccc-3333' };

// The shape the template build serializes: billing tag first in system,
// metadata between tools and max_tokens. Conversation text quotes A's ids so
// a rewrite that touches anything but metadata.user_id shows up.
function bodyObject(identity, { cch } = {}) {
  const tag = `x-anthropic-billing-header: cc_version=2.1.177.abc; cc_entrypoint=sdk-cli;${cch ? ' cch=12345;' : ''}`;
  return {
    model: 'claude-opus-4-7',
    messages: [{ role: 'user', content: [{ type: 'text', text: `quoting dev-aaaa acct-aaaa-0000 sess-aaaa-1111 and cch=99999; é 😀` }] }],
    system: [{ type: 'text', text: tag }, { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: { n: { type: 'number' } } } }],
    metadata: { user_id: buildMetadataUserId(identity) },
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    stream: true,
  };
}
// What the proxy puts on the wire for `identity` on its first build.
const firstBuild = (identity, version, stamp = true) => {
  const text = JSON.stringify(bodyObject(identity, { cch: version === SEEDED }));
  return Buffer.from(stamp ? stampCch(text, version) : text);
};
const userIdOf = (buf) => JSON.parse(JSON.parse(buf.toString('utf8')).metadata.user_id);
const cchOf = (buf) => /cc_entrypoint=sdk-cli; cch=([0-9a-f]{5});/.exec(buf.toString('utf8'))?.[1] ?? null;
// A string as it appears inside the serialized body: JSON's own escaping.
const asJsonText = (s) => JSON.stringify(s).slice(1, -1);

header('buildMetadataUserId: the bytes the template build has always sent');
check('device_id, account_uuid, session_id in that order',
  buildMetadataUserId(A) === '{"device_id":"dev-aaaa","account_uuid":"acct-aaaa-0000","session_id":"sess-aaaa-1111"}',
  buildMetadataUserId(A));

header('failover A -> B, no cch seed (current Claude Code)');
{
  const sentToA = firstBuild(A, UNSEEDED);
  const sentToB = rebindBodyIdentity(sentToA, B, UNSEEDED);
  const uid = userIdOf(sentToB);
  check('device_id is B\'s', uid.device_id === B.deviceId, uid.device_id);
  check('account_uuid is B\'s', uid.account_uuid === B.accountUuid, uid.account_uuid);
  check('session_id is the one B\'s header carries', uid.session_id === B_SESSION, uid.session_id);
  check('A\'s device and account are gone from metadata',
    !JSON.parse(sentToB.toString('utf8')).metadata.user_id.includes('aaaa'));
  check('the body is what a first build for B would send', sentToB.equals(firstBuild(B, UNSEEDED)));
  const restored = sentToB.toString('utf8').replace(asJsonText(buildMetadataUserId(B)), asJsonText(buildMetadataUserId(A)));
  check('every byte outside user_id is unchanged', restored === sentToA.toString('utf8'));
  check('key order kept', JSON.stringify(Object.keys(JSON.parse(sentToB.toString('utf8')))) === JSON.stringify(Object.keys(bodyObject(A))));
  check('conversation text quoting A\'s ids is untouched',
    JSON.parse(sentToB.toString('utf8')).messages[0].content[0].text === bodyObject(A).messages[0].content[0].text);
  check('no cch appears', cchOf(sentToB) === null);
}

header('failover A -> B, seeded cch version');
{
  const sentToA = firstBuild(A, SEEDED);
  const sentToB = rebindBodyIdentity(sentToA, B, SEEDED);
  check('A\'s body carries a stamped cch', cchOf(sentToA) !== null && cchOf(sentToA) === cchForBody(sentToA.toString('utf8'), SEEDED));
  check('user_id names B with B\'s header session', JSON.stringify(userIdOf(sentToB)) === JSON.stringify({ device_id: B.deviceId, account_uuid: B.accountUuid, session_id: B_SESSION }));
  check('cch is restamped for B\'s body', cchOf(sentToB) === cchForBody(sentToB.toString('utf8'), SEEDED), `${cchOf(sentToB)}`);
  check('the body is what a first build for B would send', sentToB.equals(firstBuild(B, SEEDED)));
  check('the cch quoted in conversation text is untouched', sentToB.toString('utf8').includes('and cch=99999;'));
}

header('failover with DARIO_CCH=random (cchVersion null)');
{
  const sentToA = firstBuild(A, SEEDED, false);
  const sentToB = rebindBodyIdentity(sentToA, B, null);
  check('user_id names B', userIdOf(sentToB).device_id === B.deviceId && userIdOf(sentToB).session_id === B_SESSION);
  check('the placeholder cch is left as it was', cchOf(sentToB) === '12345', `${cchOf(sentToB)}`);
}

header('two hops A -> B -> C');
{
  const sentToC = rebindBodyIdentity(rebindBodyIdentity(firstBuild(A, SEEDED), B, SEEDED), C, SEEDED);
  check('the last seat\'s identity wins', JSON.stringify(userIdOf(sentToC)) === JSON.stringify({ device_id: C.deviceId, account_uuid: C.accountUuid, session_id: C.sessionId }));
  check('equal to a first build for C', sentToC.equals(firstBuild(C, SEEDED)));
}

header('nothing to rebind: the same Buffer comes back');
{
  const sentToA = firstBuild(A, SEEDED);
  const snapshot = Buffer.from(sentToA);
  check('same identity: identical object, identical bytes', rebindBodyIdentity(sentToA, A, SEEDED) === sentToA && sentToA.equals(snapshot));
  check('undefined body stays undefined', rebindBodyIdentity(undefined, B, SEEDED) === undefined);
  const notJson = Buffer.from('not json {');
  check('a body that is not JSON is untouched', rebindBodyIdentity(notJson, B, SEEDED) === notJson);
  const noMeta = Buffer.from(JSON.stringify({ model: 'm', messages: [] }));
  check('no metadata: untouched', rebindBodyIdentity(noMeta, B, SEEDED) === noMeta);
  const numericUid = Buffer.from(JSON.stringify({ metadata: { user_id: 7 } }));
  check('a user_id that is not a string: untouched', rebindBodyIdentity(numericUid, B, SEEDED) === numericUid);
  const arrayBody = Buffer.from('[1,2]');
  check('a JSON array: untouched', rebindBodyIdentity(arrayBody, B, SEEDED) === arrayBody);
}

header('proxy.ts: only an account switch rebinds the body');
{
  const proxy = readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8');
  const switchCalls = proxy.match(/switchAccount\(nextAccount\);/g) ?? [];
  check('the 429 and 401/403 failover sites all go through switchAccount', switchCalls.length === 3, `${switchCalls.length}`);
  check('no failover site sets the session header on its own',
    !/headers\['x-claude-code-session-id'\] = resolveOutboundSession\(nextAccount/.test(proxy));
  check('rebindBodyIdentity is called once, inside switchAccount',
    (proxy.match(/rebindBodyIdentity\(/g) ?? []).length === 1
      && /const switchAccount = [\s\S]{0,900}rebindBodyIdentity\(/.test(proxy));
  check('the rebind is gated on a body the template build wrote', /if \(bodyIdentityOwned\) \{\s*finalBody = rebindBodyIdentity\(/.test(proxy));
  check('header and body share one resolved session id',
    /const sessionId = resolveOutboundSession\(next, clientSessionKey\)\.sessionId;\s*headers\['x-claude-code-session-id'\] = sessionId;/.test(proxy));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
