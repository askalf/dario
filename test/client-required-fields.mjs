#!/usr/bin/env node
// A Claude Code tool is mapped back to the same name, so the client reads the
// model's call against its own declaration. The advertised definition is the
// bundled one; a field the client's declaration requires has to stay required
// on it, or the model may leave out a field the client then rejects the call
// for. ToolSearch is the case: Claude Code 2.1.332 made max_results optional,
// older clients still require it.

import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The checks below are about the bundled template, so the live cache must not
// be read even when this file runs on its own: cc-template loads at import
// time, so the path is set to one that does not exist before the import.
process.env.DARIO_LIVE_TEMPLATE_CACHE = join(tmpdir(), `dario-client-required-fields-${process.pid}`, 'absent.json');

const { buildCCRequest, reverseMapResponse, withClientRequiredFields, CC_TOOL_DEFINITIONS_UNION } = await import('../dist/cc-template.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? ` :: ${detail}` : ''}`); }
}

const billingTag = 'x-anthropic-billing-header: cc_version=9.9.9; cc_entrypoint=sdk-cli;';
const cache = { type: 'ephemeral' };
const identity = { deviceId: 'dario-dev', accountUuid: 'dario-acct', sessionId: 'dario-sess' };

const bundled = CC_TOOL_DEFINITIONS_UNION.find((t) => t.name === 'ToolSearch');
const bundledRequired = JSON.stringify(bundled?.input_schema?.required);
const toolSearch = (required) => ({
  name: 'ToolSearch',
  description: 'search deferred tools',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' }, max_results: { type: 'number' } },
    required,
    additionalProperties: false,
  },
});
const bash = { name: 'Bash', description: 'run', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } };
const request = (tools) => ({
  model: 'claude-sonnet-5',
  system: 'You are a coding agent.',
  messages: [{ role: 'user', content: 'find a tool' }],
  tools,
});
const advertised = (built, name) => (built.body.tools ?? []).find((t) => t.name === name);

check('the bundled template is loaded, not a live capture', bundled !== undefined && !bundled.input_schema.required.includes('max_results'), JSON.stringify(bundled?.input_schema?.required));
check('the bundle defines ToolSearch with max_results', !!bundled?.input_schema?.properties?.max_results, JSON.stringify(bundled?.input_schema));

console.log('\n  buildCCRequest, default mode');
{
  const built = buildCCRequest(request([toolSearch(['query', 'max_results']), bash]), billingTag, cache, identity, {});
  const out = advertised(built, 'ToolSearch');
  check('older form: ToolSearch is advertised', !!out);
  check('older form: max_results stays required', out?.input_schema?.required?.includes('max_results'), JSON.stringify(out?.input_schema?.required));
  check('older form: query stays required', out?.input_schema?.required?.includes('query'), JSON.stringify(out?.input_schema?.required));
  check('older form: the rest of the bundled definition is kept',
    out?.description === bundled.description
    && JSON.stringify(out?.input_schema?.properties) === JSON.stringify(bundled.input_schema.properties), out?.description);
  check('older form: the bundled definition is not mutated', JSON.stringify(bundled.input_schema.required) === bundledRequired, JSON.stringify(bundled.input_schema.required));
  check('older form: the call maps back unchanged', built.toolMap.get('ToolSearch')?.ccTool === 'ToolSearch');
  const input = { query: 'select:Read', max_results: 3 };
  const response = JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'ToolSearch', input }] });
  const back = JSON.parse(reverseMapResponse(response, built.toolMap)).content[0];
  check('older form: the returned call keeps its name', back.name === 'ToolSearch', back.name);
  check('older form: the returned call keeps max_results and query as sent',
    JSON.stringify(back.input) === JSON.stringify(input), JSON.stringify(back.input));
}
{
  const built = buildCCRequest(request([toolSearch(['query']), bash]), billingTag, cache, identity, {});
  const out = advertised(built, 'ToolSearch');
  check('newer form: the bundled definition goes out as is', out === bundled, JSON.stringify(out?.input_schema?.required));
  check('newer form: max_results stays optional', !out?.input_schema?.required?.includes('max_results'), JSON.stringify(out?.input_schema?.required));
}
{
  const built = buildCCRequest(request([{ ...toolSearch(['query']), input_schema: { type: 'object', properties: { query: { type: 'string' } } } }, bash]), billingTag, cache, identity, {});
  const out = advertised(built, 'ToolSearch');
  check('no client required list: the bundled definition goes out as is', out === bundled);
}

console.log('\n  buildCCRequest, merge mode');
{
  const built = buildCCRequest(request([toolSearch(['query', 'max_results']), bash]), billingTag, cache, identity, { mergeTools: true });
  const out = advertised(built, 'ToolSearch');
  check('older form: max_results stays required', out?.input_schema?.required?.includes('max_results'), JSON.stringify(out?.input_schema?.required));
}
{
  const built = buildCCRequest(request([toolSearch(['query']), bash]), billingTag, cache, identity, { mergeTools: true });
  const out = advertised(built, 'ToolSearch');
  check('newer form: max_results stays optional', !out?.input_schema?.required?.includes('max_results'), JSON.stringify(out?.input_schema?.required));
}
{
  // The lowercase declaration is dropped and the call comes back as ToolSearch,
  // which the client does not declare: its requirements are not the bundled tool's.
  const lower = { ...toolSearch(['query', 'max_results']), name: 'toolsearch' };
  const built = buildCCRequest(request([lower, bash]), billingTag, cache, identity, { mergeTools: true });
  const tools = built.body.tools ?? [];
  const out = advertised(built, 'ToolSearch');
  check('a name differing in case: the client declaration is not appended', !tools.some((t) => t.name === 'toolsearch'), JSON.stringify(tools.map((t) => t.name)));
  check('a name differing in case: the bundled ToolSearch goes out as is', out === bundled, JSON.stringify(out?.input_schema?.required));
  const response = JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'ToolSearch', input: { query: 'select:Read' } }] });
  const back = JSON.parse(reverseMapResponse(response, built.toolMap)).content[0];
  check('a name differing in case: a ToolSearch call comes back as ToolSearch', back.name === 'ToolSearch', back.name);
}

console.log('\n  buildCCRequest, a name differing in case, default mode');
{
  const lower = { ...toolSearch(['query', 'max_results']), name: 'toolsearch' };
  const built = buildCCRequest(request([lower, bash]), billingTag, cache, identity, {});
  const tools = built.body.tools ?? [];
  const wire = built.toolMap.get('toolsearch')?.ccTool;
  check('toolsearch is routed through its own MCP-shaped tool', wire === 'mcp__client__toolsearch', wire);
  const own = advertised(built, wire);
  check('that tool is advertised with the client schema', !!own && JSON.stringify(own.input_schema) === JSON.stringify(lower.input_schema), JSON.stringify(tools.map((t) => t.name)));
  check('that tool keeps max_results required', own?.input_schema?.required?.includes('max_results'), JSON.stringify(own?.input_schema?.required));
  const out = advertised(built, 'ToolSearch');
  check('the bundled ToolSearch, if advertised, does not take the requirements of toolsearch', out === undefined || out === bundled, JSON.stringify(out?.input_schema?.required));
  const input = { query: 'select:Read', max_results: 3 };
  const response = JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_1', name: wire, input }] });
  const back = JSON.parse(reverseMapResponse(response, built.toolMap)).content[0];
  check('a call to that tool comes back as toolsearch', back.name === 'toolsearch', back.name);
  check('a call to that tool keeps its input as sent', JSON.stringify(back.input) === JSON.stringify(input), JSON.stringify(back.input));
}
{
  const lower = { ...toolSearch(['query', 'max_results']), name: 'toolsearch' };
  const built = buildCCRequest(request([lower, toolSearch(['query']), bash]), billingTag, cache, identity, {});
  const out = advertised(built, 'ToolSearch');
  check('both spellings declared: ToolSearch follows its own exact-name declaration', out === bundled, JSON.stringify(out?.input_schema?.required));
  check('both spellings declared: ToolSearch maps back to ToolSearch', built.toolMap.get('ToolSearch')?.ccTool === 'ToolSearch');
}

console.log('\n  buildCCRequest, Read and a case-only alias read');
{
  const Read = {
    name: 'Read',
    description: 'read a file',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, limit: { type: 'integer' } },
      required: ['file_path', 'limit'],
    },
  };
  const read = { name: 'read', description: 'read by path', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
  const input = { file_path: '/tmp/a.txt', limit: 10 };
  const response = JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input }] });
  for (const [order, tools] of [['Read first', [Read, read, bash]], ['read first', [read, Read, bash]]]) {
    for (const [mode, opts] of [['default mode', {}], ['hybrid mode', { hybridTools: true }]]) {
      const built = buildCCRequest(request(tools), billingTag, cache, identity, opts);
      const out = advertised(built, 'Read');
      check(`${order}, ${mode}: Read is advertised with limit required`, out?.input_schema?.required?.includes('limit'), JSON.stringify(out?.input_schema?.required));
      const back = JSON.parse(reverseMapResponse(response, built.toolMap)).content[0];
      check(`${order}, ${mode}: a Read call comes back as Read`, back.name === 'Read', back.name);
      check(`${order}, ${mode}: a Read call keeps limit`, back.input?.limit === 10, JSON.stringify(back.input));
      const wire = built.toolMap.get('read')?.ccTool;
      check(`${order}, ${mode}: read goes out under its own name`, wire === 'mcp__client__read', wire);
      const own = advertised(built, wire);
      check(`${order}, ${mode}: read is advertised with its own schema`, !!own && JSON.stringify(own.input_schema) === JSON.stringify(read.input_schema), JSON.stringify((built.body.tools ?? []).map((t) => t.name)));
      const readCall = JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_2', name: wire, input: { path: '/tmp/b.txt' } }] });
      const readBack = JSON.parse(reverseMapResponse(readCall, built.toolMap)).content[0];
      check(`${order}, ${mode}: a call to read comes back as read with its input`, readBack.name === 'read' && JSON.stringify(readBack.input) === '{"path":"/tmp/b.txt"}', JSON.stringify(readBack));
      for (const [chosen, wireChosen] of [['read', 'mcp__client__read'], ['Read', 'Read']]) {
        for (const model of ['claude-sonnet-5', 'claude-haiku-5-5']) {
          const forced = buildCCRequest({ ...request(tools), model, tool_choice: { type: 'tool', name: chosen } }, billingTag, cache, identity, opts);
          const choice = forced.body.tool_choice;
          check(`${order}, ${mode}, ${model}: tool_choice ${chosen} goes out as ${wireChosen}`, choice?.type === 'tool' && choice?.name === wireChosen, JSON.stringify(choice));
          check(`${order}, ${mode}, ${model}: the chosen wire tool is advertised`, !!advertised(forced, wireChosen), JSON.stringify((forced.body.tools ?? []).map((t) => t.name)));
          const forcedInput = chosen === 'read' ? { path: '/tmp/c.txt' } : { file_path: '/tmp/c.txt', limit: 5 };
          const call = JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_3', name: choice?.name, input: forcedInput }] });
          const callBack = JSON.parse(reverseMapResponse(call, forced.toolMap)).content[0];
          check(`${order}, ${mode}, ${model}: the forced call comes back as ${chosen}`, callBack.name === chosen, callBack.name);
          check(`${order}, ${mode}, ${model}: the forced call keeps its input`, JSON.stringify(callBack.input) === JSON.stringify(forcedInput), JSON.stringify(callBack.input));
        }
      }
    }
  }
  {
    const built = buildCCRequest(request([read, bash]), billingTag, cache, identity, {});
    const back = JSON.parse(reverseMapResponse(response, built.toolMap)).content[0];
    check('only read declared: a Read call comes back as read', back.name === 'read', back.name);
    check('only read declared: the input is translated to the path shape', back.input?.path === '/tmp/a.txt', JSON.stringify(back.input));
    const forced = buildCCRequest({ ...request([read, bash]), tool_choice: { type: 'tool', name: 'read' } }, billingTag, cache, identity, {});
    check('only read declared: tool_choice read goes out as Read', forced.body.tool_choice?.name === 'Read', JSON.stringify(forced.body.tool_choice));
    check('only read declared: read is not carried under its own name', !(forced.body.tools ?? []).some((t) => t.name === 'mcp__client__read'));
  }
  {
    // A real MCP tool already holds mcp__client__read: the alias takes a free name.
    const mcpRead = { name: 'mcp__client__read', description: 'mcp read', input_schema: { type: 'object', properties: { uri: { type: 'string' } }, required: ['uri'] } };
    for (const [order, tools] of [['Read first', [Read, read, mcpRead, bash]], ['mcp tool first', [mcpRead, read, Read, bash]]]) {
      for (const [mode, opts] of [['default mode', {}], ['hybrid mode', { hybridTools: true }]]) {
        const built = buildCCRequest(request(tools), billingTag, cache, identity, opts);
        const names = (built.body.tools ?? []).map((t) => t.name);
        check(`${order}, ${mode}, with ${mcpRead.name}: outgoing tool names are unique`, new Set(names).size === names.length, JSON.stringify(names));
        const wire = built.toolMap.get('read')?.ccTool;
        check(`${order}, ${mode}, with ${mcpRead.name}: read goes out under a name of its own`, typeof wire === 'string' && wire !== 'Read' && wire !== mcpRead.name && /^[a-zA-Z0-9_-]{1,64}$/.test(wire), wire);
        const own = advertised(built, wire);
        check(`${order}, ${mode}, with ${mcpRead.name}: read is advertised with its own schema`, !!own && JSON.stringify(own.input_schema) === JSON.stringify(read.input_schema), JSON.stringify(names));
        const mcpOut = advertised(built, mcpRead.name);
        check(`${order}, ${mode}, with ${mcpRead.name}: the MCP tool keeps its name and schema`, !!mcpOut && JSON.stringify(mcpOut.input_schema) === JSON.stringify(mcpRead.input_schema), JSON.stringify(names));
        check(`${order}, ${mode}, with ${mcpRead.name}: Read keeps limit required`, advertised(built, 'Read')?.input_schema?.required?.includes('limit'));
        for (const [wireName, clientName, input] of [
          ['Read', 'Read', { file_path: '/tmp/a.txt', limit: 10 }],
          [wire, 'read', { path: '/tmp/b.txt' }],
          [mcpRead.name, mcpRead.name, { uri: 'x://y' }],
        ]) {
          const call = JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_4', name: wireName, input }] });
          const back = JSON.parse(reverseMapResponse(call, built.toolMap)).content[0];
          check(`${order}, ${mode}, with ${mcpRead.name}: a call to ${wireName} comes back as ${clientName}`, back.name === clientName && JSON.stringify(back.input) === JSON.stringify(input), JSON.stringify(back));
        }
        for (const [chosen, wireChosen] of [['read', wire], ['Read', 'Read'], [mcpRead.name, mcpRead.name]]) {
          const forced = buildCCRequest({ ...request(tools), tool_choice: { type: 'tool', name: chosen } }, billingTag, cache, identity, opts);
          check(`${order}, ${mode}, with ${mcpRead.name}: tool_choice ${chosen} goes out as ${wireChosen}`, forced.body.tool_choice?.name === wireChosen, JSON.stringify(forced.body.tool_choice));
        }
        const history = buildCCRequest({
          ...request(tools),
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_5', name: 'read', input: { path: '/tmp/b.txt' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_5', content: 'ok' }] },
          ],
        }, billingTag, cache, identity, opts);
        const hist = history.body.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'));
        const histName = hist?.content.find((b) => b.type === 'tool_use')?.name;
        check(`${order}, ${mode}, with ${mcpRead.name}: a read call in history goes out under read's wire name`, histName === wire, histName);
      }
    }
  }
}

console.log('\n  buildCCRequest, custom Bash and a server-defined bash');
{
  const serverBash = { type: 'bash_20250124', name: 'bash' };
  const bashInput = { command: 'ls' };
  for (const [order, tools] of [['Bash first', [bash, serverBash]], ['bash first', [serverBash, bash]]]) {
    for (const [mode, opts] of [['default mode', {}], ['hybrid mode', { hybridTools: true }]]) {
      let built, error;
      try { built = buildCCRequest(request(tools), billingTag, cache, identity, opts); } catch (e) { error = e; }
      check(`${order}, ${mode}: the request is built`, !error, error?.message);
      if (!built) continue;
      const names = (built.body.tools ?? []).map((t) => t.name);
      check(`${order}, ${mode}: Bash is advertised`, names.includes('Bash'), JSON.stringify(names));
      check(`${order}, ${mode}: outgoing tool names are unique`, new Set(names).size === names.length, JSON.stringify(names));
      const call = JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_6', name: 'Bash', input: bashInput }] });
      const back = JSON.parse(reverseMapResponse(call, built.toolMap)).content[0];
      check(`${order}, ${mode}: a Bash call comes back as Bash with its input`, back.name === 'Bash' && JSON.stringify(back.input) === JSON.stringify(bashInput), JSON.stringify(back));
      const serverOut = (built.body.tools ?? []).find((t) => t.name === 'bash');
      check(`${order}, ${mode}: bash goes out as declared, with its type and name`, JSON.stringify(serverOut) === JSON.stringify(serverBash), JSON.stringify(names));
      check(`${order}, ${mode}: bash is routed to itself`, built.toolMap.get('bash')?.ccTool === 'bash', built.toolMap.get('bash')?.ccTool);
      const serverCall = JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_7', name: 'bash', input: bashInput }] });
      const serverBack = JSON.parse(reverseMapResponse(serverCall, built.toolMap)).content[0];
      check(`${order}, ${mode}: a bash call comes back as bash with its input`, serverBack.name === 'bash' && serverBack.input?.command === 'ls', JSON.stringify(serverBack));
      for (const chosen of ['Bash', 'bash']) {
        const forced = buildCCRequest({ ...request(tools), tool_choice: { type: 'tool', name: chosen } }, billingTag, cache, identity, opts);
        check(`${order}, ${mode}: tool_choice ${chosen} goes out as ${chosen}`, forced.body.tool_choice?.name === chosen, JSON.stringify(forced.body.tool_choice));
        check(`${order}, ${mode}: the chosen ${chosen} is advertised`, !!advertised(forced, chosen), JSON.stringify((forced.body.tools ?? []).map((t) => t.name)));
        const call = JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_8', name: forced.body.tool_choice?.name, input: bashInput }] });
        const callBack = JSON.parse(reverseMapResponse(call, forced.toolMap)).content[0];
        check(`${order}, ${mode}: the forced ${chosen} call comes back as ${chosen}`, callBack.name === chosen, callBack.name);
      }
      for (const prior of ['Bash', 'bash']) {
        const history = buildCCRequest({
          ...request(tools),
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: prior, input: bashInput }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok' }] },
          ],
        }, billingTag, cache, identity, opts);
        const hist = history.body.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'));
        const histName = hist?.content.find((b) => b.type === 'tool_use')?.name;
        check(`${order}, ${mode}: a ${prior} call in history goes out as ${prior}`, histName === prior, histName);
      }
    }
  }
  {
    const built = buildCCRequest(request([serverBash]), billingTag, cache, identity, {});
    check('only bash declared: the server-defined bash still maps to Bash', JSON.stringify((built.body.tools ?? []).map((t) => t.name)) === '["Bash"]' && built.toolMap.get('bash')?.ccTool === 'Bash', JSON.stringify((built.body.tools ?? []).map((t) => t.name)));
  }
}

console.log('\n  buildCCRequest, hybrid mode fills context fields on a case-only alias');
{
  const Read = { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } };
  const read = { name: 'read', description: 'read by path', input_schema: { type: 'object', properties: { path: { type: 'string' }, session_id: { type: 'string' } }, required: ['path'] } };
  const ctx = { sessionId: 'sess-42', requestId: 'req-1', timestamp: '2026-11-25T00:00:00.000Z' };
  for (const [order, tools] of [['Read first', [Read, read, bash]], ['read first', [read, Read, bash]]]) {
    const built = buildCCRequest(request(tools), billingTag, cache, identity, { hybridTools: true });
    const wire = built.toolMap.get('read')?.ccTool;
    const call = JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_10', name: wire, input: { path: '/tmp/b.txt' } }] });
    const back = JSON.parse(reverseMapResponse(call, built.toolMap, ctx)).content[0];
    check(`${order}: a read call without session_id gets the request's`, back.name === 'read' && back.input?.session_id === 'sess-42' && back.input?.path === '/tmp/b.txt', JSON.stringify(back));
    const plain = buildCCRequest(request(tools), billingTag, cache, identity, {});
    const plainBack = JSON.parse(reverseMapResponse(JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_11', name: plain.toolMap.get('read')?.ccTool, input: { path: '/tmp/b.txt' } }] }), plain.toolMap, ctx)).content[0];
    check(`${order}: default mode does not fill session_id`, plainBack.input?.session_id === undefined, JSON.stringify(plainBack));
  }
}

console.log('\n  buildCCRequest, merge mode with Read and read');
{
  const Read = { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } };
  const read = { name: 'read', description: 'read by path', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
  const built = buildCCRequest({ ...request([Read, read, bash]), tool_choice: { type: 'tool', name: 'read' } }, billingTag, cache, identity, { mergeTools: true });
  const names = (built.body.tools ?? []).map((t) => t.name);
  check('merge mode: read is deduplicated case-insensitively against Read', !names.includes('read') && !names.some((n) => n.startsWith('mcp__client__read')), JSON.stringify(names));
  check('merge mode: a forced choice of read is dropped', built.body.tool_choice === undefined, JSON.stringify(built.body.tool_choice));
}

console.log('\n  withClientRequiredFields');
{
  const def = { name: 'X', input_schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] } };
  const kept = withClientRequiredFields(def, { name: 'X', input_schema: { type: 'object', required: ['a', 'b'] } });
  check('a field the client requires is added', JSON.stringify(kept.input_schema.required) === '["a","b"]', JSON.stringify(kept.input_schema.required));
  check('the input is not mutated', JSON.stringify(def.input_schema.required) === '["a"]');
  const unknown = withClientRequiredFields(def, { name: 'X', input_schema: { type: 'object', required: ['a', 'zzz'] } });
  check('a field the bundle does not define is not added', unknown === def, JSON.stringify(unknown.input_schema.required));
  const noRequired = { name: 'Y', input_schema: { type: 'object', properties: { a: { type: 'string' } } } };
  const fromNone = withClientRequiredFields(noRequired, { name: 'Y', input_schema: { type: 'object', required: ['a'] } });
  check('a bundled schema without a required list gets one', JSON.stringify(fromNone.input_schema.required) === '["a"]', JSON.stringify(fromNone.input_schema.required));
  check('no client declaration: unchanged', withClientRequiredFields(def, undefined) === def);
  check('a client required list that is not an array: unchanged', withClientRequiredFields(def, { name: 'X', input_schema: { required: 'b' } }) === def);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
