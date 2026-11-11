#!/usr/bin/env node
/**
 * Tests for scripts/cc-verified-fetch.mjs and the workflow step that calls it.
 *
 * The template watcher pins a dispatched run to one Claude Code version. When
 * no installed binary reports it, the build is fetched and has to be proved
 * to be the one npm published: a signature from a registry key kept in the
 * script, over the name, the version and the sha512 the tarball then has to
 * have. The checks here use a real signature the registry served (so the kept
 * key and the signed message are right), keys made for the test, and a local
 * registry that serves a small signed package, so nothing leaves the machine.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NPM_REGISTRY_KEYS, REGISTRY, fetchVerified, isPlainVersion, metadataProblem, platformPackage, signedByRegistry, signedMessage, tarballUrl,
} from '../scripts/cc-verified-fetch.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${extra !== undefined ? ' :: ' + extra : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'cc-verified-fetch.mjs');
const LINUX = '@anthropic-ai/claude-code-linux-x64';

header('the platform package');
check('linux x64 and arm64, glibc and musl', platformPackage('linux', 'x64') === LINUX && platformPackage('linux', 'arm64') === '@anthropic-ai/claude-code-linux-arm64'
  && platformPackage('linux', 'x64', true) === '@anthropic-ai/claude-code-linux-x64-musl');
check('macOS and Windows have theirs, and musl means nothing there', platformPackage('darwin', 'arm64', true) === '@anthropic-ai/claude-code-darwin-arm64' && platformPackage('win32', 'x64') === '@anthropic-ai/claude-code-win32-x64');
check('a platform or a processor Claude Code ships nothing for is null', platformPackage('freebsd', 'x64') === null && platformPackage('linux', 'ia32') === null);
check('only a bare x.y.z is a version', isPlainVersion('2.1.322') && !isPlainVersion('2.1') && !isPlainVersion('latest') && !isPlainVersion('2.1.322-beta.1') && !isPlainVersion(' 2.1.322') && !isPlainVersion(undefined));

header('a signature the registry served');
// @anthropic-ai/claude-code-linux-x64@2.1.322, read from registry.npmjs.org on 2026-11-11: public data.
const REAL = {
  name: LINUX,
  version: '2.1.322',
  integrity: 'sha512-0DoaNAXLWCYYIGachWBCkTUsS8dOOgvk4R2fFKdrLejO9XlRTwaWUMD9ONdDmv0csdpwxj4qLUN6zWMaG2Sz6g==',
  signatures: [{ keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U', sig: 'MEUCIQDr/uGgymxJ6XYAPboW3/V3kChBIDsgKg1w5gHvbaSEcgIgJCKMZ/ghDMjE23J/JFW7Cb98uMvfFFEDhQB1m9/DG6I=' }],
};
check('the kept key verifies it', signedByRegistry(REAL) === true);
check('the signed message is name@version:integrity', signedMessage('a/b', '1.2.3', 'sha512-x') === 'a/b@1.2.3:sha512-x');
check('another version, another package or another integrity under the same signature is refused',
  !signedByRegistry({ ...REAL, version: '2.1.323' }) && !signedByRegistry({ ...REAL, name: '@anthropic-ai/claude-code' })
  && !signedByRegistry({ ...REAL, integrity: REAL.integrity.replace('0Doa', '0Dob') }));
check('exactly one key is kept, and it has no expiry on the registry', Object.keys(NPM_REGISTRY_KEYS).length === 1 && Object.keys(NPM_REGISTRY_KEYS)[0] === REAL.signatures[0].keyid);

header('signatures and keys');
const mine = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const spki = (k) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const KEYS = { 'SHA256:test-key': spki(mine) };
const sigBy = (k, name, version, integrity) => sign('sha256', Buffer.from(signedMessage(name, version, integrity)), { key: k.privateKey, dsaEncoding: 'der' }).toString('base64');
const INTEGRITY = `sha512-${createHash('sha512').update('x').digest('base64')}`;
const good = { name: LINUX, version: '9.9.9', integrity: INTEGRITY, signatures: [{ keyid: 'SHA256:test-key', sig: sigBy(mine, LINUX, '9.9.9', INTEGRITY) }] };
check('a signature by a kept key verifies', signedByRegistry(good, KEYS));
check('one good signature among bad ones is enough', signedByRegistry({ ...good, signatures: [{ keyid: 'SHA256:test-key', sig: 'AAAA' }, null, { keyid: 'SHA256:gone', sig: good.signatures[0].sig }, good.signatures[0]] }, KEYS));
check('a key id that is not kept counts for nothing, even with a valid signature by that key', !signedByRegistry({ ...good, signatures: [{ keyid: 'SHA256:other', sig: sigBy(other, LINUX, '9.9.9', INTEGRITY) }] }, KEYS));
check('a kept key id over a signature by another key is refused', !signedByRegistry({ ...good, signatures: [{ keyid: 'SHA256:test-key', sig: sigBy(other, LINUX, '9.9.9', INTEGRITY) }] }, KEYS));
check('a key id that is a property of every object is not a kept key', !signedByRegistry({ ...good, signatures: [{ keyid: 'constructor', sig: good.signatures[0].sig }, { keyid: '__proto__', sig: good.signatures[0].sig }] }, KEYS));
check('no signatures, or fields of the wrong type, are refused', !signedByRegistry({ ...good, signatures: [] }, KEYS) && !signedByRegistry({ ...good, signatures: undefined }, KEYS) && !signedByRegistry({ ...good, integrity: 7 }, KEYS));

header('the version document');
const REG = 'http://127.0.0.1:1';
const doc = (over = {}, dist = {}) => ({ name: LINUX, version: '9.9.9', dist: { integrity: INTEGRITY, tarball: tarballUrl(LINUX, '9.9.9', REG), signatures: good.signatures, ...dist }, ...over });
const problem = (d) => metadataProblem(d, LINUX, '9.9.9', { registry: REG, keys: KEYS });
check('the registry\'s tarball address for a scoped package', tarballUrl(LINUX, '2.1.322') === `${REGISTRY}/@anthropic-ai/claude-code-linux-x64/-/claude-code-linux-x64-2.1.322.tgz`);
check('a document that names the package and version, with its own tarball address and a kept signature, has no problem', problem(doc()) === null);
check('another name or version is refused', /another package or version/.test(problem(doc({ name: '@anthropic-ai/claude-code' }))) && /another package or version/.test(problem(doc({ version: '9.9.8' }))));
check('a tarball anywhere else is refused, a sibling path on the same host too', /not the registry's own/.test(problem(doc({}, { tarball: 'https://example.com/x.tgz' })))
  && /not the registry's own/.test(problem(doc({}, { tarball: tarballUrl(LINUX, '9.9.8', REG) }))));
check('an integrity that is not sha512 is refused', /no sha512 integrity/.test(problem(doc({}, { integrity: 'sha1-abc' }))) && /no sha512 integrity/.test(problem(doc({}, { integrity: undefined }))));
check('a document with no kept signature is refused', /no signature from a registry key kept/.test(problem(doc({}, { signatures: [] }))));
check('no document, or one with no dist, is refused', /no version document/.test(problem(null)) && /no dist entry/.test(problem({ name: LINUX, version: '9.9.9' })));

header('fetch, verify, unpack: a local registry');
const tmp = mkdtempSync(join(tmpdir(), 'cc-verified-'));
const pkgDir = join(tmp, 'src', 'package');
mkdirSync(pkgDir, { recursive: true });
for (const f of ['claude', 'claude.exe', 'other.txt']) writeFileSync(join(pkgDir, f), `the ${f} of the test package\n`);
execFileSync('tar', ['-czf', 'pkg.tgz', 'package'], { cwd: join(tmp, 'src') });
const tarball = readFileSync(join(tmp, 'src', 'pkg.tgz'));
const tarIntegrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
let served = { tarball, signer: mine, hits: [] };
const server = createServer((req, res) => {
  served.hits.push(req.url);
  const base = `http://127.0.0.1:${server.address().port}`;
  if (req.url === `/${LINUX.replace('/', '%2f')}/9.9.9`) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ name: LINUX, version: '9.9.9', dist: { integrity: tarIntegrity, tarball: tarballUrl(LINUX, '9.9.9', base), signatures: [{ keyid: 'SHA256:test-key', sig: sigBy(served.signer, LINUX, '9.9.9', tarIntegrity) }] } }));
  }
  if (req.url === `/${LINUX}/-/claude-code-linux-x64-9.9.9.tgz`) return res.end(served.tarball);
  res.statusCode = 404;
  return res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const registry = `http://127.0.0.1:${server.address().port}`;
const refusal = async (opts) => { try { await fetchVerified({ name: LINUX, registry, keys: KEYS, ...opts }); return null; } catch (e) { return e.message; } };

const dest = join(tmp, 'out');
const bin = await fetchVerified({ version: '9.9.9', dest, name: LINUX, registry, keys: KEYS });
const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
check('a signed build is unpacked and its binary named', bin === join(dest, 'package', binName) && readFileSync(bin, 'utf-8') === `the ${binName} of the test package\n`);
check('only the binary is unpacked, and the tarball is not kept', !existsSync(join(dest, 'package', 'other.txt')) && !existsSync(join(dest, 'package.tgz')));

served = { tarball: Buffer.concat([tarball, Buffer.from('x')]), signer: mine, hits: [] };
check('a tarball that is not the signed bytes is refused, and nothing is left behind', /sha512 differs/.test(await refusal({ version: '9.9.9', dest })) && !existsSync(dest));

served = { tarball, signer: other, hits: [] };
check('a version signed by a key that is not kept is refused before any download', /no signature from a registry key kept/.test(await refusal({ version: '9.9.9', dest })) && served.hits.length === 1 && !existsSync(dest));

served = { tarball, signer: mine, hits: [] };
check('a version the registry does not have is refused', /has no .* at this version \(HTTP 404\)/.test(await refusal({ version: '9.9.8', dest })));
check('a version that is not x.y.z, or a platform with no package, is refused without a request',
  /not a bare x\.y\.z/.test(await refusal({ version: 'latest', dest })) && /no package for this platform/.test(await refusal({ version: '9.9.9', dest, name: null })) && served.hits.length === 1);
check('with the real keys the test registry is not trusted', /no signature from a registry key kept/.test(await refusal({ version: '9.9.9', dest, keys: NPM_REGISTRY_KEYS })));
server.close();
rmSync(tmp, { recursive: true, force: true });

header('the command');
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });
check('no arguments, or too many, is a usage error (exit 2)', cli().status === 2 && cli('2.1.322').status === 2 && cli('2.1.322', 'a', 'b').status === 2);
const bad = cli('latest', join(tmpdir(), 'cc-verified-never'));
check('a refusal exits 1 with one line on stderr and prints no path', bad.status === 1 && bad.stdout === '' && bad.stderr === 'the version is not a bare x.y.z\n');

header('the workflow step');
const template = readFileSync(join(REPO, '.github', 'workflows', 'cc-drift-template-watch.yml'), 'utf-8');
const from = template.indexOf('- name: Pin this run to the dispatched Claude Code version');
const pinRun = template.slice(from, template.indexOf('\n      - name: ', from + 10)).split('run: |')[1] ?? '';
check('the step installs nothing with npm', pinRun.length > 0 && !/npm (?:i|install|ci|update)\b/.test(pinRun));
check('the build is fetched by the verifying script, into the job\'s own temp directory',
  pinRun.includes('node scripts/cc-verified-fetch.mjs "$WANTED" "${RUNNER_TEMP}/claude-code-${WANTED}"'));
check('the fetched binary still has to report the version before the run is pinned to it',
  pinRun.indexOf('node scripts/range-bump-carrier.mjs pick-binary "$WANTED" "$fetched"') > pinRun.indexOf('node scripts/cc-verified-fetch.mjs'));
check('a build that cannot be verified leaves the run going, unpinned', /if ! fetched="\$\(node scripts\/cc-verified-fetch\.mjs[^\n]*\n\s*echo "::warning::[^\n]*the run is not pinned"\n\s*exit 0/.test(pinRun));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
