#!/usr/bin/env node
// dario#1363 — recognising Claude Desktop's third-party inference mode.
//
// Desktop's Developer → Configure Third-Party Inference → Gateway mode runs
// Claude Code inside the app under the entrypoint `claude-desktop-3p`. A
// gateway sees that name in the billing line at system[0] and in the
// user-agent. The proxy refuses the mode on a plan login, so the detector has
// to catch it from either signal and must not catch Claude Code, the Agent
// SDK or the app's own Code tab, which use other entrypoints.
//
// Proxy-free: imports the detector and reads the docs the refusal points at.
// The end-to-end half (a real proxy refusing it) is test/desktop-gateway-refusal.mjs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDesktopGatewayRequest, isGenuineCCClient } from '../dist/cc-template.js';
import { DESKTOP_GATEWAY_ON_PLAN, DESKTOP_GATEWAY_ON_PLAN_MESSAGE } from '../dist/upstream-rejection.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const body = (entrypoint, identity) => ({
  model: 'claude-sonnet-5', max_tokens: 16,
  system: [
    { type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.281.721; cc_entrypoint=${entrypoint};` },
    { type: 'text', text: identity },
  ],
  messages: [{ role: 'user', content: 'ping' }],
});
const SDK_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const CLI_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const DESKTOP_UA = 'claude-cli/2.1.284 (external, claude-desktop-3p, agent-sdk/0.3.284)';
const desktop = body('claude-desktop-3p', SDK_IDENTITY);

header('the mode is recognised from either signal');
check('billing line and user-agent together', isDesktopGatewayRequest(desktop, DESKTOP_UA));
check('billing line alone (a hop replaced the user-agent)', isDesktopGatewayRequest(desktop, 'node'));
check('billing line alone, no user-agent at all', isDesktopGatewayRequest(desktop, undefined));
check('user-agent alone, body has no system', isDesktopGatewayRequest({ model: 'claude-sonnet-5', messages: [] }, DESKTOP_UA));
check('user-agent alone, system is a plain string', isDesktopGatewayRequest({ system: 'be brief' }, DESKTOP_UA));
check('user-agent alone, body did not parse', isDesktopGatewayRequest(null, DESKTOP_UA));
check('a repeated user-agent header (array)', isDesktopGatewayRequest(null, ['curl/8', DESKTOP_UA]));
check('the entrypoint as the last field, no trailing semicolon',
  isDesktopGatewayRequest({ system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.300.abc; cc_entrypoint=claude-desktop-3p' }] }, undefined));
check('a later Desktop build with a different version string',
  isDesktopGatewayRequest(null, 'claude-cli/2.2.0 (external, claude-desktop-3p, agent-sdk/0.4.0)'));

header('everything else is left alone');
check('Claude Code, cli entrypoint', !isDesktopGatewayRequest(body('cli', CLI_IDENTITY), 'claude-cli/2.1.280 (external, cli)'));
check('the Agent SDK, sdk-cli entrypoint', !isDesktopGatewayRequest(body('sdk-cli', SDK_IDENTITY), 'claude-cli/2.1.280 (external, sdk-cli)'));
check('the Agent SDK, sdk-ts entrypoint', !isDesktopGatewayRequest(body('sdk-ts', SDK_IDENTITY), 'claude-cli/2.1.280 (external, sdk-ts, agent-sdk/0.3.280)'));
check("Desktop's own Code tab, claude-desktop entrypoint",
  !isDesktopGatewayRequest(body('claude-desktop', CLI_IDENTITY), 'claude-cli/2.1.284 (external, claude-desktop)'));
check('a longer entrypoint that only starts the same way',
  !isDesktopGatewayRequest(body('claude-desktop-3p-next', SDK_IDENTITY), 'claude-cli/2.1.284 (external, claude-desktop-3p-next)'));
check('the name in a user message, not in the billing line',
  !isDesktopGatewayRequest({ ...body('cli', CLI_IDENTITY), messages: [{ role: 'user', content: 'what is cc_entrypoint=claude-desktop-3p;' }] }, 'claude-cli/2.1.280 (external, cli)'));
check('the name in system[1], not in the billing line',
  !isDesktopGatewayRequest({ system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_entrypoint=cli;' }, { type: 'text', text: 'cc_entrypoint=claude-desktop-3p;' }] }, undefined));
check('system[0] names the entrypoint but is not a billing line',
  !isDesktopGatewayRequest({ system: [{ type: 'text', text: 'notes: cc_entrypoint=claude-desktop-3p;' }] }, undefined));
check('a plain API client', !isDesktopGatewayRequest({ model: 'claude-sonnet-5', messages: [] }, 'anthropic-sdk-python/0.60.0'));
check('no body, no user-agent', !isDesktopGatewayRequest(null, undefined));
check('undefined body', !isDesktopGatewayRequest(undefined, undefined));

header('why the refusal is needed: the body passes as Claude Code');
check('isGenuineCCClient accepts the Desktop body', isGenuineCCClient(desktop) === true);

header('the refusal names itself and the page that explains it');
check('marker', DESKTOP_GATEWAY_ON_PLAN === 'desktop_gateway_on_plan', DESKTOP_GATEWAY_ON_PLAN);
check('message names the mode', DESKTOP_GATEWAY_ON_PLAN_MESSAGE.includes("Claude Desktop's third-party inference mode"));
check('message names the API-key mode', DESKTOP_GATEWAY_ON_PLAN_MESSAGE.includes('ANTHROPIC_UPSTREAM_API_KEY'));
check('message links docs/account-risk.md', DESKTOP_GATEWAY_ON_PLAN_MESSAGE.includes('https://github.com/askalf/dario/blob/master/docs/account-risk.md'));

const risk = readFileSync(join(root, 'docs', 'account-risk.md'), 'utf8');
const matrix = readFileSync(join(root, 'docs', 'integrations', 'compat-matrix.md'), 'utf8');
const ANCHOR = '#claude-desktops-third-party-inference-mode';
check('account-risk.md has the section the links point at', /^## Claude Desktop's third-party inference mode$/m.test(risk));
check('account-risk.md says it is refused on a plan login', risk.includes('dario refuses it on a plan login'));
const row = matrix.split('\n').find((l) => l.startsWith('| **Claude Desktop**')) ?? '';
check('the compatibility table has one Claude Desktop row', matrix.split('\n').filter((l) => l.startsWith('| **Claude Desktop**')).length === 1);
check('the row says refused on a plan login', row.includes('Refused on a plan login'), row.slice(0, 120));
check('the row no longer says it should work', !/should work/i.test(row));
check('the row names the marker the proxy sends', row.includes(DESKTOP_GATEWAY_ON_PLAN));
check('the row links the section', row.includes(`(../account-risk.md${ANCHOR})`));
check('the legend explains the status', /^- \*\*🔴 Refused\*\*/m.test(matrix));

header('the proxy acts on it before a seat is picked, and not in API-key mode');
const proxy = readFileSync(join(root, 'src', 'proxy.ts'), 'utf8');
const guard = proxy.indexOf('if (desktopGateway && !upstreamApiKey) {');
const select = proxy.indexOf('if (!selectPoolAccount()) return;');
const detect = proxy.indexOf("const desktopGateway = isDesktopGatewayRequest(parsedBody, req.headers['user-agent']);");
check('the request is classified once, from the body as it arrived', detect > 0 && proxy.split('isDesktopGatewayRequest(').length - 1 === 1);
check('the guard exists and exempts upstream API-key mode', guard > 0);
check('classification comes before the guard', detect > 0 && detect < guard);
check('the guard comes before seat selection', guard > 0 && select > 0 && guard < select);
const block = guard > 0 ? proxy.slice(guard, proxy.indexOf('\n      }\n', guard)) : '';
check('the guard answers 403 with the marker', block.includes('res.writeHead(403') && block.includes("'x-dario-upstream-rejection': DESKTOP_GATEWAY_ON_PLAN"));
check('the guard returns without calling upstream', /\n\s+return;\s*$/.test(block) && !block.includes('fetch'));
check('the guard does not look at --passthrough', !block.includes('passthrough'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
