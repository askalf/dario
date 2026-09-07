// scripts/check-issue-close-keywords.mjs — the CI gate that stops a PR from
// auto-closing an issue somebody else filed. Pure helpers are tested directly;
// main() takes an injected issue reader, so the whole file runs offline with
// no token and no API calls.

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

const { KEYWORDS, stripCode, closingRefs, main } = await import('../scripts/check-issue-close-keywords.mjs');

const REPO = 'askalf/dario';
const nums = (text) => closingRefs(text, REPO).map((r) => r.number);

header('stripCode — what GitHub does not linkify');
{
  check('fenced block is dropped', stripCode('a\n```\nFixes #1\n```\nb') === 'a\n\nb');
  check('tilde fence is dropped too', stripCode('~~~\nFixes #1\n~~~') === '');
  check('inline code is dropped', stripCode('see `Fixes #1` above').includes('Fixes #1') === false);
  check('an unterminated fence swallows the rest', nums('Fixes #1\n```\nFixes #2\n') .join() === '1');
  check('prose outside a fence survives', stripCode('Fixes #7').trim() === 'Fixes #7');
}

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
    try { return await main({ ...env, PR_BODY: body }, async () => issue); }
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

header('main — the reader is only called for references we can judge');
{
  let calls = 0;
  const origLog = console.log;
  console.log = () => {};
  const code = await main(
    { GITHUB_REPOSITORY: REPO, PR_TITLE: 'nothing to see (#1244)', PR_BODY: 'Addresses #1244 and #1232.' },
    async () => { calls++; return { login: 'ramarro123', isBot: false, isPullRequest: false }; },
  );
  console.log = origLog;
  check('a PR with no closing keyword makes zero API calls', calls === 0 && code === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
