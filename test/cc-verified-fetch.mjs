#!/usr/bin/env node
/**
 * Tests for scripts/cc-verified-fetch.mjs, the workflow step that calls it,
 * the daily check that runs it against the real registry, and the live test's
 * use of it.
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
import { Writable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NPM_REGISTRY_KEYS, REGISTRY, fetchVerified, isPlainVersion, metadataProblem, platformPackage, scopedName, signedByRegistry, signedMessage, tarballUrl, versionUrl,
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
check('the version document\'s address carries the scope and the name as one path segment', versionUrl(LINUX, '2.1.322') === `${REGISTRY}/@anthropic-ai%2fclaude-code-linux-x64/2.1.322`);
check('a scoped name is two plain parts and nothing else', scopedName(LINUX)?.scope === '@anthropic-ai' && scopedName(LINUX)?.base === 'claude-code-linux-x64'
  && [undefined, 'claude-code', '@a/b/c', '@a/', '@/b', '@a/b?x=1', '@a/../b', '@A/b', '@a/b c'].every((n) => scopedName(n) === null && versionUrl(n, '1.2.3') === null && tarballUrl(n, '1.2.3') === null));
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
// A signed package with no binary in it, served as another version.
mkdirSync(join(tmp, 'src2', 'package'), { recursive: true });
writeFileSync(join(tmp, 'src2', 'package', 'other.txt'), 'no binary here\n');
execFileSync('tar', ['-czf', 'pkg.tgz', 'package'], { cwd: join(tmp, 'src2') });
const noBinary = readFileSync(join(tmp, 'src2', 'pkg.tgz'));
const noBinaryIntegrity = `sha512-${createHash('sha512').update(noBinary).digest('base64')}`;
const tarIntegrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
let served = { tarball, signer: mine, hits: [] };
const server = createServer((req, res) => {
  served.hits.push(req.url);
  const base = `http://127.0.0.1:${server.address().port}`;
  if (req.url === new URL(versionUrl(LINUX, '9.9.9', base)).pathname) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ name: LINUX, version: '9.9.9', dist: { integrity: tarIntegrity, tarball: tarballUrl(LINUX, '9.9.9', base), signatures: [{ keyid: 'SHA256:test-key', sig: sigBy(served.signer, LINUX, '9.9.9', tarIntegrity) }] } }));
  }
  if (req.url === new URL(versionUrl(LINUX, '9.9.7', base)).pathname) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ name: LINUX, version: '9.9.7', dist: { integrity: noBinaryIntegrity, tarball: tarballUrl(LINUX, '9.9.7', base), signatures: [{ keyid: 'SHA256:test-key', sig: sigBy(mine, LINUX, '9.9.7', noBinaryIntegrity) }] } }));
  }
  if (req.url === `/${LINUX}/-/claude-code-linux-x64-9.9.7.tgz`) return res.end(noBinary);
  if (req.url === `/${LINUX}/-/claude-code-linux-x64-9.9.9.tgz`) {
    if (!served.cut) return res.end(served.tarball);
    // A connection cut part way: the length promises the whole tarball, half of it arrives, then the socket closes.
    res.writeHead(200, { 'content-length': served.tarball.length });
    res.write(served.tarball.subarray(0, Math.floor(served.tarball.length / 2)));
    return setTimeout(() => res.destroy(), 50);
  }
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
check('a name that is not a scoped npm name is refused without a request', /not a scoped npm name/.test(await refusal({ version: '9.9.9', dest, name: 'claude-code' })) && served.hits.length === 2);

const FAILED = /^the download or the write failed before the build was verified$/;
served = { tarball, signer: mine, hits: [], cut: true };
check('a download cut part way is a refusal, and nothing is left behind', FAILED.test(await refusal({ version: '9.9.9', dest })) && !existsSync(dest));

served = { tarball, signer: mine, hits: [] };
const fullDisk = () => new Writable({ write(_chunk, _enc, cb) { cb(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })); } });
check('a disk that cannot be written is a refusal, not a crash, and nothing is left behind', FAILED.test(await refusal({ version: '9.9.9', dest, openTarball: fullDisk })) && !existsSync(dest));
const neverOpens = () => { const w = new Writable({ write(_c, _e, cb) { cb(); } }); process.nextTick(() => w.destroy(new Error('EACCES: permission denied'))); return w; };
check('a file that fails before any byte is written is a refusal too', FAILED.test(await refusal({ version: '9.9.9', dest, openTarball: neverOpens })) && !existsSync(dest));
check('a download past the size a build can have is refused part way, and nothing is left behind', /larger than a Claude Code build/.test(await refusal({ version: '9.9.9', dest, maxBytes: 16 })) && !existsSync(dest));
check('after those failures the same call still succeeds', existsSync(await fetchVerified({ version: '9.9.9', dest, name: LINUX, registry, keys: KEYS })));

// A destination that already holds a build an earlier call verified: a later refusal must not leave it there to be used.
const again = () => fetchVerified({ version: '9.9.9', dest, name: LINUX, registry, keys: KEYS });
const held = await again();
check('a refusal of the arguments leaves an earlier build where it was',
  /not a bare x\.y\.z/.test(await refusal({ version: 'latest', dest })) && /no package for this platform/.test(await refusal({ version: '9.9.9', dest, name: null }))
  && /not a scoped npm name/.test(await refusal({ version: '9.9.9', dest, name: 'claude-code' })) && existsSync(held));
check('a version the registry does not have removes an earlier build', /HTTP 404/.test(await refusal({ version: '9.9.8', dest })) && !existsSync(dest));
await again();
served = { tarball, signer: other, hits: [] };
check('a version signed by a key that is not kept removes an earlier build, before any download', /no signature from a registry key kept/.test(await refusal({ version: '9.9.9', dest })) && !existsSync(dest) && served.hits.length === 1);
served = { tarball, signer: mine, hits: [] };
await again();
check('a registry that cannot be reached removes an earlier build', /has no .* at this version \(HTTP none\)/.test(await refusal({ version: '9.9.9', dest, registry: 'http://127.0.0.1:1' })) && !existsSync(dest));
await again();
await again();
check('a signed package with no binary in it is refused, and an earlier build goes with it', /^the claude binary could not be unpacked from the tarball$/.test(await refusal({ version: '9.9.7', dest })) && !existsSync(dest));
const stuck = () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };
check('when the destination cannot be removed the refusal says so, whatever went wrong first',
  /^the build was not verified, and the destination could not be removed$/.test(await refusal({ version: '9.9.8', dest, removeDest: stuck }))
  && /^the build was not verified, and the destination could not be removed$/.test(await refusal({ version: '9.9.9', dest, removeDest: stuck, fetchImpl: async () => { throw new Error('offline'); } })));
await again();
check('an answer that is not JSON removes an earlier build', /not JSON/.test(await refusal({ version: '9.9.9', dest, fetchImpl: async () => new Response('<html>', { status: 200 }) })) && !existsSync(dest));
server.close();
rmSync(tmp, { recursive: true, force: true });

header('the command');
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' });
check('no arguments, or too many, is a usage error (exit 2)', cli().status === 2 && cli('2.1.322').status === 2 && cli('2.1.322', 'a', 'b').status === 2);
const bad = cli('latest', join(tmpdir(), 'cc-verified-never'));
check('a refusal exits 1 with one line on stderr and prints no path', bad.status === 1 && bad.stdout === '' && bad.stderr === 'the version is not a bare x.y.z\n');
const source = readFileSync(SCRIPT, 'utf-8');
check('the download and the file are one pipeline, so an error on either side is caught', source.includes("import { pipeline } from 'node:stream/promises';") && /await pipeline\(\s*Readable\.fromWeb\(res\.body\),/.test(source) && !source.includes('.replace('));

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

header('the daily check');
// cc-verified-fetch-check.yml is the one place the fetch meets the real registry on a schedule. It runs on a
// self-hosted runner, so what it may be triggered by and what it may read are checked here.
const daily = readFileSync(join(REPO, '.github', 'workflows', 'cc-verified-fetch-check.yml'), 'utf-8');
const dailyOn = daily.slice(daily.indexOf('\non:\n'), daily.indexOf('\npermissions:\n'));
const dailyRun = daily.split('run: |')[1] ?? '';
check('it runs daily, on demand and when the script changes, and never on a pull request',
  /\n  schedule:\n    - cron: '\d+ \d+ \* \* \*'/.test(dailyOn) && dailyOn.includes('\n  workflow_dispatch:\n')
  && /\n  push:\n    branches: \[master\]\n    paths:\n      - scripts\/cc-verified-fetch\.mjs\n/.test(dailyOn) && !/pull_request/.test(daily));
check('it is this repository\'s job only, and its token can only read',
  daily.includes("if: github.repository == 'askalf/dario'") && /\npermissions:\n  contents: read\n\n/.test(daily) && !/: write\b/.test(daily) && !daily.includes('secrets.'));
check('the fetch and the binary run under an empty environment with a throwaway HOME',
  dailyRun.includes('scrubbed() { env -i PATH="$PATH" HOME="$home" "$@"; }')
  && dailyRun.includes('scrubbed node scripts/cc-verified-fetch.mjs "$latest" "$dest"')
  && dailyRun.includes('scrubbed node scripts/range-bump-carrier.mjs pick-binary "$latest" "$fetched"'));
check('it installs nothing with npm, and what it unpacked is removed', dailyRun.length > 0 && !/npm (?:i|install|ci|update)\b/.test(dailyRun)
  && dailyRun.includes(`trap 'rm -rf -- "$home" "$dest"' EXIT`));
check('a build that cannot be verified fails the run with the script\'s reason',
  /if ! fetched="\$\(scrubbed node scripts\/cc-verified-fetch\.mjs[^\n]*\n\s*echo "::error::[^\n]*could not be fetched and verified[^\n]*"\n\s*exit 1/.test(dailyRun));
check('a fetched build that reports another version fails the run',
  /if \[ -z "\$bin" \]; then\n\s*echo "::error::[^\n]*does not report that version"\n\s*exit 1/.test(dailyRun));
check('npm not naming a version is not a failure of the key or the script',
  /if \[\[ ! "\$latest" =~ \^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]; then\n[^\n]*\n\s*echo "::warning::[^\n]*nothing was checked this run"\n\s*exit 0/.test(dailyRun));

header('the live test');
// live-test.yml runs a pull request's head on the dario-exec runner. A head that claims a Claude Code newer
// than the runner's used to get it from `npm i` plus the package's own install script. It now comes from the
// same verifying fetch, and a build that cannot be verified fails the check.
const live = readFileSync(join(REPO, '.github', 'workflows', 'live-test.yml'), 'utf-8');
const liveFrom = live.indexOf('- name: "Stages: install, build, cc-detect, cli, doctor"');
const liveRun = live.slice(liveFrom, live.indexOf('\n      - name: ', liveFrom + 10)).split('run: |')[1] ?? '';
check('the claimed build is fetched by the verifying script into the run\'s throwaway HOME, under an empty environment',
  liveRun.includes('fetched="$(env -i PATH="$PATH" HOME="$WT_HOME" node scripts/cc-verified-fetch.mjs "$claimed" "$WT_HOME/cc" 2> "$WT_HOME/cc-fetch.err" || true)"'));
check('Claude Code is not installed with npm, and no package script is run',
  liveRun.length > 0 && !liveRun.includes('@anthropic-ai/claude-code') && !liveRun.includes('install.cjs') && !/npm (?:i|install|update)\b/.test(liveRun));
check('the fetched binary has to report the claimed version, under the same empty environment, before the stages use it',
  liveRun.includes('installed="$(env -i PATH="$PATH" HOME="$WT_HOME" "$fetched" --version')
  && /if \[ -n "\$fetched" \] && \[ "\$installed" = "\$claimed" \]; then\n\s*CC_PATH="\$\(readlink -f "\$fetched"\)"/.test(liveRun));
check('a build that cannot be verified fails the check with the script\'s reason',
  /elif \[ -z "\$fetched" \]; then\n\s*cc_fail="[^\n]*could not be fetched and verified: \$\(head -c 200 "\$WT_HOME\/cc-fetch\.err"[^\n]*\n\s*echo "::error::\$\{cc_fail\}/.test(liveRun)
  && /if \[ -n "\$cc_fail" \]; then\n\s*echo "cc-fetch: FAIL \(\$\{cc_fail\}\)" \| tee -a "\$report"\n\s*fail="cc-fetch"/.test(liveRun));
check('a fetched build that reports another version fails the check too',
  /else\n\s*cc_fail="the build fetched for claude-code@\$\{claimed\} reports [^\n]*\n\s*echo "::error::\$\{cc_fail\}/.test(liveRun));

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
