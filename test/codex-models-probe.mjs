#!/usr/bin/env node
// scripts/codex-models-probe.mjs: what codex-drift-watch.yml asks the ChatGPT
// backend and the npm registry, and the client-version bump it prepares when
// a newer Codex CLI is told about a model dario's version is not.
//
// No network and no account: fetch is a stand-in, and `bump` runs against a
// staged copy of the four files it writes.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MODELS_URL, SNAPSHOT_PATH, applyBump, bumpDocs, bumpPrBody, bumpSource, changelogBullet, compareReleases,
  fetchModelList, hiddenModels, modelListHeaders, modelsFromResponse, newerRelease, snapshotText, sourceDefault,
} from '../scripts/codex-models-probe.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 500) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const rejects = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const DASH = String.fromCharCode(0x2014);

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const ACCOUNT = { accessToken: 'access-token-value', idToken: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' } }) };

header('the request');
{
  const h = modelListHeaders(ACCOUNT);
  check('bearer token, originator and beta header', h.Authorization === 'Bearer access-token-value' && h.originator === 'codex_cli_rs' && h['OpenAI-Beta'] === 'responses=experimental' && h.Accept === 'application/json');
  check('the account id from the id token', h['ChatGPT-Account-ID'] === 'acct-123');
  check('an id token that does not decode names no account', !('ChatGPT-Account-ID' in modelListHeaders({ accessToken: 't', idToken: 'not-a-jwt' })) && !('ChatGPT-Account-ID' in modelListHeaders({ accessToken: 't' })));

  const calls = [];
  const ok = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ models: [{ slug: 'gpt-b', visibility: 'list' }, { slug: 'gpt-a', visibility: 'hide' }, { id: 'gpt-c' }, { visibility: 'list' }] }) }; };
  const models = await fetchModelList(ACCOUNT, '0.167.0', ok);
  check('asks the backend as the version given', calls.length === 1 && calls[0].url === `${MODELS_URL}?client_version=0.167.0` && calls[0].init.headers.Authorization === 'Bearer access-token-value', calls[0]?.url);
  check('the version is encoded into the query', await (async () => { const seen = []; await fetchModelList(ACCOUNT, '0.1 &x', async (url) => { seen.push(url); return { ok: true, status: 200, json: async () => ({}) }; }); return seen[0].endsWith('client_version=0.1%20%26x'); })());
  check('slug and visibility, sorted by slug, an id standing in for a slug, a nameless entry dropped', JSON.stringify(models) === JSON.stringify([{ slug: 'gpt-a', visibility: 'hide' }, { slug: 'gpt-b', visibility: 'list' }, { slug: 'gpt-c', visibility: null }]), JSON.stringify(models));
  check('a `data` array is read like `models`', JSON.stringify(modelsFromResponse({ data: [{ slug: 'x', visibility: 'list' }] })) === '[{"slug":"x","visibility":"list"}]');
  check('an answer with neither is an empty list', modelsFromResponse({}).length === 0 && modelsFromResponse(null).length === 0);
  check('a refusal names its status and nothing of the account', await rejects(() => fetchModelList(ACCOUNT, '0.167.0', async () => ({ ok: false, status: 429, json: async () => ({}) })), /^models 429$/));
  check('the snapshot text is what the committed snapshot is written as', snapshotText(JSON.parse(readFileSync(join(REPO, SNAPSHOT_PATH), 'utf8')).models) === readFileSync(join(REPO, SNAPSHOT_PATH), 'utf8').replace(/\r\n/g, '\n'));
}

header('which release is newer');
{
  check('ordered by number, not by text', compareReleases('0.99.0', '0.167.0') === -1 && compareReleases('0.167.0', '0.99.0') === 1 && compareReleases('0.167.0', '0.167.0') === 0 && compareReleases('1.0.0', '0.999.999') === 1 && compareReleases('0.167.1', '0.167.10') === -1);
  check('anything but x.y.z cannot be compared', compareReleases('0.169.0-alpha.7', '0.167.0') === null && compareReleases('0.167', '0.167.0') === null && compareReleases(undefined, '0.167.0') === null);
  check('a newer latest is named', newerRelease({ latest: '0.170.0', alpha: '0.171.0-alpha.1' }, '0.167.0') === '0.170.0');
  check('the same or an older latest is not', newerRelease({ latest: '0.167.0' }, '0.167.0') === null && newerRelease({ latest: '0.160.0' }, '0.167.0') === null);
  check('a prerelease under latest is not a release', newerRelease({ latest: '0.170.0-alpha.2' }, '0.167.0') === null);
  check('an alpha tag is never read', newerRelease({ alpha: '0.171.0-alpha.1' }, '0.167.0') === null);
  check('a version dario was told to name that is not x.y.z gives no verdict', newerRelease({ latest: '0.170.0' }, 'nightly') === null);
  check('no tags, no verdict', newerRelease(null, '0.167.0') === null && newerRelease({}, '0.167.0') === null);
}

const OURS = [
  { slug: 'codex-auto-review', visibility: 'hide' },
  { slug: 'gpt-6-luna', visibility: 'list' },
  { slug: 'gpt-6-sol', visibility: 'list' },
];
const LATEST = [
  { slug: 'codex-auto-review', visibility: 'hide' },
  { slug: 'gpt-6-sol', visibility: 'list' },
  { slug: 'gpt-7-nova', visibility: 'list' },
  { slug: 'gpt-7-terra', visibility: 'list' },
  { slug: 'gpt-reserve', visibility: 'hide' },
];

header('what dario\'s version hides');
{
  check('the slugs the newer list has and ours has not', JSON.stringify(hiddenModels(OURS, LATEST)) === '["gpt-7-nova","gpt-7-terra"]');
  check('a model that is not for a picker is not one dario routes', !hiddenModels(OURS, LATEST).includes('gpt-reserve'));
  check('a model that became listed counts', JSON.stringify(hiddenModels(OURS, [{ slug: 'codex-auto-review', visibility: 'list' }])) === '["codex-auto-review"]');
  check('the same list hides nothing', hiddenModels(OURS, OURS).length === 0);
  check('the other way round: what the newer version no longer lists', JSON.stringify(hiddenModels(LATEST, OURS)) === '["gpt-6-luna"]');
  check('junk is an empty list, never a throw', hiddenModels(undefined, null).length === 0 && hiddenModels([null, 7, { visibility: 'list' }], [{ slug: 3, visibility: 'list' }]).length === 0);
}

header('the edits');
{
  const source = readFileSync(join(REPO, 'src', 'codex-backend.ts'), 'utf8');
  const from = sourceDefault(source);
  check('the source names one default, a plain release', /^\d+\.\d+\.\d+$/.test(from), from);
  const bumped = bumpSource(source, '9.9.9');
  check('the bump moves that default and nothing else', sourceDefault(bumped) === '9.9.9' && bumped.length - source.length === '9.9.9'.length - from.length && bumped.replace("|| '9.9.9'", `|| '${from}'`) === source);
  check('a source with no default, or two, is refused', throws(() => sourceDefault('export const X = 1;'), /found 0/) && throws(() => sourceDefault(`${source}\n${source}`), /found 2/));

  const docs = readFileSync(join(REPO, 'docs', 'configuration.md'), 'utf8');
  const bumpedDocs = bumpDocs(docs, from, '9.9.9');
  const row = (text) => text.split('\n').find((l) => l.startsWith('| `DARIO_CODEX_CLIENT_VERSION` |'));
  check('the configuration reference names the same default as the source', row(docs).includes(`| \`${from}\` |`), row(docs)?.slice(0, 80));
  check('the bump moves the default in that row and no other line', row(bumpedDocs).includes('| `9.9.9` |') && bumpedDocs.split('\n').filter((l, i) => l !== docs.split('\n')[i]).length === 1);
  check('a row that does not name the old default is refused', throws(() => bumpDocs(docs, '0.0.1', '9.9.9'), /does not name `0\.0\.1` exactly once/));
  check('a file without the row is refused', throws(() => bumpDocs('# Configuration\n', from, '9.9.9'), /found 0/));

  const one = changelogBullet('0.167.0', '0.170.0', ['gpt-7-nova']);
  const two = changelogBullet('0.167.0', '0.170.0', ['gpt-7-nova', 'gpt-7-terra']);
  check('the note for one model', one === '- **dario asks the ChatGPT backend for its model list as Codex CLI 0.170.0.** It asked as 0.167.0. The backend answers per client version, and `gpt-7-nova` is listed only from a newer one, so a request for it was refused as a model no provider lists.', one);
  check('the note for several', two.includes('`gpt-7-nova` and `gpt-7-terra` are listed only from a newer one, so a request for any of them was refused'), two);
  check('no em dash in a note', !one.includes(DASH) && !two.includes(DASH));
}

header('bump: the checkout names the newer version');
{
  const stage = () => {
    const root = mkdtempSync(join(tmpdir(), 'dario-codex-bump-'));
    for (const f of ['src/codex-backend.ts', 'docs/configuration.md', 'CHANGELOG.md', SNAPSHOT_PATH]) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      copyFileSync(join(REPO, f), join(root, f));
    }
    return root;
  };
  const read = (root, f) => readFileSync(join(root, f), 'utf8');
  const priced = (slug) => slug !== 'gpt-7-terra';
  const from = sourceDefault(read(REPO, 'src/codex-backend.ts'));

  const root = stage();
  const body = applyBump({ root, to: '9.9.9', ours: OURS, latest: LATEST, hasPublishedRate: priced, runUrl: 'https://example.com/run/1' });
  check('the source default moved', sourceDefault(read(root, 'src/codex-backend.ts')) === '9.9.9');
  check('the configuration reference moved with it', read(root, 'docs/configuration.md').includes('| `9.9.9` |'));
  check('the snapshot is the newer list', read(root, SNAPSHOT_PATH) === snapshotText(LATEST));
  const changelog = read(root, 'CHANGELOG.md');
  // The heading on a line of its own: the file's opening comment names it too.
  const at = /^## \[Unreleased\]\s*$/m.exec(changelog).index;
  const unreleased = changelog.slice(at, changelog.indexOf('\n## [', at + 5));
  check('the note is filed under Unreleased', unreleased.includes(changelogBullet(from, '9.9.9', ['gpt-7-nova', 'gpt-7-terra'])), unreleased.slice(0, 300));
  check('the rest of the changelog is as it was', changelog.replace(`\n${changelogBullet(from, '9.9.9', ['gpt-7-nova', 'gpt-7-terra'])}\n`, '') === read(REPO, 'CHANGELOG.md'));
  check('the body names both versions and each model the newer one lists', body.includes(`as Codex CLI \`${from}\``) && body.includes('Asked as `9.9.9`') && body.includes('- `gpt-7-nova`') && body.includes('- `gpt-7-terra`'), body);
  check('it links the run', body.includes('([run](https://example.com/run/1))'));
  check('it names a model the newer version no longer lists', body.includes('the list no longer has `gpt-6-luna`'), body);
  check('it names the model with no price, and the test that holds the PR', body.includes('### Needs a price') && body.includes('`gpt-7-terra` has no row in `OPENAI_PRICING`') && body.includes('test/codex-models-priced.mjs') && !body.includes('`gpt-7-nova` has no row'), body);
  check('no em dash in the body', !body.includes(DASH));

  const calm = bumpPrBody({ from: '0.167.0', to: '0.170.0', hidden: ['gpt-7-nova'], gone: [], unpriced: [], runUrl: '' });
  check('a bump with nothing lost and nothing unpriced says neither', !calm.includes('no longer has') && !calm.includes('Needs a price') && !calm.includes('[run]'), calm);

  // `setup` puts the staged checkout in the state under test, before the files are read for comparison.
  const untouched = (fn, re, setup = () => {}) => {
    const r = stage();
    setup(r);
    const before = ['src/codex-backend.ts', 'docs/configuration.md', 'CHANGELOG.md', SNAPSHOT_PATH].map((f) => read(r, f));
    const threw = throws(() => fn(r), re);
    return threw && ['src/codex-backend.ts', 'docs/configuration.md', 'CHANGELOG.md', SNAPSHOT_PATH].every((f, i) => read(r, f) === before[i]);
  };
  check('nothing hidden: refused, nothing written', untouched((r) => applyBump({ root: r, to: '9.9.9', ours: OURS, latest: OURS, hasPublishedRate: priced }), /no reason to bump/));
  check('a version that is not newer: refused, nothing written', untouched((r) => applyBump({ root: r, to: '0.0.1', ours: OURS, latest: LATEST, hasPublishedRate: priced }), /not newer than the default/));
  check('a prerelease: refused, nothing written', untouched((r) => applyBump({ root: r, to: '9.9.9-alpha.1', ours: OURS, latest: LATEST, hasPublishedRate: priced }), /not a release version/));
  const bump = (r) => applyBump({ root: r, to: '9.9.9', ours: OURS, latest: LATEST, hasPublishedRate: priced });
  check('a changelog with no Unreleased heading: refused, nothing written', untouched(bump, /no "## \[Unreleased\]" heading/,
    (r) => writeFileSync(join(r, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-01-01\n')));
  check('a configuration reference out of step with the source: refused, nothing written', untouched(bump, /does not name/,
    (r) => writeFileSync(join(r, 'docs/configuration.md'), read(r, 'docs/configuration.md').replace(`\`${from}\``, '`0.0.2`'))));
}

header('the command line');
{
  const run = (args, cwd) => spawnSync(process.execPath, [join(REPO, 'scripts', 'codex-models-probe.mjs'), ...args], { cwd, encoding: 'utf8' });
  const dir = mkdtempSync(join(tmpdir(), 'dario-codex-probe-'));
  writeFileSync(join(dir, 'ours.json'), snapshotText(OURS));
  writeFileSync(join(dir, 'latest.json'), snapshotText(LATEST));
  const hidden = run(['hidden', 'ours.json', 'latest.json'], dir);
  check('hidden prints one slug per line', hidden.status === 0 && hidden.stdout === 'gpt-7-nova\ngpt-7-terra\n', hidden.stdout + hidden.stderr);
  const none = run(['hidden', 'ours.json', 'ours.json'], dir);
  check('and nothing when nothing is hidden', none.status === 0 && none.stdout === '');
  const usage = run(['frobnicate'], dir);
  check('an unknown command exits 1 with the usage', usage.status === 1 && usage.stderr.includes('usage: codex-models-probe.mjs') && !existsSync(join(dir, 'frobnicate')));
  const short = run(['list', '0.167.0'], dir);
  check('a command short of an argument exits 1', short.status === 1 && short.stderr.includes('usage:'));
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
