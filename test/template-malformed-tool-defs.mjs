#!/usr/bin/env node
/**
 * A bundled tool definition the API would refuse is never advertised (dario#1376).
 *
 * The 2026-09-18T01:26Z rebake recorded `advisor` as
 * `{"name":"advisor","description":"","input_schema":{}}`. Fable refuses any
 * request that carries it (`tools.0.custom.input_schema.type: Field
 * required`); the reporter hit it with `tools: []`, because Fable's
 * zero-tools shape advertises the whole bundled array. Properties:
 *
 *   1. CC_TOOL_DEFINITIONS / _UNION contain only definitions with a string
 *      input_schema.type; the malformed names are listed separately.
 *   2. The name stays KNOWN: CC_NATIVE_NAMES_UNION and CONFIG_SCOPED_TOOLS
 *      still carry it, so a client declaring it identity-maps (no round-robin
 *      renaming — the v4.8.93 failure this bundle invariant guards).
 *   3. Every outbound tools array buildCCRequest produces — Fable zero-tools,
 *      merge-tools, the intersection path — is free of malformed definitions.
 *   4. A client that declares the tool with its own schema gets THAT schema on
 *      the wire, exactly once.
 *
 * In-process — no proxy / OAuth / upstream.
 */
import {
  buildCCRequest, isAdvertisableToolDefinition, CC_TOOL_DEFINITIONS, CC_TOOL_DEFINITIONS_UNION,
  CC_TOOL_DEFINITIONS_UNADVERTISABLE, CC_NATIVE_NAMES_UNION, CONFIG_SCOPED_TOOLS, CC_TEMPLATE,
} from '../dist/cc-template.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ' :: ' + String(detail).slice(0, 400) : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);
const malformed = (tools) => (tools || []).filter((t) => !isAdvertisableToolDefinition(t)).map((t) => t.name);

header('predicate');
{
  check('a real definition is advertisable', isAdvertisableToolDefinition({ name: 'Read', description: 'r', input_schema: { type: 'object', properties: {} } }));
  check('an empty schema is not', !isAdvertisableToolDefinition({ name: 'advisor', description: '', input_schema: {} }));
  check('a missing schema is not', !isAdvertisableToolDefinition({ name: 'x', description: '' }));
  check('a non-string type is not', !isAdvertisableToolDefinition({ name: 'x', input_schema: { type: 7 } }));
  check('garbage is not', !isAdvertisableToolDefinition(null) && !isAdvertisableToolDefinition('advisor'));
}

header('the bundle: advertised arrays are clean, names stay known');
{
  check('CC_TOOL_DEFINITIONS has no malformed definition', malformed(CC_TOOL_DEFINITIONS).length === 0, malformed(CC_TOOL_DEFINITIONS));
  check('CC_TOOL_DEFINITIONS_UNION has no malformed definition', malformed(CC_TOOL_DEFINITIONS_UNION).length === 0, malformed(CC_TOOL_DEFINITIONS_UNION));
  const rawMalformed = malformed(CC_TEMPLATE.tools);
  check('UNADVERTISABLE lists exactly the bundle\'s malformed names', [...CC_TOOL_DEFINITIONS_UNADVERTISABLE].sort().join(',') === rawMalformed.sort().join(','), { set: [...CC_TOOL_DEFINITIONS_UNADVERTISABLE], rawMalformed });
  for (const name of CC_TOOL_DEFINITIONS_UNADVERTISABLE) {
    check(`${name}: still a known native name`, CC_NATIVE_NAMES_UNION.has(name));
    check(`${name}: not in the advertised union`, !CC_TOOL_DEFINITIONS_UNION.some((t) => t.name === name));
  }
  // The bundle under test today carries the malformed advisor; if a future
  // bake records the real schema this becomes a no-op rather than a failure.
  if (CC_TEMPLATE.tools.some((t) => t.name === 'advisor')) {
    const adv = CC_TEMPLATE.tools.find((t) => t.name === 'advisor');
    console.log(`  (bundle advisor: ${JSON.stringify(adv).slice(0, 80)} → advertisable=${isAdvertisableToolDefinition(adv)})`);
    check('advisor is config-scoped either way', CONFIG_SCOPED_TOOLS.has('advisor'));
  }
}

const identity = { deviceId: 'dev', accountUuid: 'acct', sessionId: 'sess' };
const cache = { type: 'ephemeral' };
const build = (body, opts) => buildCCRequest(body, 'tag', cache, identity, opts).body;

header('Fable, tools: [] — the zero-tools shape (dario#1376\'s reproduction)');
{
  const out = build({ model: 'claude-fable-5', max_tokens: 64, tools: [], messages: [{ role: 'user', content: '你好' }] });
  check('advertises the CC base array', Array.isArray(out.tools) && out.tools.length > 0, out.tools?.length);
  check('pinned with tool_choice none', out.tool_choice?.type === 'none', out.tool_choice);
  check('no definition without input_schema.type', malformed(out.tools).length === 0, malformed(out.tools));
  check('tools[0] in particular is well-formed', typeof out.tools?.[0]?.input_schema?.type === 'string', out.tools?.[0]);
}

header('Fable, no tools key at all');
{
  const out = build({ model: 'claude-fable-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  check('no malformed definition', malformed(out.tools).length === 0, malformed(out.tools));
}

header('merge-tools: base array + client extras, clean');
{
  const out = build({ model: 'claude-sonnet-5', max_tokens: 64, tools: [{ name: 'my_tool', description: 'd', input_schema: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: 'hi' }] }, { mergeTools: true });
  check('client tool appended', out.tools.some((t) => t.name === 'my_tool'));
  check('no malformed definition', malformed(out.tools).length === 0, malformed(out.tools));
}

header('a client that declares the unadvertisable tool with its own schema');
{
  const own = { name: 'advisor', description: 'Ask an advisor', input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } };
  const out = build({ model: 'claude-sonnet-5', max_tokens: 64, tools: [own, { name: 'Read', description: 'r', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }], messages: [{ role: 'user', content: 'hi' }] });
  const names = out.tools.map((t) => t.name);
  const advisorOut = out.tools.filter((t) => t.name === 'advisor');
  if (CC_TOOL_DEFINITIONS_UNADVERTISABLE.has('advisor')) {
    check('advisor goes out exactly once', advisorOut.length === 1, names);
    check('…with the CLIENT\'s schema, since the bundle\'s is unusable', advisorOut[0]?.input_schema?.required?.[0] === 'question', advisorOut[0]);
  } else {
    check('advisor goes out exactly once (bundle definition, now valid)', advisorOut.length === 1, names);
  }
  check('Read still comes from the bundle', out.tools.some((t) => t.name === 'Read' && t.description !== 'r'), out.tools.find((t) => t.name === 'Read')?.description?.slice(0, 40));
  check('nothing malformed', malformed(out.tools).length === 0, malformed(out.tools));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
