#!/usr/bin/env node
// Opus fallback aliases, version pins, and CLI model defaults.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); fail++; }
};
const header = (n) => console.log(`\n=== ${n} ===`);

const tmpHome = await mkdtemp(join(tmpdir(), 'dario-opus-alias-'));
process.env.HOME = tmpHome; process.env.USERPROFILE = tmpHome;
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

const { getModelCatalog, getCachedBases, _resetModelCatalogForTest } = await import('../dist/model-catalog.js');
const { OPENAI_MODELS_LIST, resolveClaudeAlias } = await import('../dist/proxy.js');
const { runChecks } = await import('../dist/doctor-core.js');

const catalogOf = (ids) => ({
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }) }),
  getToken: async () => 'tok',
  now: () => 1_000_000,
});

header('baked listing carries Opus 5.5 ahead of Opus 5');
{
  const ids = OPENAI_MODELS_LIST.data.map((m) => m.id);
  check('claude-opus-5-5 listed', ids.includes('claude-opus-5-5'));
  check('claude-opus-5-5[1m] listed', ids.includes('claude-opus-5-5[1m]'));
  check('claude-opus-5 still listed', ids.includes('claude-opus-5'));
  check('5.5 precedes 5', ids.indexOf('claude-opus-5-5') !== -1 && ids.indexOf('claude-opus-5-5') < ids.indexOf('claude-opus-5'));
}

header('static map: the catalog lists no opus family');
{
  _resetModelCatalogForTest();
  await getModelCatalog(catalogOf(['claude-sonnet-5', 'claude-haiku-4-5']));
  check('the fake catalog is in force', !getCachedBases().some((b) => b.includes('opus')), getCachedBases().join(','));
  check("'opus' -> claude-opus-5-5", resolveClaudeAlias('opus') === 'claude-opus-5-5', resolveClaudeAlias('opus'));
  check("'opus1m' -> claude-opus-5-5[1m]", resolveClaudeAlias('opus1m') === 'claude-opus-5-5[1m]', resolveClaudeAlias('opus1m'));
  check("'opus5' -> claude-opus-5", resolveClaudeAlias('opus5') === 'claude-opus-5', resolveClaudeAlias('opus5'));
  check("'opus48' -> claude-opus-4-8", resolveClaudeAlias('opus48') === 'claude-opus-4-8');
}

header('opus5 stays pinned while the family floats past 5.5');
{
  _resetModelCatalogForTest();
  await getModelCatalog(catalogOf(['claude-opus-6', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5']));
  check("'opus' follows the catalog to claude-opus-6", resolveClaudeAlias('opus') === 'claude-opus-6', resolveClaudeAlias('opus'));
  check("'opus5' -> claude-opus-5", resolveClaudeAlias('opus5') === 'claude-opus-5', resolveClaudeAlias('opus5'));
  check("'opus5' with a 1m suffix is not a family shorthand", resolveClaudeAlias('opus51m') === 'opus51m');
  _resetModelCatalogForTest();
}

// A fake proxy: /health is up, every message answers PONG, and the model of
// each request is recorded.
const seen = [];
const proxy = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url === '/health') { res.writeHead(200); res.end('{"status":"ok"}'); return; }
    try { seen.push(JSON.parse(body).model); } catch { seen.push(null); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'served', content: [{ type: 'text', text: 'PONG' }] }));
  });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const port = proxy.address().port;

header('doctor --obedience probes the opus family as Opus 5.5');
{
  seen.length = 0;
  process.env.DARIO_TEST_URL = `http://127.0.0.1:${port}`;
  const checks = await runChecks({ obedience: true });
  delete process.env.DARIO_TEST_URL;
  const opus = checks.find((c) => c.label === 'Obedience (opus)');
  check('the opus row is ok', opus?.status === 'ok', JSON.stringify(opus));
  check('the opus request named claude-opus-5-5', seen.includes('claude-opus-5-5'), JSON.stringify(seen));
  check('no request named claude-opus-5', !seen.includes('claude-opus-5'), JSON.stringify(seen));
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, cwd: tmpHome });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { p.kill(); resolve({ code: null, out, err }); }, 20_000);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

header('accounts check: the default model list ends on Opus 5.5');
{
  seen.length = 0;
  const r = await run(['accounts', 'check', 'seat1', `--port=${port}`], { DARIO_ADMIN_TOKEN: 't' });
  check('exits 0', r.code === 0, `code=${r.code} err=${r.err.slice(0, 200)}`);
  check('probes haiku, sonnet, then claude-opus-5-5',
    JSON.stringify(seen) === JSON.stringify(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5-5']), JSON.stringify(seen));
  check('the report names claude-opus-5-5', r.out.includes('claude-opus-5-5'), r.out.slice(0, 300));
  check('--models= still overrides the default', await (async () => {
    seen.length = 0;
    await run(['accounts', 'check', 'seat1', `--port=${port}`, '--models=claude-opus-5'], { DARIO_ADMIN_TOKEN: 't' });
    return JSON.stringify(seen) === JSON.stringify(['claude-opus-5']);
  })(), JSON.stringify(seen));
}

header('help names the current full id');
{
  const r = await run(['help']);
  check('exits 0', r.code === 0, `code=${r.code}`);
  check('Full IDs line carries claude-opus-5-5', /Full IDs: claude-fable-5, claude-opus-5-5,/.test(r.out));
}

proxy.close();
await rm(tmpHome, { recursive: true, force: true });

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
