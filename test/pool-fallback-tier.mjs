import { selectPoolFallbackModels } from '../dist/pool-fallback-tier.js';

let failures = 0;
function check(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures++;
    console.error(`FAIL ${name}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  } else console.log(`PASS ${name}`);
}

const tiers = 'haiku:gpt-5.4-mini,sonnet:gpt-5.6-terra,opus:gpt-5.6-sol';
check('haiku selects economical rung', selectPoolFallbackModels(tiers, 'claude-haiku-4-5'), ['gpt-5.4-mini']);
check('sonnet selects middle rung', selectPoolFallbackModels(tiers, 'claude-sonnet-5'), ['gpt-5.6-terra']);
check('opus selects top rung', selectPoolFallbackModels(tiers, 'claude-opus-5'), ['gpt-5.6-sol']);
check('unknown selects first configured default', selectPoolFallbackModels(tiers, 'vendor-unknown'), ['gpt-5.4-mini']);
check('explicit default wins for unknown', selectPoolFallbackModels('default:gpt-5.5,haiku:gpt-5.4-mini', 'vendor-unknown'), ['gpt-5.5']);
check('legacy single value remains unchanged', selectPoolFallbackModels('gpt-5.6-terra', 'claude-haiku-4-5'), ['gpt-5.6-terra']);
check('legacy chain remains unchanged', selectPoolFallbackModels('gpt-5.6-terra,claude-sonnet-5', 'claude-opus-5'), ['gpt-5.6-terra', 'claude-sonnet-5']);
check('provider-prefixed legacy single value remains unchanged', selectPoolFallbackModels('claude:opus:high', 'claude-haiku-4-5'), ['claude:opus:high']);
check('provider-prefixed legacy chain remains unchanged', selectPoolFallbackModels('claude:opus:high,openai:gpt-5.6', 'claude-haiku-4-5'), ['claude:opus:high', 'openai:gpt-5.6']);

// dario#1272 — codex-drift-watch reported the account-visible list as
// gpt-5.5 / gpt-5.6-luna / gpt-5.6-sol / gpt-5.6-terra / gpt-reserve. `luna` is
// the third rung of the sol > terra > luna ladder and matched none of the tier
// tests, so a request naming it fell through to `default` and, with no
// `default:` entry, to whichever tier happened to be written first — arbitrary,
// and silent.
// Deliberately written OPUS-FIRST. With the haiku rung listed first, an
// unclassified luna falls through to the first entry and lands on the haiku
// target anyway — the right answer for the wrong reason, so the assertion
// would pass against the very bug it is meant to catch. Opus-first makes the
// fallthrough land somewhere visibly wrong.
const ladder = 'opus:gpt-5.6-sol,sonnet:gpt-5.6-terra,haiku:gpt-5.6-luna';
check('luna reads as the economical rung', selectPoolFallbackModels(ladder, 'gpt-5.6-luna'), ['gpt-5.6-luna']);
check('luna is not mistaken for the middle rung', selectPoolFallbackModels(ladder, 'gpt-5.6-terra'), ['gpt-5.6-terra']);
check('luna is not mistaken for the top rung', selectPoolFallbackModels(ladder, 'gpt-5.6-sol'), ['gpt-5.6-sol']);
// A genuinely unclassifiable slug keeps the documented first-entry behaviour.
check('an unknown codex slug still falls to the first tier',
  selectPoolFallbackModels(ladder, 'gpt-reserve'), ['gpt-5.6-sol']);

if (failures) process.exit(1);
