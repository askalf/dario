// src/version.ts — `/status` and `/health` must report the build that is
// RUNNING, not whatever package.json says on disk when someone first asks.
//
// The regression this locks: darioVersion() used to read package.json lazily
// on the first call and cache that. `npm i -g` rewrites package.json under the
// running install, so a proxy that had never served /status before an upgrade
// answered its first one with the NEW version while executing the OLD code.
// On #1244 that reported 6.0.34 from a process still emitting the 6.0.33
// /admin/accounts field set, and cost the reporter a round trip.
//
// Each case gets its own throwaway install root with its own copy of
// dist/version.js, so the module is imported fresh against a known
// package.json. No network, no writes outside the temp dir.

import { mkdtemp, rm, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILT = join(__dirname, '..', 'dist', 'version.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${detail ? ` :: ${detail}` : ''}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

/**
 * A throwaway install root: `<root>/package.json` is the one under test (what
 * `dist/version.js` reads as `../package.json`), and `<root>/dist/package.json`
 * only tells Node the copied file is ESM — so a missing or malformed root
 * package.json is a clean case rather than a module-resolution warning.
 */
async function installRoot(version) {
  const root = await mkdtemp(join(tmpdir(), 'dario-version-'));
  await mkdir(join(root, 'dist'), { recursive: true });
  await copyFile(BUILT, join(root, 'dist', 'version.js'));
  await writeFile(join(root, 'dist', 'package.json'), JSON.stringify({ type: 'module' }));
  await writePackage(root, version);
  return root;
}
const writePackage = (root, version) =>
  writeFile(join(root, 'package.json'), JSON.stringify({ name: '@askalf/dario', version }));
const load = (root) => import(pathToFileURL(join(root, 'dist', 'version.js')).href);

header('the version is bound to the process, not to the file on disk');
{
  // The proxy starts on 6.0.33 and imports the module.
  const root = await installRoot('6.0.33');
  const { darioVersion } = await load(root);

  // `npm i -g @askalf/dario@6.0.34` rewrites package.json under the same
  // install path. The proxy is never restarted.
  await writePackage(root, '6.0.34');

  // The first /status this process has ever served.
  const first = darioVersion();
  check('an upgrade under a running process does not move /status', first === '6.0.33',
    `got ${first} — the lazy read is back, and /status is reporting a build it is not running`);

  // And it stays put on every later call, disk notwithstanding.
  await writePackage(root, '6.0.99');
  check('later calls stay on the running build', darioVersion() === '6.0.33');
  await rm(root, { recursive: true, force: true });
}

header('it still reports the version it was actually installed at');
{
  const root = await installRoot('7.1.2');
  const { darioVersion } = await load(root);
  check('a fresh process reads its own package.json', darioVersion() === '7.1.2');
  await rm(root, { recursive: true, force: true });
}

header('a missing or malformed package.json reports "unknown", never throws');
{
  const gone = await installRoot('6.0.33');
  await rm(join(gone, 'package.json'));
  const missing = await load(gone);
  check('missing package.json → "unknown"', missing.darioVersion() === 'unknown');
  await rm(gone, { recursive: true, force: true });

  const bad = await installRoot('6.0.33');
  await writeFile(join(bad, 'package.json'), '{ not json');
  const broken = await load(bad);
  check('malformed package.json → "unknown"', broken.darioVersion() === 'unknown');
  await rm(bad, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
