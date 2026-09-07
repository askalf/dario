// A PR may not auto-close an issue somebody else filed.
//
// WHY THIS EXISTS. #1244 was open and mid-conversation — the reporter was
// still answering questions about his six-seat pool — when #1245 merged with
// a closing keyword on it as the first line of its body. GitHub closed the
// issue out from under him, and he read the close as a verdict on questions
// nobody had answered yet. It had to be reopened by hand and explained. The
// convention — `Addresses #N` for an issue you did not file, so the reporter
// is the one who decides when it is done — was house rule, written down, and
// skipped anyway. Advice is not a gate. This is the gate.
//
// WHY COMMIT MESSAGES TOO, AND WHY NOTHING IS STRIPPED. The first version of
// this file read the PR title and body, and stripped code spans because a PR
// body does not link from inside backticks. Then #1255 — the PR that added it
// — closed #1244 a second time on merge. This repo squash-merges with the
// branch's commit messages as the commit body; the first commit on that
// branch quoted the keyword in backticks while telling the story above; the
// gate never read a commit message; and GitHub scans a commit message raw,
// backticks and all. So: title, body, and every commit on the branch, and a
// keyword inside code is a keyword. Quoting one on purpose? Keep the word and
// the number apart — `Fixes` … #1244 — or drop the `#`.
//
// Rule: a closing keyword (close / fix / resolve, any tense) pointing at an
// issue in this repo fails the check when a human other than the repo owner
// filed it. Exempt: issues filed by the owner, and issues filed by bots —
// the drift watchers and canaries open issues precisely so a later run can
// close them. References to pull requests are ignored, and a bare `#N` or an
// `Addresses #N` links as freely as it ever did.
//
// Inputs via env so it is trivially runnable by hand:
//   PR_TITLE / PR_BODY   the text to judge (either may be empty)
//   PR_NUMBER            when set, the PR's commit messages are read and judged
//   GITHUB_REPOSITORY    owner/repo — the owner is who may auto-close
//   GITHUB_TOKEN         optional; raises the API rate limit
import { pathToFileURL } from 'node:url';

/** GitHub's closing keywords, verbatim from its docs. */
export const KEYWORDS = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'];

const REF = new RegExp(
  // The gap is same-line whitespace on purpose: "…this fixes\n\n#1234 is
  // related" is prose about a neighbouring issue, not a closing reference.
  String.raw`\b(${KEYWORDS.join('|')})\b[ \t]*:?[ \t]*(?:` +
    String.raw`#(\d+)` + '|' +
    String.raw`([\w.-]+)/([\w.-]+)#(\d+)` + '|' +
    String.raw`https?://github\.com/([\w.-]+)/([\w.-]+)/issues/(\d+)` +
  ')',
  'gi',
);

/**
 * Closing references to THIS repo in one piece of text, deduped by issue
 * number. Read raw — no code stripping, see the header. A cross-repo
 * `owner/other#5` closes an issue we do not own and cannot judge; we let it
 * be. Exported for the unit test.
 */
export function closingRefs(text, repository) {
  const [owner, repo] = String(repository || '').split('/');
  const out = new Map();
  for (const m of String(text || '').matchAll(REF)) {
    const [, keyword, bare, refOwner, refRepo, refNum, urlOwner, urlRepo, urlNum] = m;
    let number = null;
    if (bare) number = bare;
    else if (refNum && sameRepo(refOwner, refRepo, owner, repo)) number = refNum;
    else if (urlNum && sameRepo(urlOwner, urlRepo, owner, repo)) number = urlNum;
    if (number === null) continue;
    const n = Number(number);
    if (!out.has(n)) out.set(n, { number: n, keyword: keyword.toLowerCase() });
  }
  return [...out.values()].sort((a, b) => a.number - b.number);
}

/**
 * The same over several sources — `{ where, text }` for the title, the body,
 * and each commit — merged by issue number and remembering where each was
 * seen, so the failure names the line to fix. Exported for the unit test.
 */
export function closingRefsBySource(sources, repository) {
  const out = new Map();
  for (const { where, text } of sources) {
    for (const ref of closingRefs(text, repository)) {
      const seen = out.get(ref.number);
      if (seen) seen.where.push(where);
      else out.set(ref.number, { ...ref, where: [where] });
    }
  }
  return [...out.values()].sort((a, b) => a.number - b.number);
}

function sameRepo(a, b, owner, repo) {
  return !!owner && a?.toLowerCase() === owner.toLowerCase() && b?.toLowerCase() === repo?.toLowerCase();
}

function apiHeaders(env) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dario-close-gate' };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

/**
 * Who filed issue N: `{ login, isBot, isPullRequest }`, or null when it does
 * not resolve. The default reader hits the REST API; the test injects its own.
 */
export async function readIssue(number, env, fetchFn = fetch) {
  const res = await fetchFn(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/issues/${number}`, { headers: apiHeaders(env) });
  // Only 404 proves the reference does not exist. Any other failure — a 403
  // from a rate-limited or under-permissioned token, a transient 5xx — means
  // we do not KNOW who filed it. Returning null there let the gate pass on
  // ignorance: the exact fail-open a gate must not have.
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub issue lookup for #${number} failed: ${res.status} ${res.statusText}`);
  }
  const issue = await res.json();
  return {
    login: issue.user?.login ?? '',
    isBot: issue.user?.type === 'Bot',
    isPullRequest: !!issue.pull_request,
  };
}

/**
 * Every commit on the PR as `{ sha, message }`, all pages. Anything but a
 * 2xx throws — a commit list we could not read is not evidence that the
 * commits are clean. Exported for the unit test.
 */
export async function readCommits(prNumber, env, fetchFn = fetch) {
  const out = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/pulls/${prNumber}/commits?per_page=100&page=${page}`;
    const res = await fetchFn(url, { headers: apiHeaders(env) });
    if (!res.ok) {
      throw new Error(`GitHub commit listing for PR #${prNumber} failed: ${res.status} ${res.statusText}`);
    }
    const batch = await res.json();
    for (const c of batch) out.push({ sha: c.sha, message: c.commit?.message ?? '' });
    if (batch.length < 100) return out;
  }
}

export async function main(env = process.env, readIssueFn = readIssue, readCommitsFn = readCommits) {
  const repository = env.GITHUB_REPOSITORY || '';
  const owner = repository.split('/')[0] || '';

  const sources = [
    { where: 'title', text: env.PR_TITLE || '' },
    { where: 'body', text: env.PR_BODY || '' },
  ];
  if (env.PR_NUMBER) {
    let commits;
    try {
      commits = await readCommitsFn(Number(env.PR_NUMBER), env);
    } catch (err) {
      console.error(`FAIL: could not read the commits on PR #${env.PR_NUMBER}.`);
      console.error(`  ${err instanceof Error ? err.message : err}`);
      console.error('The gate fails closed: a squash merge carries every commit message, and none of them could be judged.');
      return 1;
    }
    for (const c of commits) sources.push({ where: `commit ${c.sha.slice(0, 7)}`, text: c.message });
    console.log(`check-issue-close-keywords: judging title, body and ${commits.length} commit message(s).`);
  } else {
    console.log('check-issue-close-keywords: no PR_NUMBER — judging title and body only, commit messages not read.');
  }

  const refs = closingRefsBySource(sources, repository);
  if (refs.length === 0) {
    console.log('check-issue-close-keywords: no closing keywords — nothing to judge.');
    return 0;
  }

  const offenders = [];
  for (const ref of refs) {
    let issue;
    try {
      issue = await readIssueFn(ref.number, env);
    } catch (err) {
      // Fail CLOSED. A lookup we could not perform is not evidence that the
      // reference is harmless.
      console.error(`FAIL: could not determine who filed #${ref.number}.`);
      console.error(`  ${err instanceof Error ? err.message : err}`);
      console.error('The gate fails closed: re-run once the API is reachable, or fix the token scope.');
      return 1;
    }
    if (issue === null) {
      // A reference that does not resolve closes nothing. Say so and move on
      // rather than failing a PR over a typo in prose.
      console.log(`  #${ref.number}: does not resolve — ignored.`);
      continue;
    }
    if (issue.isPullRequest) { console.log(`  #${ref.number}: a pull request, not an issue — ignored.`); continue; }
    if (issue.isBot) { console.log(`  #${ref.number}: filed by ${issue.login} (bot) — auto-close is what it is for.`); continue; }
    if (issue.login.toLowerCase() === owner.toLowerCase()) { console.log(`  #${ref.number}: filed by ${issue.login} (owner) — ok.`); continue; }
    offenders.push({ ...ref, login: issue.login });
  }

  if (offenders.length === 0) {
    console.log(`check-issue-close-keywords: ${refs.length} closing reference(s), none of them somebody else's issue — ok.`);
    return 0;
  }

  console.error('FAIL: this PR would auto-close an issue it does not own:');
  for (const o of offenders) {
    console.error(`  "${o.keyword} #${o.number}" in ${o.where.join(', ')} — #${o.number} was filed by @${o.login}`);
  }
  console.error('');
  console.error('Merging closes the thread on the reporter, mid-conversation, with a keyword rather than an answer (#1244).');
  console.error('Write `Addresses #N` instead and leave the issue open — the person who filed it closes it when it reads right.');
  console.error('A commit message counts: a squash merge carries every one, and GitHub reads them raw, backticks and all.');
  console.error('Quoting the keyword on purpose? Keep the word and the number apart — `Fixes` … #N — or drop the `#`.');
  return 1;
}

// Run when invoked directly; importable (for the test) without side effects.
// Compared as URLs, not by basename — the unit test file shares this name.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
