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

if (failures) process.exit(1);
