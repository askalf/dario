#!/usr/bin/env node
// Computes fleet review-lane commit statuses from pull-request metadata: one status per lane on
// the PR head, pending while the lane waits, success once it has spoken at the head, failure when
// it said no. Reads labels, comments and reviews; writes statuses.
//
// The rules match the fleet dispatcher's:
//   - A code PR (anything beyond docs, assets and .github config, from a person, on a non-bot
//     branch) is verified first. Where the base branch requires status checks, it is verified
//     when every required check has passed at the head. Elsewhere it needs the `verified` label
//     AND a "## Verification at <sha>" comment by askalf naming the live head.
//   - Redline's verdict counts only at the head. On code, its deterministic low-risk approval is
//     not a verdict.
//   - On code, the Second Read gates too: the newest of its reviews at the head that carries a
//     `SECOND READ: READY` or `SECOND READ: NOT READY - <reason>` line is its verdict.
//
// CLI (the workflow's only step):
//   GITHUB_TOKEN=... REPO=owner/name PR=<number> node scripts/fleet-status.mjs [--dry-run]

import { pathToFileURL } from 'node:url';

export const REDLINE_LOGIN = 'sprayberry-redline';
export const SECOND_READ_LOGIN = 'sprayberry-secondread';
export const VERIFIER_LOGIN = 'askalf';
export const DETERMINISTIC_APPROVAL_MARKER = '**Deterministic approval';
export const CONTEXTS = { verify: 'fleet/verify', review: 'fleet/review', secondRead: 'fleet/second-read' };
const OWN_CONTEXTS = new Set(Object.values(CONTEXTS));

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

/**
 * Dependabot, or a bot-shaped branch opened by askalf or github-actions: verification-exempt.
 * The branch name alone is not enough, because anyone can name a branch `release-x`. This is
 * the dispatcher's rule: review-dispatch.sh's `gate` field and needsVerification() in
 * public-automerge-sweep.ts both require one of our identities AND a bot-shaped branch.
 */
export function isBotPr(author, headRef) {
  if (/^(app\/)?dependabot(\[bot\])?$/i.test(author ?? '')) return true;
  return /^(askalf|(app\/)?github-actions(\[bot\])?)$/i.test(author ?? '') && BOT_BRANCH.test(headRef ?? '');
}

export function needsVerify(facts) {
  if (isBotPr(facts.author, facts.headRef)) return false;
  // More than 100 files: the dispatcher reads the first 100 and fails closed on the rest
  // (readPrFacts in platform's review-events.ts), so the lanes do the same.
  return facts.files.length > 100 || facts.files.some(isCodePath);
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

const CHECK_WAITING = /^(PENDING|EXPECTED|QUEUED|IN_PROGRESS|WAITING|REQUESTED)$/;
const CHECK_PASSED = /^(SUCCESS|NEUTRAL|SKIPPED)$/;

/**
 * The head's required checks: 'none' (the branch requires none), 'pending' (one has not reported
 * or is still running), 'failed', or 'passed'. `checks` is in the order GitHub reported them; the
 * last result per name counts. The lanes this script posts (CONTEXTS) are never CI: once they are
 * required checks themselves, counting them would leave fleet/verify waiting on itself forever.
 * @param {string[]} required
 * @param {Array<{name:string, state:string}>} checks
 */
export function requiredCiState(required, checks) {
  required = required.filter((r) => !OWN_CONTEXTS.has(r));
  if (!required.length) return 'none';
  const last = new Map();
  for (const c of checks) if (c.name) last.set(c.name, String(c.state ?? '').toUpperCase());
  let pending = false;
  for (const r of required) {
    const s = last.get(r) ?? '';
    if (s === '' || CHECK_WAITING.test(s)) pending = true;
    else if (!CHECK_PASSED.test(s)) return 'failed';
  }
  return pending ? 'pending' : 'passed';
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
    // A dismissed review no longer stands, whatever its body says.
    if (r.login !== SECOND_READ_LOGIN || r.commitId !== facts.head || r.state === 'DISMISSED') continue;
    let last = null;
    for (const m of (r.body ?? '').matchAll(/^SECOND READ: (READY[ \t\r]*$|NOT READY\b.*)$/gm)) last = m[1];
    if (last === null) continue;
    out = last.startsWith('NOT READY')
      // Drop the one separator after NOT READY; keep a leading backtick, quote or bracket.
      ? { state: 'NOT READY', reason: last.replace(/^NOT READY\s*(?:[^\w\s`'"([{]\s*)?/, '').trim() }
      : { state: 'READY', reason: '' };
  }
  return out;
}

/** The newest status per context. GitHub lists a commit's statuses newest first. */
export function latestByContext(statuses) {
  const out = new Map();
  for (const s of statuses) {
    if (!out.has(s.context)) out.set(s.context, { state: s.state, description: s.description ?? '' });
  }
  return out;
}

/** The statuses in `want` that the head does not already show exactly (state and description). */
export function statusesToPost(want, have) {
  return want.filter((s) => {
    const h = have.get(s.context);
    return !h || h.state !== s.state || h.description !== s.description;
  });
}

/**
 * Every row across pages. `page(n)` returns page n's rows; a page shorter than `size` is the last.
 * @param {(n: number) => Promise<unknown[]>} page
 */
export async function collectPages(page, size = 100) {
  const out = [];
  for (let n = 1; ; n++) {
    const rows = await page(n);
    out.push(...rows);
    if (rows.length < size) return out;
  }
}

const short = (sha) => (sha ?? '').slice(0, 7);
const fit = (s) => (s.length <= 140 ? s : `${s.slice(0, 137)}...`);

/**
 * The three statuses for a PR, from what GitHub says about it.
 * @param {{head:string, headRef:string, author:string, files:string[], labels:string[],
 *          reviews:Array<{login:string,state:string,commitId:string,body:string}>,
 *          comments:Array<{login:string,body:string}>, requiredCi?:'none'|'pending'|'failed'|'passed'}} facts
 * @returns {Array<{context:string, state:'pending'|'success'|'failure', description:string}>}
 */
export function laneStatuses(facts) {
  const h = short(facts.head);
  const code = needsVerify(facts);
  const ci = facts.requiredCi ?? 'none';
  const verified = code && (ci === 'passed' || (ci === 'none' && verifiedAtHead(facts)));
  const out = [];

  out.push(!code
    ? { context: CONTEXTS.verify, state: 'success', description: 'Not required: docs, assets, .github config or a bot branch' }
    : verified
      ? { context: CONTEXTS.verify, state: 'success', description: ci === 'passed' ? `Required CI passed at ${h}` : `Verified at ${h}` }
      : ci === 'failed'
        ? { context: CONTEXTS.verify, state: 'failure', description: `A required check failed at ${h}` }
        : ci === 'pending'
          ? { context: CONTEXTS.verify, state: 'pending', description: `Waiting on required CI at ${h}` }
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

// CLI
async function gh(path, token, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

function ghAll(path, token) {
  return collectPages(async (n) => (await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${n}`, token)).json());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_TOKEN: token, REPO: repo, PR: pr, TARGET_URL: targetUrl } = process.env;
  const dryRun = process.argv.includes('--dry-run');
  if (!token || !repo || !/^\d+$/.test(pr ?? '')) {
    console.error('usage: GITHUB_TOKEN=... REPO=owner/name PR=<number> node scripts/fleet-status.mjs [--dry-run]');
    process.exit(2);
  }

  /** Everything the lanes depend on, read fresh. Null when the PR is closed or from a fork. */
  async function readFacts() {
    const p = await (await gh(`/repos/${repo}/pulls/${pr}`, token)).json();
    if (p.state !== 'open') { console.log(`#${pr} is ${p.state}; nothing to report`); return null; }
    if (p.head?.repo?.full_name !== repo) { console.log(`#${pr} is a fork PR; the fleet does not review it`); return null; }
    const [files, reviews, comments] = await Promise.all([
      ghAll(`/repos/${repo}/pulls/${pr}/files`, token),
      ghAll(`/repos/${repo}/pulls/${pr}/reviews`, token),
      ghAll(`/repos/${repo}/issues/${pr}/comments`, token),
    ]);
    // Unreadable rules or checks count as pending, as the dispatcher waits on them; neither can
    // turn fleet/verify green.
    let required = null;
    try {
      const rules = await (await gh(`/repos/${repo}/rules/branches/${encodeURIComponent(p.base.ref)}?per_page=100`, token)).json();
      required = rules.filter((r) => r.type === 'required_status_checks')
        .flatMap((r) => (r.parameters?.required_status_checks ?? []).map((c) => c.context));
    } catch { required = null; }
    let requiredCi = required === null ? 'pending' : 'none';
    if (required?.length) {
      try {
        const statuses = (await ghAll(`/repos/${repo}/commits/${p.head.sha}/statuses`, token)).reverse()
          .map((s) => ({ name: s.context, state: s.state }));
        const runs = await collectPages(async (n) =>
          (await (await gh(`/repos/${repo}/commits/${p.head.sha}/check-runs?per_page=100&page=${n}`, token)).json()).check_runs ?? []);
        const checks = runs.sort((a, b) => a.id - b.id)
          .map((c) => ({ name: c.name, state: c.status === 'completed' ? (c.conclusion ?? '') : c.status }));
        requiredCi = requiredCiState(required, [...statuses, ...checks]);
      } catch { requiredCi = 'pending'; }
    }
    return {
      url: p.html_url,
      facts: {
        head: p.head.sha,
        headRef: p.head.ref,
        author: p.user?.login ?? '',
        files: files.map((f) => f.filename),
        labels: (p.labels ?? []).map((l) => l.name),
        reviews: reviews.map((r) => ({ login: r.user?.login ?? '', state: r.state, commitId: r.commit_id ?? '', body: r.body ?? '' })),
        comments: comments.map((c) => ({ login: c.user?.login ?? '', body: c.body ?? '' })),
        requiredCi,
      },
    };
  }

  // Post, then read everything again and correct what differs. Another run can read older data
  // and post after this one; the run that acts last re-reads after its own writes, so what stays
  // on the head matches data at least as new as anything posted. Three passes bound a busy PR;
  // the next event covers anything after that.
  for (let pass = 1; pass <= 3; pass++) {
    const read = await readFacts();
    if (!read) break;
    const want = laneStatuses(read.facts);
    if (pass === 1) for (const s of want) console.log(`${s.context.padEnd(18)} ${s.state.padEnd(8)} ${s.description}`);
    if (dryRun) break;
    const have = latestByContext(await ghAll(`/repos/${repo}/commits/${read.facts.head}/statuses`, token));
    const todo = statusesToPost(want, have);
    if (!todo.length) break;
    if (pass > 1) console.log(`pass ${pass}: correcting ${todo.map((s) => s.context).join(', ')}`);
    for (const s of todo) {
      await gh(`/repos/${repo}/statuses/${read.facts.head}`, token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...s, target_url: targetUrl || read.url }),
      });
    }
  }
}
