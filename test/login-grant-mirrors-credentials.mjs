// A grant on the `login` alias updates credentials.json as part of the grant.
//
// mirrorLoginToCredentials (dario#808, test/mirror-login-to-credentials.mjs)
// runs when the pool refreshes the seat. Right after a grant that is hours
// away, and until then credentials.json holds the token of the grant that was
// replaced. These cases drive the manual grant path, completeAddAccount, with
// the token exchange stubbed: nothing leaves the machine.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
}
function header(n) { console.log(`\n=== ${n} ===`); }

// The temp home must be in place before accounts and oauth are imported.
const home = await mkdtemp(join(tmpdir(), 'dario-grant-mirror-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const darioDir = join(home, '.dario');
const credentialsPath = join(darioDir, 'credentials.json');
await mkdir(darioDir, { recursive: true });

// The token endpoint answers every exchange with the tokens set here. Every
// other request (the profile lookup) gets a 404, which the grant tolerates.
let granted = null;
const calls = [];
globalThis.fetch = async (url, init) => {
  const body = typeof init?.body === 'string' ? init.body : '';
  calls.push(String(url));
  if (body.includes('authorization_code')) {
    return new Response(JSON.stringify(granted), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
};

const { completeAddAccount, loadAccount } = await import('../dist/accounts.js');
const { _clearCredentialsCacheForTest } = await import('../dist/oauth.js');

async function writeCredentials(tokens) {
  await writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: tokens }, null, 2));
  _clearCredentialsCacheForTest();
}
async function readCredentials() {
  try { return JSON.parse(await readFile(credentialsPath, 'utf-8')).claudeAiOauth; }
  catch { return null; }
}
const grant = (alias, tokens) => {
  granted = { expires_in: 8 * 3600, scope: 'user:inference user:profile', ...tokens };
  return completeAddAccount(alias, 'code', 'verifier', 'state');
};
const HOUR = 3600_000;

header('a re-grant of login replaces the token credentials.json held');
{
  // The file holds the token of a grant that has since expired.
  await writeCredentials({ accessToken: 'at-dead', refreshToken: 'rt-dead', expiresAt: Date.now() - 5 * HOUR, scopes: ['user:inference'] });
  const before = Date.now();
  const creds = await grant('login', { access_token: 'at-granted', refresh_token: 'rt-granted' });
  const file = await readCredentials();
  check('the token exchange was the stubbed one', calls.length > 0 && creds.accessToken === 'at-granted');
  check('credentials.json holds the granted access and refresh token', file?.accessToken === 'at-granted' && file?.refreshToken === 'rt-granted', JSON.stringify(file && Object.keys(file)));
  check('with the expiry of the pool account', file?.expiresAt === creds.expiresAt && creds.expiresAt >= before + 8 * HOUR - 1000);
  check('and its scopes and grant time', file?.scopes?.join(' ') === 'user:inference user:profile' && file?.grantedAt === creds.grantedAt && creds.grantedAt >= before);
  const pooled = await loadAccount('login');
  check('the pool holds the same token', pooled?.accessToken === 'at-granted' && pooled?.expiresAt === file?.expiresAt);
}

header('a first grant of login creates credentials.json');
{
  await rm(credentialsPath);
  _clearCredentialsCacheForTest();
  await grant('login', { access_token: 'at-first', refresh_token: 'rt-first' });
  check('the file is there with the granted token', (await readCredentials())?.accessToken === 'at-first');
}

header('a grant on another alias leaves credentials.json alone');
{
  const held = await readCredentials();
  const creds = await grant('work', { access_token: 'at-work', refresh_token: 'rt-work' });
  check('the account is saved to the pool', creds.alias === 'work' && (await loadAccount('work'))?.accessToken === 'at-work');
  check('credentials.json still holds the login token', JSON.stringify(await readCredentials()) === JSON.stringify(held));
}

header('a newer credentials.json is not overwritten');
{
  // Another process wrote a token that outlives the one this grant returns.
  await writeCredentials({ accessToken: 'at-newer', refreshToken: 'rt-newer', expiresAt: Date.now() + 24 * HOUR, scopes: ['user:inference'] });
  const creds = await grant('login', { access_token: 'at-shorter', refresh_token: 'rt-shorter', expires_in: 3600 });
  check('the grant is saved to the pool', creds.accessToken === 'at-shorter' && (await loadAccount('login'))?.accessToken === 'at-shorter');
  check('credentials.json keeps the newer token', (await readCredentials())?.accessToken === 'at-newer');
}

header('a mirror that fails does not fail the grant');
{
  // credentials.json is a directory: it can be neither read as a token nor written.
  await rm(credentialsPath);
  await mkdir(credentialsPath);
  _clearCredentialsCacheForTest();
  const errors = [];
  const realError = console.error;
  console.error = (...args) => { errors.push(args.join(' ')); };
  let creds = null;
  let thrown = null;
  try {
    creds = await grant('login', { access_token: 'at-kept', refresh_token: 'rt-kept' });
  } catch (err) {
    thrown = err;
  } finally {
    console.error = realError;
  }
  check('the grant resolves', thrown === null && creds?.accessToken === 'at-kept', String(thrown));
  check('the pool holds the granted token', (await loadAccount('login'))?.accessToken === 'at-kept');
  check('the failure is logged, without a token in the line', errors.some((l) => l.includes('could not mirror the granted login token')) && !errors.some((l) => l.includes('at-kept') || l.includes('rt-kept')), errors.join(' | '));
}

await rm(home, { recursive: true, force: true });
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
