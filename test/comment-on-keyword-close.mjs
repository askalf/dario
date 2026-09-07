// scripts/comment-on-keyword-close.mjs — the repair half of the gate that
// stops a `Fixes #N` from silently closing somebody else's issue. main() takes
// an injected API object, so every case runs offline with no token and the
// write path is asserted on without writing.

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

const { isExempt, closerLabel, commentBody, main } = await import('../scripts/comment-on-keyword-close.mjs');

header('isExempt — whose closes we never comment on');
{
  check('the owner may close his own issues', isExempt('askalf', 'User', 'askalf'));
  check('owner match is case-insensitive', isExempt('AskAlf', 'User', 'askalf'));
  check('a bot-filed drift alert is exempt', isExempt('github-actions[bot]', 'Bot', 'askalf'));
  check('a reporter is not exempt', isExempt('ramarro123', 'User', 'askalf') === false);
}

header('closerLabel — what closed it');
{
  check('a PR reads as its number', closerLabel({ __typename: 'PullRequest', number: 1245 }) === 'PullRequest #1245');
  check('a commit reads as its short sha', closerLabel({ __typename: 'Commit', abbreviatedOid: 'abc1234' }) === 'Commit abc1234');
  check('null means a person clicked close', closerLabel(null) === null);
  check('undefined is null too', closerLabel(undefined) === null);
}

header('commentBody — the words the reporter reads');
{
  const body = commentBody({
    author: 'ramarro123', number: 1244, closer: 'PullRequest #1245',
    serverUrl: 'https://github.com', repo: 'askalf/dario',
  });
  check('names the reporter', body.includes('@ramarro123'));
  check('names what closed it', body.includes('PullRequest #1245'));
  check('says the close was a keyword, not a verdict', body.includes('not because anyone decided the report was answered'));
  check('invites a reopen rather than performing one', body.includes('reopen it and say what is still wrong'));
  check('does not claim to have reopened anything', /reopened automatically/i.test(body) === false);
  check('points at `Addresses #N` for the follow-up', body.includes('`Addresses #1244`'));
  check('links the workflow that did this', body.includes('https://github.com/askalf/dario/blob/master/.github/workflows/keyword-close-notice.yml'));
}

header('main — comments on exactly the closes that were keywords');
{
  const env = {
    GITHUB_REPOSITORY: 'askalf/dario', ISSUE_NUMBER: '1244',
    ISSUE_AUTHOR: 'ramarro123', ISSUE_AUTHOR_TYPE: 'User',
    GITHUB_SERVER_URL: 'https://github.com',
  };
  const run = async (over, closer) => {
    const calls = { closer: 0, comment: [] };
    const api = {
      closer: async () => { calls.closer++; return closer; },
      comment: async (_r, _n, body) => { calls.comment.push(body); },
    };
    const origLog = console.log; console.log = () => {};
    try { calls.code = await main({ ...env, ...over }, api); } finally { console.log = origLog; }
    return calls;
  };
  const byPr = { __typename: 'PullRequest', number: 1245 };

  const keyword = await run({}, byPr);
  check('the #1244 regression — keyword close leaves one comment', keyword.comment.length === 1 && keyword.code === 0);
  check('and that comment addresses the reporter', keyword.comment[0].includes('@ramarro123'));
  check('the API object has no reopen to call', typeof (await import('../scripts/comment-on-keyword-close.mjs')).reopen === 'undefined');

  const human = await run({}, null);
  check('a person clicking close is left silent', human.comment.length === 0);

  const owner = await run({ ISSUE_AUTHOR: 'askalf' }, byPr);
  check('the owner\'s own issue gets no comment', owner.comment.length === 0 && owner.closer === 0);

  const bot = await run({ ISSUE_AUTHOR: 'github-actions[bot]', ISSUE_AUTHOR_TYPE: 'Bot' }, byPr);
  check('a bot-filed alert gets no comment', bot.comment.length === 0 && bot.closer === 0);
  check('an exempt issue costs zero API calls', owner.closer === 0 && bot.closer === 0);

  const dry = await run({ DRY_RUN: '1' }, byPr);
  check('DRY_RUN reads but never writes', dry.closer === 1 && dry.comment.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
