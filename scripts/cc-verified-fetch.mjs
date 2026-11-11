#!/usr/bin/env node
/**
 * Fetch one Claude Code build and prove npm published it, without `npm install`.
 *
 * cc-drift-template-watch.yml pins a dispatched run to the Claude Code version
 * it was dispatched for. When no installed `claude` reports that version the
 * run needs the build, on a runner that holds a login. `npm i -g` put it there
 * by version alone: nothing in this repository said what the bytes had to be,
 * the package's install script ran on the runner, and the copy under the
 * tool-cache Node was replaced as a side effect.
 *
 * The version is only known when the run is dispatched, so no hash of it can
 * be committed ahead of time. What can be committed is who has to have signed
 * it. The npm registry signs `<name>@<version>:<integrity>` for every version
 * it serves, with a key it publishes at /-/npm/v1/keys. That key is kept here
 * (NPM_REGISTRY_KEYS), so this file decides what counts as published by npm,
 * and a key the registry starts serving tomorrow is not trusted until someone
 * adds it here.
 *
 * What is fetched is the platform package (`@anthropic-ai/claude-code-linux-x64`
 * and its siblings). Since Claude Code went native the main package is a stub
 * whose install script copies the platform package's one binary into place;
 * that binary is what runs, so it is the thing to verify, and it runs from
 * where it is unpacked with no install step at all.
 *
 *   node scripts/cc-verified-fetch.mjs <X.Y.Z> <dest dir>
 *
 * Prints the path of the unpacked `claude` binary and exits 0. Anything that
 * cannot be established (an unsupported platform, metadata that does not name
 * the package and version asked for, no valid signature from a kept key, a
 * tarball whose sha512 is not the signed one) exits 1 with one line on stderr
 * and leaves no binary behind. A usage error exits 2.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REGISTRY = 'https://registry.npmjs.org';
export const PACKAGE_PREFIX = '@anthropic-ai/claude-code';

/**
 * The npm registry's signing keys this repository trusts: key id to the
 * public key, base64 of its DER SubjectPublicKeyInfo (ECDSA P-256), as
 * https://registry.npmjs.org/-/npm/v1/keys serves them. Read 2026-11-11: the
 * one key listed there with no expiry. The key that expired on 2025-01-29 is
 * left out on purpose.
 */
export const NPM_REGISTRY_KEYS = Object.freeze({
  'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U':
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==',
});

/** A tarball larger than this is not a Claude Code build (the binary is about 340 MB unpacked). */
export const MAX_TARBALL_BYTES = 1024 * 1024 * 1024;

export const isPlainVersion = (v) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);

/**
 * The platform package for a platform, or null when Claude Code ships none
 * for it. `musl` is true on a Linux whose libc is musl. Pure.
 */
export function platformPackage(platform, arch, musl = false) {
  if (arch !== 'x64' && arch !== 'arm64') return null;
  if (platform === 'linux') return `${PACKAGE_PREFIX}-linux-${arch}${musl ? '-musl' : ''}`;
  if (platform === 'darwin' || platform === 'win32') return `${PACKAGE_PREFIX}-${platform}-${arch}`;
  return null;
}

/** True on a Linux that does not run glibc. */
export function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    return !process.report?.getReport?.().header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/** What the registry signs for one version. Pure. */
export const signedMessage = (name, version, integrity) => `${name}@${version}:${integrity}`;

/**
 * True when at least one of `signatures` ([{ keyid, sig }], as in a version's
 * `dist.signatures`) is a valid signature over the version's signed message
 * by a key in `keys`. A signature under a key id that is not kept, a
 * signature that does not verify and a malformed entry each count for
 * nothing. Pure.
 */
export function signedByRegistry({ name, version, integrity, signatures }, keys = NPM_REGISTRY_KEYS) {
  if (typeof name !== 'string' || typeof version !== 'string' || typeof integrity !== 'string' || !Array.isArray(signatures)) return false;
  const message = Buffer.from(signedMessage(name, version, integrity));
  for (const s of signatures) {
    const spki = s && typeof s.keyid === 'string' && Object.hasOwn(keys, s.keyid) ? keys[s.keyid] : null;
    if (!spki || typeof s.sig !== 'string') continue;
    try {
      const key = createPublicKey({ key: Buffer.from(spki, 'base64'), format: 'der', type: 'spki' });
      if (verify('sha256', message, { key, dsaEncoding: 'der' }, Buffer.from(s.sig, 'base64'))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** The registry's tarball address for a version, the only one a download is made from. Pure. */
export function tarballUrl(name, version, registry = REGISTRY) {
  return `${registry}/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`;
}

/**
 * Why a version document is not the one asked for, or null: its name and
 * version, an sha512 integrity, the registry's own tarball address, and a
 * signature from a kept key. Pure.
 */
export function metadataProblem(doc, name, version, { registry = REGISTRY, keys = NPM_REGISTRY_KEYS } = {}) {
  if (!doc || typeof doc !== 'object') return 'the registry answered with no version document';
  if (doc.name !== name || doc.version !== version) return 'the registry answered with another package or version';
  const dist = doc.dist;
  if (!dist || typeof dist !== 'object') return 'the version has no dist entry';
  if (typeof dist.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity)) return 'the version has no sha512 integrity';
  if (dist.tarball !== tarballUrl(name, version, registry)) return 'the tarball address is not the registry\'s own for this version';
  if (!signedByRegistry({ name, version, integrity: dist.integrity, signatures: dist.signatures }, keys)) return 'no signature from a registry key kept in this repository';
  return null;
}

class Refusal extends Error {}

/**
 * Fetch, verify and unpack the platform package of one Claude Code version
 * into `dest`. Resolves to the path of the binary. Throws a Refusal with a
 * fixed, one-line reason when anything cannot be established; nothing is
 * left in `dest` then.
 */
export async function fetchVerified({ version, dest, name = platformPackage(process.platform, process.arch, isMusl()), registry = REGISTRY, keys = NPM_REGISTRY_KEYS, fetchImpl = fetch }) {
  if (!isPlainVersion(version)) throw new Refusal('the version is not a bare x.y.z');
  if (!name) throw new Refusal('Claude Code ships no package for this platform');
  const metaRes = await fetchImpl(`${registry}/${name.replace('/', '%2f')}/${version}`, { redirect: 'error', headers: { accept: 'application/json' } }).catch(() => null);
  if (!metaRes || metaRes.status !== 200) throw new Refusal(`the registry has no ${name} at this version (HTTP ${metaRes ? metaRes.status : 'none'})`);
  let doc;
  try { doc = await metaRes.json(); } catch { throw new Refusal('the registry answered with something that is not JSON'); }
  const problem = metadataProblem(doc, name, version, { registry, keys });
  if (problem) throw new Refusal(problem);

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const tgz = join(dest, 'package.tgz');
  try {
    const res = await fetchImpl(doc.dist.tarball, { redirect: 'error' }).catch(() => null);
    if (!res || res.status !== 200 || !res.body) throw new Refusal(`the tarball could not be downloaded (HTTP ${res ? res.status : 'none'})`);
    const hash = createHash('sha512');
    const out = createWriteStream(tgz);
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > MAX_TARBALL_BYTES) { out.destroy(); throw new Refusal('the tarball is larger than a Claude Code build'); }
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    if (`sha512-${hash.digest('base64')}` !== doc.dist.integrity) throw new Refusal('the tarball is not the bytes the registry signed (sha512 differs)');
    // Only the binary is unpacked: one named member, so no other path in the archive is written.
    const member = `package/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`;
    try {
      execFileSync('tar', ['-xzf', 'package.tgz', member], { cwd: dest, stdio: 'ignore' });
    } catch {
      throw new Refusal('the tarball holds no claude binary where a platform package keeps it');
    }
    rmSync(tgz, { force: true });
    const bin = join(dest, ...member.split('/'));
    if (!existsSync(bin)) throw new Refusal('the tarball holds no claude binary where a platform package keeps it');
    chmodSync(bin, 0o755);
    return bin;
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err instanceof Refusal ? err : new Refusal('the fetch failed before the build was verified');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [version, dest] = process.argv.slice(2);
  if (!version || !dest || process.argv.length !== 4) {
    process.stderr.write('usage: cc-verified-fetch.mjs <X.Y.Z> <dest dir>\n');
    process.exit(2);
  }
  fetchVerified({ version, dest }).then(
    (bin) => { process.stdout.write(`${bin}\n`); },
    (err) => { process.stderr.write(`${err instanceof Refusal ? err.message : 'the fetch failed before the build was verified'}\n`); process.exit(1); },
  );
}
