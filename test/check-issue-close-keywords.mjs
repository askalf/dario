// scripts/check-issue-close-keywords.mjs — the CI gate that stops a PR from
// auto-closing an issue somebody else filed. Pure helpers are tested directly;
// main() takes injected issue and commit readers, so the whole file runs
// offline with no token and no API calls.

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}`); fail++; }
}
function header(label) {
  console.log(`\n======================================================================`);
  console.log(`  ${label}`);
  console.log(`======================================================================`);
}

const { KEYWORDS, closingRefs, closingRefsBySource, main, readIssue, readCommits } =
  await import('../scripts/check-issue-close-keywords.mjs');

const REPO = 'askalf/dario';
const nums = (text) => closingRefs(text, REPO).map((r) => r.number);
const resp = (status, body = {}) => async () => ({
  status, ok: status >= 200 && status < 300,
  statusText: String(status), json: async () => body,
});

// The first commit message on #1255, verbatim (72-column wrapped, as it was
// squashed into 11ed1fe). It closed #1244 on merge; the gate had not read it.
const COMMIT_1255 = [
  'ci: a PR may not auto-close an issue somebody else filed',
  '',
  '#1244 was open and mid-conversation — the reporter was still asking about',
  'his six-seat pool — when #1245 merged with `Fixes #1244.` as its first',
  'line. GitHub closed it under him and he read the close as a verdict on',
  'questions nobody had answered yet.',
].join('\n');

header('closingRefs — what counts as a closing reference');
{
  check('every GitHub keyword is caught', KEYWORDS.every((k) => nums(`${k} #4`).length === 1));
  check('case does not matter', nums('FIXES #4').join() === '4');
  check('the colon form is caught', nums('Fixes: #4').join() === '4');
  check('no space is caught', nums('Fixes#4').join() === '4');
  check('the #1245 shape — first line of the body', nums('Fixes #1244.\n\n**What the reporter saw**').join() === '1244');
  check('a title carrying the number the way #1245 did is NOT a keyword', nums('A seat parked on a 429 says so (#1244)').length === 0);
  check('`Addresses #N` is not a closing reference', nums('Addresses #1244.').length === 0);
  check('a bare number links freely', nums('routing has expired rejections on it since #1232').length === 0);
  check('prose before a number is not a keyword', nums('the rejection resolved in #1232').length === 0);
  check('a newline between keyword and ref is prose, not a reference', nums('this fixes\n\n#1234 is related').length === 0);
  check('the word is matched whole', nums('prefixes#4').length === 0);
  check('same-repo owner/repo#N counts', nums('Fixes askalf/dario#9').join() === '9');
  check('another repo is not ours to judge', nums('Fixes askalf/warden#9').length === 0);
  check('the full issue URL counts', nums('Closes https://github.com/askalf/dario/issues/11').join() === '11');
  check('a PR URL is not an issue URL', nums('Closes https://github.com/askalf/dario/pull/11').length === 0);
  check('repeats collapse to one', nums('Fixes #4. Also closes #4.').join() === '4');
  check('several refs all surface, in order', nums('Closes #9, fixes #2').join() === '2,9');
  check('the keyword is reported as written', closingRefs('Resolved #3', REPO)[0].keyword === 'resolved');
}

header('code is not a shield — GitHub reads a commit message raw (#1255)');
{
  check('a keyword in inline code is still a keyword', nums('merged with `Fixes #1244.` as its first line').join() === '1244');
  check('a keyword in a fenced block is still a keyword', nums('```\nFixes #12\n```').join() === '12');
  check('the real #1255 commit message is caught', nums(COMMIT_1255).join() === '1244');
  check('the safe way to quote: word and number apart', nums('write `Fixes` and then #1244 on its own').length === 0);
  check('the other safe way: no hash', nums('a keyword like Fixes 1244 without the hash').length === 0);
}

header('closingRefsBySource — where each reference was seen');
{
  const refs = closingRefsBySource([
    { where: 'title', text: 'nothing here (#1244)' },
    { where: 'body', text: 'Addresses #1244.' },
    { where: 'commit e9bda80', text: COMMIT_1255 },
    { where: 'commit ae87d4e', text: 'Fixes #1244 again, and closes #7' },
  ], REPO);
  const by = Object.fromEntries(refs.map((r) => [r.number, r]));
  check('a reference seen only in a commit surfaces', by[1244] !== undefined);
  check('and names every commit that carried it', by[1244].where.join() === 'commit e9bda80,commit ae87d4e');
  check('title and body did not count for it', !by[1244].where.includes('title') && !by[1244].where.includes('body'));
  check('a second issue from the same commit is its own entry', by[7]?.where.join() === 'commit ae87d4e');
}

header('readIssue — only 404 means "does not exist" (#1255 review)');
{
  const ENV = { GITHUB_REPOSITORY: REPO };
  let r = await readIssue(7, ENV, resp(404));
  check('404 -> null (the reference really does not resolve)', r === null);

  r = await readIssue(7, ENV, resp(200, { user: { login: 'someone', type: 'User' } }));
  check('200 -> the filer is read', r !== null && r.login === 'someone');

  for (const status of [403, 401, 429, 500, 502, 503]) {
    let threw = false;
    try { await readIssue(7, ENV, resp(status)); } catch { threw = true; }
    check(`${status} throws rather than reading as "does not resolve"`, threw);
  }
}

header('readCommits — every page, and nothing but 2xx is an answer');
{
  const ENV = { GITHUB_REPOSITORY: REPO };
  const commit = (sha, message) => ({ sha, commit: { message } });

  const one = await readCommits(1255, ENV, resp(200, [commit('e9bda80abc', COMMIT_1255), commit('ae87d4eabc', 'ci: silence SC2016')]));
  check('a single page is read as { sha, message }', one.length === 2 && one[0].sha === 'e9bda80abc' && one[1].message === 'ci: silence SC2016');

  const pages = [Array.from({ length: 100 }, (_, i) => commit(`sha${i}`, `m${i}`)), [commit('last', 'tail')]];
  let calls = 0;
  const paged = await readCommits(1255, ENV, async (url) => { calls++; return { ok: true, status: 200, json: async () => pages[Number(new URL(url).searchParams.get('page')) - 1] ?? [] }; });
  check('a full page means ask for the next one', calls === 2 && paged.length === 101 && paged[100].sha === 'last');

  for (const status of [403, 404, 500]) {
    let threw = false;
    try { await readCommits(1255, ENV, resp(status)); } catch { threw = true; }
    check(`${status} throws — an unreadable commit list is not a clean one`, threw);
  }
}

header('main — commit messages are judged, and the #1255 regression fails');
{
  const reporter = { login: 'ramarro123', isBot: false, isPullRequest: false };
  const ENV = { GITHUB_REPOSITORY: REPO, PR_NUMBER: '1255', PR_TITLE: 'nothing here (#1244)', PR_BODY: 'Addresses #1244.' };
  const quiet = async (fn) => {
    const origLog = console.log, origErr = console.error;
    const err = [];
    console.log = () => {}; console.error = (s) => err.push(String(s));
    try { return { code: await fn(), err: err.join('\n') }; }
    finally { console.log = origLog; console.error = origErr; }
  };

  const r = await quiet(() => main(ENV, async () => reporter, async () => [{ sha: 'e9bda80abc', message: COMMIT_1255 }]));
  check('a clean title and body with the #1255 commit message → exit 1', r.code === 1);
  check('the failure names the commit', r.err.includes('in commit e9bda80'));
  check('the failure says how to quote a keyword safely', r.err.includes('Keep the word and the number apart'));

  const clean = await quiet(() => main(ENV, async () => reporter, async () => [{ sha: 'abc', message: 'ci: tidy\n\nAddresses #1244.' }]));
  check('clean commits with a clean title and body → exit 0', clean.code === 0);

  const unreadable = await quiet(() => main(ENV, async () => reporter, async () => { throw new Error('403 Forbidden'); }));
  check('commits that cannot be read → exit 1, never 0', unreadable.code === 1 && unreadable.err.includes('could not read the commits'));

  let commitCalls = 0;
  const noNumber = await quiet(() => main({ ...ENV, PR_NUMBER: '' }, async () => reporter, async () => { commitCalls++; return []; }));
  check('no PR_NUMBER → title and body only, commits never requested', noNumber.code === 0 && commitCalls === 0);
}

header('main — who may be auto-closed');
{
  const reporter = { login: 'ramarro123', isBot: false, isPullRequest: false };
  const owner = { login: 'askalf', isBot: false, isPullRequest: false };
  const bot = { login: 'github-actions[bot]', isBot: true, isPullRequest: false };
  const pr = { login: 'ramarro123', isBot: false, isPullRequest: true };
  const env = { GITHUB_REPOSITORY: REPO, PR_TITLE: '', PR_BODY: '' };
  const run = async (body, issue) => {
    const origLog = console.log, origErr = console.error;
    console.log = () => {}; console.error = () => {};
    try { return await main({ ...env, PR_BODY: body }, async () => issue, async () => []); }
    finally { console.log = origLog; console.error = origErr; }
  };

  check('the #1244 regression — reporter-filed issue → exit 1', await run('Fixes #1244.', reporter) === 1);
  check('`Addresses` on the same issue → exit 0', await run('Addresses #1244.', reporter) === 0);
  check('owner-filed issue may be auto-closed → exit 0', await run('Fixes #1244.', owner) === 0);
  check('owner match is case-insensitive', await run('Fixes #1244.', { ...owner, login: 'AskAlf' }) === 0);
  check('bot-filed drift alert may be auto-closed → exit 0', await run('Fixes #1244.', bot) === 0);
  check('a reference to a PR is not an issue → exit 0', await run('Fixes #1244.', pr) === 0);
  check('a reference that does not resolve → exit 0', await run('Fixes #99999.', null) === 0);
  check('no closing keyword at all → exit 0', await run('Addresses nothing in particular.', reporter) === 0);
  check('empty body → exit 0', await run('', reporter) === 0);
}

header('main — a lookup it cannot perform fails CLOSED');
{
  const ENV = { GITHUB_REPOSITORY: REPO, PR_TITLE: 'Fixes #1244', PR_BODY: '' };
  const origErr = console.error; console.error = () => {};
  const throwing = async () => { throw new Error('GitHub issue lookup for #1244 failed: 403 rate limited'); };
  check('reader throws -> exit 1, never 0', (await main(ENV, throwing, async () => [])) === 1);
  const missing = async () => null;
  check('reader returns null (real 404) -> still tolerated, exit 0', (await main(ENV, missing, async () => [])) === 0);
  console.error = origErr;
}

header('main — the readers are only called for references we can judge');
{
  let calls = 0;
  const origLog = console.log;
  console.log = () => {};
  const code = await main(
    { GITHUB_REPOSITORY: REPO, PR_TITLE: 'nothing to see (#1244)', PR_BODY: 'Addresses #1244 and #1232.' },
    async () => { calls++; return { login: 'ramarro123', isBot: false, isPullRequest: false }; },
    async () => [],
  );
  console.log = origLog;
  check('a PR with no closing keyword makes zero issue lookups', calls === 0 && code === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
