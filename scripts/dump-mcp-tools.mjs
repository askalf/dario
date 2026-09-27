#!/usr/bin/env node
// Writes the tools/list response of `dario mcp` to mcp/dario.json, where
// truecopy.lock pins it. A tool description is text the connected agent reads
// and acts on, so a change to one has to be regenerated and re-pinned on
// purpose, and truecopy poison-scans it when it is.
//
//   node scripts/dump-mcp-tools.mjs           regenerate mcp/dario.json
//   node scripts/dump-mcp-tools.mjs --check   exit 1 if mcp/dario.json no
//                                             longer matches the code
//
// Needs `npm run build` first: it reads dist/. The response comes from the
// same handleMessage the stdio server answers with, over a registry whose data
// sources all throw, so nothing reads ~/.dario, OAuth state or the network.
// Listing tools never calls a handler.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildToolRegistry } from '../dist/mcp/tools.js';
import { handleMessage } from '../dist/mcp/protocol.js';

const file = fileURLToPath(new URL('../mcp/dario.json', import.meta.url));

const unused = () => { throw new Error('dump-mcp-tools lists tools only; no handler runs'); };
const tools = buildToolRegistry({
  doctor: unused, status: unused, accounts: unused, backends: unused,
  subagent: unused, fingerprint: unused, usage: unused, darioVersion: unused,
});
const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tools, { name: 'dario', version: '0' });
const listed = res.result.tools.slice().sort((a, b) => a.name.localeCompare(b.name));

// Non-ASCII is written as \u escapes so the file stays ASCII whatever the
// descriptions carry. The parsed JSON is unchanged.
const rendered = JSON.stringify({ name: 'dario', tools: listed }, null, 2)
  .replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';

if (process.argv.includes('--check')) {
  let committed = '';
  try { committed = readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { /* missing counts as stale */ }
  if (committed !== rendered) {
    console.error('mcp/dario.json is stale: the dario MCP tool surface changed.');
    console.error('Regenerate with `npm run build && node scripts/dump-mcp-tools.mjs`, review the diff, '
      + 'and re-pin with `truecopy add mcp/dario.json`.');
    process.exit(1);
  }
  console.log(`mcp/dario.json matches the dario MCP tool surface (${listed.length} tools)`);
} else {
  mkdirSync(fileURLToPath(new URL('../mcp/', import.meta.url)), { recursive: true });
  writeFileSync(file, rendered);
  console.log(`wrote mcp/dario.json (${listed.length} tools)`);
}
