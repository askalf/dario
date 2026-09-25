#!/usr/bin/env node
// Where a PR stands in the fleet's review lanes, as three commit statuses on its head.
//
// WHY THIS EXISTS. The review lanes (the Breaker's verification, Redline's gating review, the
// Second Read) run as tickets on the fleet box, so a PR waiting on one shows nothing on GitHub.
// On 2026-09-24 dario#1403 sat all morning with green CI and a red "Changes requested" while its
// verification waited on a budget-paused seat, and nothing on the PR said so. These statuses put
// each lane next to build and test: pending while it waits, green when it has spoken at the head,
// red when it said no.
//
// Read-only as far as the PR goes: this looks at labels, comments and reviews and writes statuses.
// The rules are the dispatcher's (platform tools/review-dispatch.sh, runtime/review-lanes.ts):
//   - A code PR (anything beyond docs, assets and .github config, from a person, on a non-bot
//     branch) is verified first: the `verified` label AND a "## Verification at <sha>" comment by
//     askalf naming the live head.
//   - Redline's verdict counts only at the head. On code, its deterministic low-risk approval is
//     not a verdict.
//   - On code, the Second Read gates too: the newest of its reviews at the head that carries a
//     `SECOND READ: READY` or `SECOND READ: NOT READY - <reason>` line is its verdict.
//
// CLI (the workflow's only step):
//   GITHUB_TOKEN=... REPO=askalf/dario PR=1403 node scripts/fleet-status.mjs [--dry-run]

import { pathToFileURL } from 'node:url';

export const REDLINE_LOGIN = 'sprayberry-redline';
export const SECOND_READ_LOGIN = 'sprayberry-secondread';
export const VERIFIER_LOGIN = 'askalf';
export const DETERMINISTIC_APPROVAL_MARKER = '**Deterministic approval';
export const CONTEXTS = { verify: 'fleet/verify', review: 'fleet/review', secondRead: 'fleet/second-read' };

const BOT_BRANCH = /^(bot\/|release\/|release-v?[0-9]|chore\/release-v?[0-9]|dependabot\/|receipts-)/;
const SCRIPT_EXT = /\.(js|mjs|cjs|ts|mts|cts|py|sh|bash|go|rb|ps1)$/i;

/** A changed path that is not docs, an asset, .github config or .gitattributes. */
export function isCodePath(path) {
  if (/\.(md|svg|png|jpe?g|webp|gif)$/i.test(path)) return false;
  if (/^docs\/.*\.txt$/i.test(path)) return false;
  if (path === '.gitattributes') return false;
  if (path.startsWith('.github/') && !/^\.github\/(actions|scripts)\//.test(path) && !SCRIPT_EXT.test(path)) return false;
  return true;
}

/** Dependabot, or a bot-shaped branch opened by askalf or github-actions: verification-exempt. */
export function isBotPr(author, headRef) {
  if (/^(app\/)?dependabot(\[bot\])?$/i.test(author ?? '')) return true;
  return /^(askalf|(app\/)?github-actions(\[bot\])?)$/i.test(author ?? '') && BOT_BRANCH.test(headRef ?? '');
}

export function needsVerify(facts) {
  if (isBotPr(facts.author, facts.headRef)) return false;
  return facts.files.length >= 100 || facts.files.some(isCodePath);
}

/** The label AND the verifier's latest "## Verification at <sha>" comment naming this head. */
export function verifiedAtHead(facts) {
  if (!facts.labels.includes('verified') || !facts.head) return false;
  let at = null;
  for (const c of facts.comments) {
    if (c.login !== VERIFIER_LOGIN) continue;
    const m = /^## Verification at ([0-9a-f]{7,40})/.exec(c.body ?? '');
    if (m) at = m[1];
  }
  return at !== null && facts.head.startsWith(at);
}

/** Redline's latest verdict review, or null. On code, its deterministic approval does not count. */
export function redlineVerdict(facts, code) {
  let v = null;
  for (const r of facts.reviews) {
    if (r.login !== REDLINE_LOGIN) continue;
    if (r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED') continue;
    if (code && (r.body ?? '').startsWith(DETERMINISTIC_APPROVAL_MARKER)) continue;
    v = r;
  }
  return v;
}

/** The Second Read's verdict at this head: { state: READY | NOT READY | none, reason }. */
export function secondReadAtHead(facts) {
  let out = { state: 'none', reason: '' };
  for (const r of facts.reviews) {
    if (r.login !== SECOND_READ_LOGIN || r.commitId !== facts.head) continue;
    let last = null;
    for (const m of (r.body ?? '').matchAll(/^SECOND READ: (READY[ \t\r]*$|NOT READY\b.*)$/gm)) last = m[1];
    if (last === null) continue;
    out = last.startsWith('NOT READY')
      ? { state: 'NOT READY', reason: last.replace(/^NOT READY\W*/, '').trim() }
      : { state: 'READY', reason: '' };
  }
  return out;
}

const short = (sha) => (sha ?? '').slice(0, 7);
const fit = (s) => (s.length <= 140 ? s : `${s.slice(0, 137)}...`);

/**
 * The three statuses for a PR, from what GitHub says about it.
 * @param {{head:string, headRef:string, author:string, files:string[], labels:string[],
 *          reviews:Array<{login:string,state:string,commitId:string,body:string}>,
 *          comments:Array<{login:string,body:string}>}} facts
 * @returns {Array<{context:string, state:'pending'|'success'|'failure', description:string}>}
 */
export function laneStatuses(facts) {
  const h = short(facts.head);
  const code = needsVerify(facts);
  const verified = code && verifiedAtHead(facts);
  const out = [];

  out.push(!code
    ? { context: CONTEXTS.verify, state: 'success', description: 'Not required: docs, assets, .github config or a bot branch' }
    : verified
      ? { context: CONTEXTS.verify, state: 'success', description: `Verified at ${h}` }
      : { context: CONTEXTS.verify, state: 'pending', description: `Waiting on the Breaker to verify ${h}` });

  const gated = code && !verified;
  const rv = redlineVerdict(facts, code);
  if (gated) {
    out.push({ context: CONTEXTS.review, state: 'pending', description: `Redline reads ${h} once it is verified` });
  } else if (rv && rv.commitId === facts.head) {
    out.push(rv.state === 'APPROVED'
      ? { context: CONTEXTS.review, state: 'success', description: `Redline approved ${h}` }
      : { context: CONTEXTS.review, state: 'failure', description: `Redline requested changes at ${h}` });
  } else {
    const was = rv ? ` (its last verdict was on ${short(rv.commitId)})` : '';
    out.push({ context: CONTEXTS.review, state: 'pending', description: `Waiting on Redline at ${h}${was}` });
  }

  if (!code) {
    out.push({ context: CONTEXTS.secondRead, state: 'success', description: 'Not gating: one non-gating opinion on this PR' });
  } else if (gated) {
    out.push({ context: CONTEXTS.secondRead, state: 'pending', description: `The Second Read reads ${h} once it is verified` });
  } else {
    const sr = secondReadAtHead(facts);
    out.push(sr.state === 'READY'
      ? { context: CONTEXTS.secondRead, state: 'success', description: `READY at ${h}` }
      : sr.state === 'NOT READY'
        ? { context: CONTEXTS.secondRead, state: 'failure', description: `NOT READY at ${h}${sr.reason ? `: ${sr.reason}` : ''}` }
        : { context: CONTEXTS.secondRead, state: 'pending', description: `Waiting on the Second Read at ${h}` });
  }

  return out.map((s) => ({ ...s, description: fit(s.description) }));
}

// ── CLI ────────────────────────────────────────────────────────────────────
async function gh(path, token, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

async function ghAll(path, token) {
  const out = [];
  for (let page = 1; ; page++) {
    const rows = await (await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token)).json();
    out.push(...rows);
    if (rows.length < 100) return out;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_TOKEN: token, REPO: repo, PR: pr, TARGET_URL: targetUrl } = process.env;
  const dryRun = process.argv.includes('--dry-run');
  if (!token || !repo || !/^\d+$/.test(pr ?? '')) {
    console.error('usage: GITHUB_TOKEN=... REPO=owner/name PR=<number> node scripts/fleet-status.mjs [--dry-run]');
    process.exit(2);
  }
  const p = await (await gh(`/repos/${repo}/pulls/${pr}`, token)).json();
  if (p.state !== 'open') { console.log(`#${pr} is ${p.state}; nothing to report`); process.exit(0); }
  if (p.head?.repo?.full_name !== repo) { console.log(`#${pr} is a fork PR; the fleet does not review it`); process.exit(0); }
  const [files, reviews, comments] = await Promise.all([
    ghAll(`/repos/${repo}/pulls/${pr}/files`, token),
    ghAll(`/repos/${repo}/pulls/${pr}/reviews`, token),
    ghAll(`/repos/${repo}/issues/${pr}/comments`, token),
  ]);
  const facts = {
    head: p.head.sha,
    headRef: p.head.ref,
    author: p.user?.login ?? '',
    files: files.map((f) => f.filename),
    labels: (p.labels ?? []).map((l) => l.name),
    reviews: reviews.map((r) => ({ login: r.user?.login ?? '', state: r.state, commitId: r.commit_id ?? '', body: r.body ?? '' })),
    comments: comments.map((c) => ({ login: c.user?.login ?? '', body: c.body ?? '' })),
  };
  for (const s of laneStatuses(facts)) {
    console.log(`${s.context.padEnd(18)} ${s.state.padEnd(8)} ${s.description}`);
    if (dryRun) continue;
    await gh(`/repos/${repo}/statuses/${facts.head}`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...s, target_url: targetUrl || p.html_url }),
    });
  }
}
