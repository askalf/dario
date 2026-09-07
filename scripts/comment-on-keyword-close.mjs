// Say so when a `Fixes #N` keyword — not a person — closed somebody else's
// issue. The repair half of the gate; the advice half is
// scripts/check-issue-close-keywords.mjs, wired into CI.
//
// WHY BOTH. The check fails a PR whose body would auto-close somebody else's
// issue, which is the right place to catch it — before the damage. But master
// carries no branch protection, so a red check is a signal, not a stop: the
// merge lands and the issue closes anyway. A keyword can also arrive in a
// commit message that never appeared in a PR body at all. So the check advises
// at PR time and this repairs after the fact, and neither relies on the other
// having worked.
//
// WHY A COMMENT AND NOT A REOPEN. Reopening every keyword-closed report would
// also reopen the ones that really are fixed, handing the reporter a chore to
// close what he is already happy with. What went wrong on #1244 was not the
// state, it was the silence: the close arrived with no explanation and read as
// a verdict on questions nobody had answered. So the close stands, and the
// issue says what closed it — the part that was missing.
//
// Rule: a human other than the repo owner filed it AND a pull request or
// commit is what closed it → one comment naming the closer and inviting them
// to reopen. A close by a person clicking the button — the reporter deciding
// it is done, the owner closing it deliberately — is left silent.
//
// The discriminator is GraphQL's `ClosedEvent.closer`: a PullRequest / Commit
// when a keyword did it, null when a human did. REST has no equivalent — on
// #1244 the `closed` event carries no `commit_id` and no `state_reason`, so
// the obvious REST reading returns the same answer for both cases.
//
// Inputs via env so it is trivially runnable by hand:
//   GITHUB_REPOSITORY  owner/repo
//   ISSUE_NUMBER       the issue that just closed
//   ISSUE_AUTHOR       who filed it
//   ISSUE_AUTHOR_TYPE  'User' or 'Bot'
//   GITHUB_TOKEN       needs issues:write to comment
//   DRY_RUN            any non-empty value reports and writes nothing
import { pathToFileURL } from 'node:url';

const WORKFLOW = '.github/workflows/keyword-close-notice.yml';

const CLOSER_QUERY = `
  query($owner:String!,$name:String!,$number:Int!){
    repository(owner:$owner,name:$name){
      issue(number:$number){
        timelineItems(last:1, itemTypes:[CLOSED_EVENT]){
          nodes{ ... on ClosedEvent { closer{
            __typename
            ... on PullRequest { number }
            ... on Commit { abbreviatedOid }
          } } }
        }
      }
    }
  }`;

/**
 * Whose closes we never comment on: the owner's own issues, and the drift
 * watchers' bot-filed alerts — those exist to be closed by automation and
 * nobody is waiting to read an explanation.
 * Exported for the unit test.
 */
export function isExempt(author, type, owner) {
  return type === 'Bot' || String(author).toLowerCase() === String(owner).toLowerCase();
}

/**
 * "PullRequest #1245" / "Commit abc1234" / null when a person clicked close.
 * Exported for the unit test.
 */
export function closerLabel(closer) {
  if (!closer) return null;
  if (closer.__typename === 'PullRequest') return `PullRequest #${closer.number}`;
  if (closer.__typename === 'Commit') return `Commit ${closer.abbreviatedOid}`;
  return closer.__typename;
}

/** Exported for the unit test — the words the reporter actually reads. */
export function commentBody({ author, number, closer, serverUrl, repo }) {
  return [
    `This closed because ${closer} carried a \`Fixes\`/\`Closes\` keyword pointing here, not because anyone decided the report was answered.`,
    `@${author} — if it does not read as fixed to you, reopen it and say what is still wrong. That is the right call to make, not a nuisance. Follow-up work links here with \`Addresses #${number}\`, which links without closing.`,
    `<sub>[\`${WORKFLOW}\`](${serverUrl}/${repo}/blob/master/${WORKFLOW})</sub>`,
  ].join('\n\n');
}

/** The live GitHub calls, in one object so the test can replace them. */
function restApi(env) {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'content-type': 'application/json',
    'user-agent': 'dario-close-notice',
  };
  const call = async (path, body, method = 'POST') => {
    const res = await fetch(`https://api.github.com${path}`, { method, headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    return res.json();
  };
  return {
    async closer({ owner, name, number }) {
      const out = await call('/graphql', { query: CLOSER_QUERY, variables: { owner, name, number } });
      if (out.errors) throw new Error(`graphql: ${JSON.stringify(out.errors)}`);
      return out.data?.repository?.issue?.timelineItems?.nodes?.[0]?.closer ?? null;
    },
    comment: (repo, number, body) => call(`/repos/${repo}/issues/${number}/comments`, { body }),
  };
}

export async function main(env = process.env, api = restApi(env)) {
  const repo = env.GITHUB_REPOSITORY || '';
  const [owner, name] = repo.split('/');
  const number = Number(env.ISSUE_NUMBER);
  const author = env.ISSUE_AUTHOR || '';

  if (isExempt(author, env.ISSUE_AUTHOR_TYPE, owner)) {
    console.log(`#${number} was filed by ${author} — exempt, nothing to do.`);
    return 0;
  }

  const closer = closerLabel(await api.closer({ owner, name, number }));
  if (closer === null) {
    console.log(`#${number} was closed by a person, not by a keyword — nothing to explain.`);
    return 0;
  }

  console.log(`#${number} (filed by @${author}) was closed by ${closer} — leaving it closed, saying why.`);
  if (env.DRY_RUN) {
    console.log('DRY_RUN set — no write performed.');
    return 0;
  }
  await api.comment(repo, number, commentBody({
    author, number, closer, serverUrl: env.GITHUB_SERVER_URL || 'https://github.com', repo,
  }));
  return 0;
}

// Run when invoked directly; importable (for the test) without side effects.
// Compared as URLs, not by basename — the unit test file shares this name.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
