#!/usr/bin/env node
/**
 * Genuine-CC byte-faithful passthrough (dario#678 follow-up).
 *
 * A real Claude Code client's request already IS the CC wire shape. The
 * template pipeline used to prepend dario's ~25KB template prompt to the
 * client's own CC system prompt (re-billed per request shape per cache
 * window — the residual +5%-vs-direct in the #678 re-test), substitute
 * template tool defs for the client's own, truncate/scrub its content, and
 * round-robin natives the `--print` template capture never sees
 * (AskUserQuestion, plan-mode tools). Passthrough forwards system + tools +
 * messages verbatim; dario keeps only its billing tag, its metadata
 * identity, and deterministic cache breakpoints.
 *
 * In-process — no proxy / OAuth / upstream.
 */

import { buildCCRequest, applyCcPromptCaching, isGenuineCCClient, CC_SYSTEM_PROMPT } from '../dist/cc-template.js';

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
}
function header(name) { console.log(`\n${'='.repeat(70)}\n  ${name}\n${'='.repeat(70)}`); }

const billingTag = 'x-anthropic-billing-header: cc_version=9.9.9; cc_entrypoint=sdk-cli;';
const cache = { type: 'ephemeral' };
const identity = { deviceId: 'dario-dev', accountUuid: 'dario-acct', sessionId: 'dario-sess' };

const CLIENT_IDENTITY = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
const CLIENT_PROMPT = 'CLIENT-VERSION system prompt — newer than any template. '.repeat(50);
const BIG_RESULT = 'x'.repeat(40_000);

function ccClientBody() {
  return {
    model: 'claude-opus-4-8',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read every file — mention Continue and Cline verbatim' }, { type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'client thinking block, replayed by CC on purpose', signature: 'sig' },
          { type: 'tool_use', id: 'tu_1', name: 'AskUserQuestion', input: { questions: [{ question: 'which dir?' }] } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: BIG_RESULT, extra_client_field: 1 }] },
    ],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.202.abc; cc_entrypoint=sdk-cli; ' },
      { type: 'text', text: CLIENT_IDENTITY, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: CLIENT_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    tools: [
      { name: 'Read', description: 'CLIENT-VERSION Read def', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } },
      { name: 'AskUserQuestion', description: 'interactive-only native absent from --print captures', input_schema: { type: 'object', properties: { questions: { type: 'array' } } } },
      { name: 'mcp__srv__ping', description: 'client mcp def', input_schema: { type: 'object' } },
    ],
    metadata: { user_id: 'client-identity-should-be-replaced' },
    max_tokens: 64000,
    thinking: { type: 'adaptive', display: 'omitted' },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    output_config: { effort: 'xhigh' },
    stream: true,
  };
}

header('isGenuineCCClient — the billing-block discriminator');
{
  check('CC-shaped body detected', isGenuineCCClient(ccClientBody()));
  check('string system → not CC', !isGenuineCCClient({ system: 'plain prompt' }));
  check('array system without billing block → not CC',
    !isGenuineCCClient({ system: [{ type: 'text', text: 'You are a bot' }, { type: 'text', text: 'rules' }] }));
  check('single-block system → not CC',
    !isGenuineCCClient({ system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' }] }));
  check('billing block + non-CC identity → not CC (replayed-tag Kilo shape)',
    !isGenuineCCClient({ system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' },
      { type: 'text', text: 'You are Kilo Code, an open-source coding agent.' },
    ] }));
  check('Agent SDK identity variant detected', isGenuineCCClient({ system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=1;' },
    { type: 'text', text: 'You are a Claude agent, built on Anthropic\'s Claude Agent SDK.' },
  ] }));
}

header('passthrough — system verbatim, dario billing tag, deterministic stamps');
{
  const { body, toolMap, unmappedTools, genuineCC } = buildCCRequest(ccClientBody(), billingTag, cache, identity, {});
  check('genuineCC flag set', genuineCC === true);
  check('toolMap empty (identity — no reverse rewriting)', toolMap.size === 0);
  check('no unmapped tools (nothing round-robined)', unmappedTools.length === 0);
  const sys = body.system;
  check('system block count preserved', Array.isArray(sys) && sys.length === 3);
  check('system[0] = dario billing tag (client tag replaced)', sys[0].text === billingTag && !sys[0].cache_control);
  check('system[1] text VERBATIM client identity', sys[1].text === CLIENT_IDENTITY);
  check('system[2] text VERBATIM client prompt (no template prepend)', sys[2].text === CLIENT_PROMPT);
  check('template prompt NOT present anywhere', !JSON.stringify(sys).includes(CC_SYSTEM_PROMPT.slice(0, 60)));
  check('system[1] + system[2] stamped plain ephemeral', sys[1].cache_control?.type === 'ephemeral' && sys[2].cache_control?.type === 'ephemeral');
  check('client ttl stripped (budget-normalized restamp)', sys[2].cache_control.ttl === undefined);
}

header('passthrough — tools + messages verbatim');
{
  const { body } = buildCCRequest(ccClientBody(), billingTag, cache, identity, {});
  const names = body.tools.map((t) => t.name);
  check('client tool set forwarded exactly', names.join(',') === 'Read,AskUserQuestion,mcp__srv__ping');
  check('client Read def kept (no template substitution)', body.tools[0].description === 'CLIENT-VERSION Read def');
  check('AskUserQuestion advertised (no --print capture gap)', names.includes('AskUserQuestion'));
  const asst = body.messages[1];
  check('thinking block in history KEPT (CC replays them on purpose)', asst.content[0].type === 'thinking');
  check('tool_use name untouched', asst.content[1].name === 'AskUserQuestion');
  const result = body.messages[2].content[0];
  check('40KB tool_result NOT truncated', result.content.length === BIG_RESULT.length);
  check('client-specific tool_result fields kept', result.extra_client_field === 1);
  check('message text NOT scrubbed (Continue/Cline survive)', body.messages[0].content[0].text.includes('Continue') && body.messages[0].content[0].text.includes('Cline'));
  check('client message cache_control stripped', body.messages[0].content[1].cache_control === undefined);
}

header('passthrough — top-level fields are the client\'s, identity is dario\'s');
{
  const client = ccClientBody();
  const { body } = buildCCRequest(client, billingTag, cache, identity, {});
  check('model forwarded', body.model === 'claude-opus-4-8');
  check('max_tokens forwarded', body.max_tokens === 64000);
  check('thinking forwarded verbatim', JSON.stringify(body.thinking) === JSON.stringify(client.thinking));
  check('output_config.effort forwarded (client knob)', body.output_config.effort === 'xhigh');
  check('stream forwarded', body.stream === true);
  const uid = JSON.parse(body.metadata.user_id);
  check('metadata.user_id = dario identity (OAuth account is dario\'s)',
    uid.device_id === 'dario-dev' && uid.account_uuid === 'dario-acct' && uid.session_id === 'dario-sess');
  check('top-level key order preserved (client order + system in place)',
    Object.keys(body).join(',') === Object.keys(client).join(','));
}

header('passthrough outranks tool-mode flags (they exist for NON-CC clients)');
{
  const { body, genuineCC } = buildCCRequest(ccClientBody(), billingTag, cache, identity, { hybridTools: true });
  check('hybridTools ignored for genuine CC', genuineCC === true && body.tools[0].description === 'CLIENT-VERSION Read def');
  const merged = buildCCRequest(ccClientBody(), billingTag, cache, identity, { mergeTools: true });
  check('mergeTools ignored for genuine CC', merged.genuineCC === true && merged.body.tools.length === 3);
}

header('passthrough + applyCcPromptCaching — 4-breakpoint budget holds');
{
  const { body } = buildCCRequest(ccClientBody(), billingTag, cache, identity, {});
  applyCcPromptCaching(body, cache);
  const hasCC = (o) => !!(o && o.cache_control);
  const sysBp = body.system.filter(hasCC).length;
  const toolBp = body.tools.filter(hasCC).length;
  const msgBp = body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter(hasCC).length;
  check('2 system breakpoints', sysBp === 2);
  check('0 tool breakpoints', toolBp === 0);
  check('2 conversation breakpoints (rolling + anchor)', msgBp === 2);
  check('total = 4 (Anthropic max)', sysBp + toolBp + msgBp === 4);
}

header('non-CC clients keep the template pipeline');
{
  const nonCC = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    system: 'You are a helpful bot.',
    tools: [{ name: 'Read', description: 'x', input_schema: { type: 'object' } }],
  };
  const { body, genuineCC } = buildCCRequest(nonCC, billingTag, cache, identity, {});
  check('genuineCC not set', !genuineCC);
  check('template system injected (3 blocks)', Array.isArray(body.system) && body.system.length === 3);
  check('template prompt present', body.system[2].text.includes(CC_SYSTEM_PROMPT.slice(0, 60)));
}

console.log(`\ncc-passthrough: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
