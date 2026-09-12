#!/usr/bin/env node
/**
 * Sponsors — the two places the GitHub Sponsors tiers promise a name.
 *
 * The tiers on github.com/sponsors/askalf say: every sponsor gets a
 * thank-you in the release notes, and the $25+ tiers get their name in the
 * README. A promise kept by memory is a promise broken within a month, so
 * both come from one query here:
 *
 *   node scripts/sponsors.mjs --thanks            release-notes block (stdout)
 *   node scripts/sponsors.mjs --readme            README block (stdout)
 *   node scripts/sponsors.mjs --readme --write    rewrite the README block in place
 *
 * Reads the maintainer's ACTIVE, PUBLIC sponsorships through the GraphQL
 * API (`GH_TOKEN` / `GITHUB_TOKEN`, or `gh auth token`). Private sponsors
 * are never named — the query does not even ask for them. The release path
 * is best-effort: any failure prints nothing and exits 0, because a release
 * must never fail on a thank-you. `--write` exits 1 on a failure, since a
 * bot commit built on a broken read would silently empty the list.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const MAINTAINER = 'askalf';
export const README_START = '<!-- sponsors:start -->';
export const README_END = '<!-- sponsors:end -->';
/** Tiers at or above this monthly amount are the ones that promised a README line. */
export const README_TIER_MIN_USD = 25;

const QUERY = `query($login: String!) {
  user(login: $login) {
    sponsorshipsAsMaintainer(first: 100, activeOnly: true, includePrivate: false) {
      nodes {
        isOneTimePayment
        tier { monthlyPriceInDollars isOneTime }
        sponsorEntity {
          __typename
          ... on User { login name }
          ... on Organization { login name }
        }
      }
    }
  }
}`;

/**
 * Normalise the API's sponsorship nodes into what the renderers need.
 * A node without a login (a deleted account, an unexpected entity type) is
 * dropped rather than rendered as "undefined".
 */
export function normalizeSponsors(nodes) {
  const out = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const e = n && n.sponsorEntity;
    if (!e || typeof e.login !== 'string' || e.login.length === 0) continue;
    const monthly = n.tier && typeof n.tier.monthlyPriceInDollars === 'number' ? n.tier.monthlyPriceInDollars : 0;
    const oneTime = Boolean(n.isOneTimePayment || (n.tier && n.tier.isOneTime));
    out.push({ login: e.login, name: typeof e.name === 'string' && e.name.trim() ? e.name.trim() : null, monthly, oneTime });
  }
  // Highest tier first, then by login, so the order is stable between runs.
  return out.sort((a, b) => (b.monthly - a.monthly) || a.login.localeCompare(b.login));
}

const mention = (s) => `[@${s.login}](https://github.com/${s.login})`;

/**
 * The release-notes block. Empty string when there is nobody to thank, so
 * the workflow can append it unconditionally.
 */
export function renderThanks(sponsors) {
  if (sponsors.length === 0) return '';
  const names = sponsors.map(mention);
  const list = names.length === 1 ? names[0]
    : names.length === 2 ? `${names[0]} and ${names[1]}`
    : `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  return `**Thanks to the sponsors behind this release:** ${list}. [Sponsor dario](https://github.com/sponsors/${MAINTAINER}).\n`;
}

/**
 * The README block: the sponsors whose tier promised a line, or a single
 * sentence pointing at the listing when there are none yet. Always wrapped
 * in the markers so `--write` can find it again.
 */
export function renderReadmeBlock(sponsors) {
  const named = sponsors.filter((s) => !s.oneTime && s.monthly >= README_TIER_MIN_USD);
  const lines = [README_START];
  if (named.length === 0) {
    lines.push(`dario is funded by its users through [GitHub Sponsors](https://github.com/sponsors/${MAINTAINER}) — the live-test seats it is checked against before every release are the biggest line item. Sponsors at $${README_TIER_MIN_USD}/month and up are listed here.`);
  } else {
    lines.push(`dario is funded by its users through [GitHub Sponsors](https://github.com/sponsors/${MAINTAINER}). Thank you:`);
    lines.push('');
    for (const s of named) lines.push(`- ${mention(s)}${s.name ? ` — ${s.name}` : ''}`);
  }
  lines.push(README_END);
  return lines.join('\n');
}

/** Replace the marked block in README text; throws when the markers are missing. */
export function replaceReadmeBlock(readme, block) {
  const a = readme.indexOf(README_START);
  const b = readme.indexOf(README_END);
  if (a === -1 || b === -1 || b < a) throw new Error(`README is missing the ${README_START} … ${README_END} markers`);
  return readme.slice(0, a) + block + readme.slice(b + README_END.length);
}

function token() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { return null; }
}

export async function fetchSponsors(login = MAINTAINER, fetchImpl = fetch) {
  const t = token();
  if (!t) throw new Error('no GitHub token (GH_TOKEN / GITHUB_TOKEN / gh auth)');
  const res = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${t}`, 'content-type': 'application/json', 'user-agent': 'dario-sponsors' },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  const nodes = json && json.data && json.data.user && json.data.user.sponsorshipsAsMaintainer && json.data.user.sponsorshipsAsMaintainer.nodes;
  if (!Array.isArray(nodes)) throw new Error(`unexpected GraphQL shape: ${JSON.stringify(json).slice(0, 200)}`);
  return normalizeSponsors(nodes);
}

async function main() {
  const args = process.argv.slice(2);
  const thanks = args.includes('--thanks');
  const readme = args.includes('--readme');
  const write = args.includes('--write');
  if (!thanks && !readme) {
    console.error('usage: sponsors.mjs --thanks | --readme [--write]');
    process.exit(2);
  }
  let sponsors;
  try {
    sponsors = await fetchSponsors();
  } catch (err) {
    console.error(`sponsors: ${err.message}`);
    // A release must never fail on a thank-you; a README rewrite must
    // never be built on a failed read.
    process.exit(write ? 1 : 0);
  }
  if (thanks) process.stdout.write(renderThanks(sponsors));
  if (readme) {
    const block = renderReadmeBlock(sponsors);
    if (!write) { process.stdout.write(block + '\n'); return; }
    const path = resolve(fileURLToPath(new URL('../README.md', import.meta.url)));
    const before = readFileSync(path, 'utf8');
    const after = replaceReadmeBlock(before, block);
    if (after !== before) { writeFileSync(path, after); console.error('sponsors: README block updated'); }
    else console.error('sponsors: README block unchanged');
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try { return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMainModule()) await main();
