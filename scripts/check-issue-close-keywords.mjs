// A PR may not auto-close an issue somebody else filed.
//
// WHY THIS EXISTS. #1244 was open and mid-conversation — the reporter was
// still answering questions about his six-seat pool — when #1245 merged with
// `Fixes #1244.` as its first line. GitHub closed the issue out from under
// him, and he read the close as a verdict on questions nobody had answered
// yet. It had to be reopened by hand and explained: "the close was my PR's
// `Fixes` keyword firing on merge, not anyone's verdict." The convention —
// `Addresses #N` for an issue you did not file, so the reporter is the one
// who decides when it is done — was house rule, written down, and skipped
// anyway. Advice is not a gate. This is the gate.
//
// Rule: a closing keyword (close / fix / resolve, any tense) pointing at an
// issue in this repo fails the check when a human other than the repo owner
// filed it. Exempt: issues filed by the owner, and issues filed by bots —
// the drift watchers and canaries open issues precisely so a later run can
// close them. References to pull requests are ignored, and a bare `#N` or an
// `Addresses #N` links as freely as it ever did.
//
// Both title and body are scanned. GitHub honours the keyword in the body
// only, but a squash merge makes the PR title the commit subject, and a
// keyword in a commit message on master closes the issue just the same.
//
// Inputs via env so it is trivially runnable by hand:
//   PR_TITLE / PR_BODY   the text to judge (either may be empty)
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
 * Drop what GitHub does not linkify: fenced blocks and inline code. A `Fixes
 * #12` quoted inside a paste of somebody's log is not a link and must not be
 * read as one — half of #1244's thread is pasted JSON.
 * Exported for the unit test.
 */
export function stripCode(text) {
  return String(text || '')
    .replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm, '')
    // An unterminated fence swallows the rest of the text, exactly as GitHub
    // renders it — a body that opens a fence and never closes it has no live
    // references after that point.
    .replace(/^[ \t]*(```|~~~)[\s\S]*$/m, '')
    .replace(/`[^`\n]*`/g, '');
}

/**
 * Closing references to THIS repo, deduped by issue number. A cross-repo
 * `owner/other#5` closes an issue we do not own and cannot judge; we let it
 * be. Exported for the unit test.
 */
export function closingRefs(text, repository) {
  const [owner, repo] = String(repository || '').split('/');
  const out = new Map();
  for (const m of stripCode(text).matchAll(REF)) {
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

function sameRepo(a, b, owner, repo) {
  return !!owner && a?.toLowerCase() === owner.toLowerCase() && b?.toLowerCase() === repo?.toLowerCase();
}

/**
 * Who filed issue N: `{ login, isBot, isPullRequest }`, or null when it does
 * not resolve. The default reader hits the REST API; the test injects its own.
 */
async function readIssue(number, env) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dario-close-gate' };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/issues/${number}`, { headers });
  if (!res.ok) return null;
  const issue = await res.json();
  return {
    login: issue.user?.login ?? '',
    isBot: issue.user?.type === 'Bot',
    isPullRequest: !!issue.pull_request,
  };
}

export async function main(env = process.env, readIssueFn = readIssue) {
  const repository = env.GITHUB_REPOSITORY || '';
  const owner = repository.split('/')[0] || '';
  const text = `${env.PR_TITLE || ''}\n${env.PR_BODY || ''}`;

  const refs = closingRefs(text, repository);
  if (refs.length === 0) {
    console.log('check-issue-close-keywords: no closing keywords — nothing to judge.');
    return 0;
  }

  const offenders = [];
  for (const ref of refs) {
    const issue = await readIssueFn(ref.number, env);
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
  for (const o of offenders) console.error(`  "${o.keyword} #${o.number}" — #${o.number} was filed by @${o.login}`);
  console.error('');
  console.error('Merging closes the thread on the reporter, mid-conversation, with a keyword rather than an answer (#1244).');
  console.error('Write `Addresses #N` instead and leave the issue open — the person who filed it closes it when it reads right.');
  return 1;
}

// Run when invoked directly; importable (for the test) without side effects.
// Compared as URLs, not by basename — the unit test file shares this name.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
