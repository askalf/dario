#!/usr/bin/env node
/**
 * What codex-drift-watch.yml asks the ChatGPT backend and the npm registry,
 * and what it does with the answers.
 *
 * The backend answers /models per `client_version`: a model newer than the
 * version named is left out of the list, and dario then refuses a request for
 * it as a model no provider lists (dario#1842, and gpt-6-astra before it).
 * CODEX_CLIENT_VERSION is a constant, correct on the day it is written and
 * stale once the Codex CLI moves on. So the watch asks twice: as the version
 * dario names, and as the newest released `@openai/codex`. A model the second
 * list has and the first has not means the constant hides it, and `bump`
 * writes the change that fixes it.
 *
 * Subcommands (the working directory is the repository root):
 *
 *   list <client_version> <out.json>
 *       The account-visible model list as that client version, written as
 *       { models: [{ slug, visibility }] } sorted by slug: the shape of
 *       test/fixtures/codex-models.snapshot.json. Reads the account file
 *       named by $account_file. When the backend does not answer 200, exits 1
 *       with `models <status>` on stderr, which the workflow reads for a 429.
 *   newer-release <client_version>
 *       Prints the latest released @openai/codex version when it is newer
 *       than <client_version>, and nothing when it is not.
 *   hidden <ours.json> <latest.json>
 *       Prints, one per line, the slugs <latest.json> lists that <ours.json>
 *       does not.
 *   bump <to> <ours.json> <latest.json>
 *       Makes the checkout name <to>: the default in src/codex-backend.ts and
 *       in docs/configuration.md, a CHANGELOG entry, and <latest.json> as the
 *       model snapshot. Prints the pull request body. Needs dist/ (it asks
 *       the build which of the new models have a price).
 *
 * An account's tokens are read and sent to the backend, and never printed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { appendUnreleased } from './_drift-patch-helpers.mjs';

export const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
export const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@openai/codex/dist-tags';
export const SNAPSHOT_PATH = 'test/fixtures/codex-models.snapshot.json';
const SOURCE_PATH = 'src/codex-backend.ts';
const DOCS_PATH = 'docs/configuration.md';
const CHANGELOG_PATH = 'CHANGELOG.md';

const RELEASE = /^\d+\.\d+\.\d+$/;

/** The headers the Codex CLI sends on its model-list call, for one account file's contents. */
export function modelListHeaders(account) {
  const headers = {
    Authorization: 'Bearer ' + account.accessToken,
    Accept: 'application/json',
    originator: 'codex_cli_rs',
    'OpenAI-Beta': 'responses=experimental',
  };
  try {
    const claims = JSON.parse(Buffer.from(String(account.idToken || '').split('.')[1] || '', 'base64url').toString());
    const id = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    if (id) headers['ChatGPT-Account-ID'] = id;
  } catch { /* an id token that does not decode names no account */ }
  return headers;
}

/** A /models answer as the snapshot holds it: { slug, visibility } per model, sorted by slug. */
export function modelsFromResponse(body) {
  return (body?.models || body?.data || [])
    .map((m) => ({ slug: m.slug || m.id, visibility: m.visibility || null }))
    .filter((m) => m.slug)
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The snapshot file's text for a model list. */
export function snapshotText(models) {
  return JSON.stringify({ models }, null, 2) + '\n';
}

/** The model list an account sees as `clientVersion`. Throws `models <status>` when the answer is not 200. */
export async function fetchModelList(account, clientVersion, fetchImpl = fetch) {
  const res = await fetchImpl(`${MODELS_URL}?client_version=${encodeURIComponent(clientVersion)}`, { headers: modelListHeaders(account) });
  if (!res.ok) throw new Error('models ' + res.status);
  return modelsFromResponse(await res.json());
}

/** -1, 0 or 1 for two x.y.z versions; null when either is not one. */
export function compareReleases(a, b) {
  if (!RELEASE.test(String(a)) || !RELEASE.test(String(b))) return null;
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The `latest` dist-tag when it is a plain release newer than `current`, else
 * null. A `current` that is not x.y.z (an override naming something else)
 * cannot be compared, and gives null.
 */
export function newerRelease(distTags, current) {
  const latest = distTags?.latest;
  return compareReleases(current, latest) === -1 ? latest : null;
}

/** The slugs a list shows in a picker: visibility `list`, which is what dario routes. */
const listed = (models) => (Array.isArray(models) ? models : []).filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string').map((m) => m.slug);

/** Slugs `latest` lists that `ours` does not, sorted. */
export function hiddenModels(ours, latest) {
  const have = new Set(listed(ours));
  return listed(latest).filter((slug) => !have.has(slug)).sort();
}

/** The default client version src/codex-backend.ts names. Throws unless the file names exactly one. */
export function sourceDefault(source) {
  const found = [...source.matchAll(/process\.env\.DARIO_CODEX_CLIENT_VERSION \|\| '(\d+\.\d+\.\d+)'/g)];
  if (found.length !== 1) throw new Error(`${SOURCE_PATH}: expected one default for DARIO_CODEX_CLIENT_VERSION, found ${found.length}`);
  return found[0][1];
}

/** src/codex-backend.ts with `to` as the default client version. */
export function bumpSource(source, to) {
  const from = sourceDefault(source);
  return source.replace(`process.env.DARIO_CODEX_CLIENT_VERSION || '${from}'`, `process.env.DARIO_CODEX_CLIENT_VERSION || '${to}'`);
}

/** docs/configuration.md with `to` as the default in the DARIO_CODEX_CLIENT_VERSION row. Throws unless one row names `from`. */
export function bumpDocs(docs, from, to) {
  const lines = docs.split('\n');
  const rows = lines.map((line, i) => (line.startsWith('| `DARIO_CODEX_CLIENT_VERSION` |') ? i : -1)).filter((i) => i !== -1);
  if (rows.length !== 1) throw new Error(`${DOCS_PATH}: expected one DARIO_CODEX_CLIENT_VERSION row, found ${rows.length}`);
  const row = lines[rows[0]];
  if (row.split(`\`${from}\``).length !== 2) throw new Error(`${DOCS_PATH}: the DARIO_CODEX_CLIENT_VERSION row does not name \`${from}\` exactly once`);
  lines[rows[0]] = row.replace(`\`${from}\``, `\`${to}\``);
  return lines.join('\n');
}

const sentenceList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const code = (slugs) => sentenceList(slugs.map((s) => `\`${s}\``));

/** The release note of a client-version bump. */
export function changelogBullet(from, to, hidden) {
  const one = hidden.length === 1;
  return `- **dario asks the ChatGPT backend for its model list as Codex CLI ${to}.** It asked as ${from}. The backend answers per client version, and ${code(hidden)} ${one ? 'is' : 'are'} listed only from a newer one, so a request for ${one ? 'it' : 'any of them'} was refused as a model no provider lists.`;
}

/** The body of the pull request `bump` prepares. */
export function bumpPrBody({ from, to, hidden, gone, unpriced, runUrl }) {
  const where = runUrl ? ` ([run](${runUrl}))` : '';
  const lines = [
    '## Codex client version',
    '',
    `dario asks the ChatGPT backend for its model list as Codex CLI \`${from}\`. Asked as \`${to}\`, the newest release of \`@openai/codex\`, the same account also lists${where}:`,
    '',
    ...hidden.map((slug) => `- \`${slug}\``),
    '',
    `The backend answers per client version, so dario does not see ${hidden.length === 1 ? 'this model' : 'these models'} and refuses a request for ${hidden.length === 1 ? 'it' : 'one'} as a model no provider lists.`,
    '',
    '### What changes',
    '',
    `- \`${SOURCE_PATH}\`: the default \`CODEX_CLIENT_VERSION\` is \`${to}\`.`,
    `- \`${DOCS_PATH}\`: the default in the \`DARIO_CODEX_CLIENT_VERSION\` row.`,
    `- \`${SNAPSHOT_PATH}\`: the list as \`${to}\`, which is what the daily watch compares against once this is on master.`,
    `- \`${CHANGELOG_PATH}\`: the release note.`,
  ];
  if (gone.length > 0) {
    lines.push('', `Asked as \`${to}\` the list no longer has ${code(gone)}. With this change dario stops routing ${gone.length === 1 ? 'it' : 'them'} to a ChatGPT plan.`);
  }
  if (unpriced.length > 0) {
    lines.push('', '### Needs a price', '',
      `${code(unpriced)} ${unpriced.length === 1 ? 'has' : 'have'} no row in \`OPENAI_PRICING\` (\`src/analytics.ts\`). \`test/codex-models-priced.mjs\` fails this PR until ${unpriced.length === 1 ? 'the row is' : 'the rows are'} added from OpenAI's pricing page: without one, requests for ${unpriced.length === 1 ? 'it' : 'them'} are costed at another model's rate.`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Make the checkout at `root` name `to`. Returns what the pull request says.
 * `hasPublishedRate` is analytics' own, passed in so this stays testable
 * without a build.
 */
export function applyBump({ root, to, ours, latest, hasPublishedRate, runUrl }) {
  if (!RELEASE.test(String(to))) throw new Error(`not a release version: ${to}`);
  const hidden = hiddenModels(ours, latest);
  if (hidden.length === 0) throw new Error(`nothing is listed as ${to} that is not listed already: no reason to bump`);
  const sourcePath = join(root, SOURCE_PATH);
  const source = readFileSync(sourcePath, 'utf8');
  const from = sourceDefault(source);
  if (compareReleases(from, to) !== -1) throw new Error(`${to} is not newer than the default ${from}`);
  const docsPath = join(root, DOCS_PATH);
  const docs = bumpDocs(readFileSync(docsPath, 'utf8'), from, to);
  const changelogPath = join(root, CHANGELOG_PATH);
  const changelog = readFileSync(changelogPath, 'utf8');
  const withNote = appendUnreleased(changelog, changelogBullet(from, to, hidden));
  if (withNote === changelog) throw new Error(`${CHANGELOG_PATH}: no "## [Unreleased]" heading to file the note under`);
  // Every file is ready before the first is written.
  writeFileSync(sourcePath, bumpSource(source, to));
  writeFileSync(docsPath, docs);
  writeFileSync(changelogPath, withNote);
  writeFileSync(join(root, SNAPSHOT_PATH), snapshotText(latest));
  return bumpPrBody({
    from, to, hidden,
    gone: hiddenModels(latest, ours),
    unpriced: hidden.filter((slug) => !hasPublishedRate(slug)),
    runUrl,
  });
}

const readModels = (path) => JSON.parse(readFileSync(path, 'utf8')).models;

async function main(argv) {
  const [command, ...args] = argv;
  if (command === 'list' && args.length === 2) {
    const account = JSON.parse(readFileSync(process.env.account_file, 'utf8'));
    writeFileSync(args[1], snapshotText(await fetchModelList(account, args[0])));
    return;
  }
  if (command === 'newer-release' && args.length === 1) {
    const res = await fetch(DIST_TAGS_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('dist-tags ' + res.status);
    const newer = newerRelease(await res.json(), args[0]);
    if (newer) console.log(newer);
    return;
  }
  if (command === 'hidden' && args.length === 2) {
    for (const slug of hiddenModels(readModels(args[0]), readModels(args[1]))) console.log(slug);
    return;
  }
  if (command === 'bump' && args.length === 3) {
    const { hasPublishedRate } = await import(pathToFileURL(resolve('dist/analytics.js')).href);
    process.stdout.write(applyBump({
      root: process.cwd(), to: args[0], ours: readModels(args[1]), latest: readModels(args[2]),
      hasPublishedRate, runUrl: process.env.RUN_URL || '',
    }));
    return;
  }
  throw new Error('usage: codex-models-probe.mjs list <client_version> <out.json> | newer-release <client_version> | hidden <ours.json> <latest.json> | bump <to> <ours.json> <latest.json>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
