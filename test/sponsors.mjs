#!/usr/bin/env node
// Tests for scripts/sponsors.mjs — the renderers behind the release-notes
// thank-you and the README block, and the fetch's handling of the API.
// Pure: fixtures in, markdown out; the one network path takes a fetchImpl.

import { normalizeSponsors, renderThanks, renderReadmeBlock, replaceReadmeBlock, fetchSponsors, README_START, README_END, README_TIER_MIN_USD }
  from '../scripts/sponsors.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const node = (login, monthly, extra = {}) => ({
  isOneTimePayment: false,
  tier: { monthlyPriceInDollars: monthly, isOneTime: false },
  sponsorEntity: { __typename: 'User', login, name: null },
  ...extra,
});

header('normalizeSponsors: stable order, junk dropped');
{
  const s = normalizeSponsors([
    node('zed', 5), node('amy', 100, { sponsorEntity: { __typename: 'Organization', login: 'amy', name: 'Amy Corp' } }),
    node('bob', 25), node('cat', 25),
    { isOneTimePayment: true, tier: { monthlyPriceInDollars: 50, isOneTime: true }, sponsorEntity: { __typename: 'User', login: 'dan', name: '  ' } },
    { sponsorEntity: null }, { sponsorEntity: { __typename: 'User' } }, null,
  ]);
  check('highest tier first, then login; deleted / nameless entities dropped', s.map((x) => x.login).join(',') === 'amy,dan,bob,cat,zed', s.map((x) => x.login).join(','));
  check('org name kept, blank name is null, one-time flagged', s[0].name === 'Amy Corp' && s[1].name === null && s[1].oneTime === true && s[2].oneTime === false);
  check('empty input → empty list', normalizeSponsors(undefined).length === 0 && normalizeSponsors([]).length === 0);
}

header('renderThanks: the release-notes line');
{
  check('nobody → empty string (the workflow appends unconditionally)', renderThanks([]) === '');
  const one = renderThanks(normalizeSponsors([node('amy', 5)]));
  check('one sponsor', one === '**Thanks to the sponsors behind this release:** [@amy](https://github.com/amy). [Sponsor dario](https://github.com/sponsors/askalf).\n', one);
  const two = renderThanks(normalizeSponsors([node('amy', 5), node('bob', 5)]));
  check('two sponsors: "and"', two.includes('[@amy](https://github.com/amy) and [@bob](https://github.com/bob).'), two);
  const three = renderThanks(normalizeSponsors([node('amy', 5), node('bob', 5), node('cat', 5)]));
  check('three: Oxford comma', three.includes('[@amy](https://github.com/amy), [@bob](https://github.com/bob), and [@cat](https://github.com/cat).'), three);
  check('one-time sponsors are thanked too', renderThanks(normalizeSponsors([node('dan', 50, { isOneTimePayment: true })])).includes('@dan'));
}

header('renderReadmeBlock: the $25+ monthly tiers, wrapped in markers');
{
  const empty = renderReadmeBlock([]);
  check('no sponsors → the pointer sentence, inside the markers', empty.startsWith(README_START) && empty.endsWith(README_END) && empty.includes(`Sponsors at $${README_TIER_MIN_USD}/month and up are listed here`), empty);
  const block = renderReadmeBlock(normalizeSponsors([
    node('amy', 100, { sponsorEntity: { __typename: 'Organization', login: 'amy', name: 'Amy Corp' } }),
    node('bob', 25), node('zed', 5),
    node('dan', 50, { isOneTimePayment: true }),
  ]));
  check('$100 and $25 listed, highest first, with the name when there is one', block.includes('- [@amy](https://github.com/amy) — Amy Corp\n- [@bob](https://github.com/bob)'), block);
  check('the $5 tier and a one-time $50 are not listed (the tier promised no README line)', !block.includes('@zed') && !block.includes('@dan'), block);
  check('markers on both ends', block.startsWith(README_START) && block.endsWith(README_END));
}

header('replaceReadmeBlock');
{
  const readme = `# dario\n\nintro\n\n### Sponsors\n\n${README_START}\nold\n${README_END}\n\n## License\n`;
  const out = replaceReadmeBlock(readme, renderReadmeBlock([]));
  check('replaces exactly the marked block, leaves the rest', out.startsWith('# dario\n\nintro\n\n### Sponsors\n\n') && out.endsWith('\n\n## License\n') && !out.includes('\nold\n') && out.includes('Sponsors at $'), out);
  check('idempotent', replaceReadmeBlock(out, renderReadmeBlock([])) === out);
  let threw = false;
  try { replaceReadmeBlock('# no markers here', renderReadmeBlock([])); } catch { threw = true; }
  check('missing markers throw (never append blindly)', threw);
}

header('fetchSponsors: token, shape, failure');
{
  process.env.GH_TOKEN = 'test-token';
  const calls = [];
  const okFetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ data: { user: { sponsorshipsAsMaintainer: { nodes: [node('amy', 25)] } } } }), { status: 200 }); };
  const got = await fetchSponsors('askalf', okFetch);
  const body = JSON.parse(calls[0].init.body);
  check('POSTs the GraphQL query with the bearer token, public-only', calls[0].url === 'https://api.github.com/graphql' && calls[0].init.headers.authorization === 'bearer test-token' && body.variables.login === 'askalf' && body.query.includes('includePrivate: false') && body.query.includes('activeOnly: true'));
  check('normalised result', got.length === 1 && got[0].login === 'amy' && got[0].monthly === 25);
  let err = null;
  try { await fetchSponsors('askalf', async () => new Response('nope', { status: 502 })); } catch (e) { err = e.message; }
  check('HTTP failure throws (the caller decides: release = swallow, --write = fail)', err === 'GraphQL HTTP 502', err);
  err = null;
  try { await fetchSponsors('askalf', async () => new Response(JSON.stringify({ errors: [{ message: 'x' }] }), { status: 200 })); } catch (e) { err = e.message; }
  check('an unexpected shape throws rather than reading as "no sponsors"', err && err.startsWith('unexpected GraphQL shape'), err);
  delete process.env.GH_TOKEN;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
