// Unit tests for scripts/drift-feed.mjs — the pure diff behind the Claude Code
// wire-drift feed. Two template snapshots in, a list of human-readable changes
// out; the git walk and the renderers are exercised by generating the real
// feed in CI (drift-feed.yml), not here.

import { diffTemplates, entryTitle, renderRss, renderJsonFeed, renderHtml } from '../scripts/drift-feed.mjs';

let pass = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log(`  ✅ ${label}`); pass++; }
  else { console.log(`  ❌ ${label}${detail !== undefined ? ' :: ' + String(detail).slice(0, 300) : ''}`); fail++; }
};
const header = (l) => console.log(`\n=== ${l} ===`);

const base = {
  _version: '2.1.268', _captured: '2026-09-10T00:00:00Z',
  anthropic_beta: 'claude-code-20250219,interleaved-thinking-2025-05-14',
  tool_names: ['Bash', 'Read'],
  tools: [{ name: 'Bash', input_schema: { properties: { command: {} } } }, { name: 'Read', input_schema: {} }],
  header_values: { 'user-agent': 'claude-cli/2.1.268 (external, sdk-cli)', 'x-app': 'cli', 'anthropic-version': '2023-06-01' },
  header_order: ['accept', 'user-agent', 'x-app'],
  body_field_order: ['model', 'messages', 'system'],
  system_prompt: 'You are an interactive agent.\nBe terse.\n',
  system_prompt_variants: { 'opus-5': 'Opus text.', 'sonnet-5': 'Sonnet text.' },
  agent_identity: 'You are a Claude agent.',
};
const clone = () => JSON.parse(JSON.stringify(base));

header('a release that changed nothing on the wire');
{
  const next = clone();
  next._version = '2.1.269'; next._captured = '2026-09-11T00:00:00Z';
  next.header_values['user-agent'] = 'claude-cli/2.1.269 (external, sdk-cli)';
  const d = diffTemplates(base, next);
  check('version moved, nothing on the wire', d.versionChanged && d.wire === false && d.changes.length === 0, JSON.stringify(d.changes));
  check('title says so', entryTitle({ ...d, sha: 'abc' }) === 'Claude Code 2.1.269 shipped — nothing changed on the wire');
  check('the user-agent release number alone is not a header change', !d.changes.some((c) => c.kind === 'header'));
}

header('a real wire change');
{
  const next = clone();
  next._version = '2.1.270';
  next.anthropic_beta = 'claude-code-20250219,mid-conversation-tool-changes-2026-07-01';
  next.tool_names = ['Bash', 'Read', 'Workflow'];
  next.tools = [{ name: 'Bash', input_schema: { properties: { command: {}, timeout: {} } } }, { name: 'Read', input_schema: {} }, { name: 'Workflow', input_schema: {} }];
  next.header_values['x-app'] = 'cli-v2';
  next.header_values['x-new'] = '1';
  delete next.header_values['anthropic-version'];
  next.body_field_order = ['model', 'system', 'messages'];
  next.system_prompt = 'You are an interactive agent.\nBe terse and kind.\n';
  next.system_prompt_variants = { 'opus-5': 'Opus text, revised.', 'fable': 'Fable text.' };
  const d = diffTemplates(base, next);
  const texts = d.changes.map((c) => c.text);
  check('wire change with every kind represented', d.wire && ['beta', 'tool', 'header', 'body', 'prompt'].every((k) => d.changes.some((c) => c.kind === k)), texts.join(' | '));
  check('betas added and removed by name', texts.includes('beta flag added: `mid-conversation-tool-changes-2026-07-01`') && texts.includes('beta flag removed: `interleaved-thinking-2025-05-14`'));
  check('tool added; changed schema counted by name', texts.includes('tool added: `Workflow`') && texts.includes('1 tool schema changed: `Bash`'));
  check('header value change, addition, removal', texts.some((t) => t.startsWith('header `x-app`: `cli` → `cli-v2`')) && texts.includes('header added: `x-new: 1`') && texts.includes('header removed: `anthropic-version`'));
  check('body field order', texts.includes('body field order changed: model, system, messages'));
  const sp = d.changes.find((c) => c.text.startsWith('system prompt changed'));
  check('system prompt delta with a bracketed excerpt of the changed span', sp && sp.text.includes('+9 chars') && sp.detail.before.includes('«') && sp.detail.after.includes('and kind') && sp.detail.whitespaceOnly === false, JSON.stringify(sp));
  check('variants: added, removed, changed with delta', texts.includes('system prompt variant added: `fable`') && texts.includes('system prompt variant removed: `sonnet-5`') && texts.some((t) => t.startsWith('system prompt variant `opus-5` changed (+9 chars')));
  check('title lists the kinds', entryTitle({ ...d, sha: 'x' }) === 'Claude Code 2.1.270: beta flags, tools, headers, body order, system prompt changed on the wire', entryTitle({ ...d, sha: 'x' }));
}

header('whitespace-only prompt edits are called out');
{
  const next = clone();
  next.system_prompt = base.system_prompt.trimEnd();
  const d = diffTemplates(base, next);
  const sp = d.changes.find((c) => c.kind === 'prompt');
  check('-1 char, whitespace only', d.wire && sp.text.includes('-1 chars') && sp.detail.whitespaceOnly === true, JSON.stringify(sp));
}

header('first observation and renderers');
{
  const d = diffTemplates(null, base);
  check('the first snapshot is a single first-observation entry, not a wall of "added"', d.first === true && d.versionChanged && d.version === '2.1.268' && d.changes.length === 0 && entryTitle({ ...d, sha: 'x' }) === 'Claude Code 2.1.268 — first template observed', JSON.stringify(d));
  const entries = [{ ...diffTemplates(base, { ...clone(), _version: '2.1.269', anthropic_beta: base.anthropic_beta + ',x-2026' }), sha: 'deadbeefcafe', date: '2026-09-11T12:00:00Z', subject: 'auto-rebake (#1)', pr: '1' }];
  const rss = renderRss(entries, 'https://example.test/feed');
  check('RSS: one item with guid, link anchor, escaped description', rss.includes('<item>') && rss.includes('<guid isPermaLink="false">https://github.com/askalf/dario/commit/deadbeefcafe</guid>') && rss.includes('https://example.test/feed/#deadbeefca') && rss.includes('beta flag added: `x-2026`'), rss.slice(0, 400));
  const jf = JSON.parse(renderJsonFeed(entries, 'https://example.test/feed'));
  check('JSON Feed 1.1 with the structured change list under _dario', jf.version === 'https://jsonfeed.org/version/1.1' && jf.items[0]._dario.changes[0].kind === 'beta' && jf.items[0].url === 'https://example.test/feed/#deadbeefca');
  const html = renderHtml(entries, 'https://example.test/feed');
  check('HTML: title, feed links, the entry, no raw <script>', html.includes('<title>Claude Code wire drift</title>') && html.includes('href="feed.xml"') && html.includes('id="deadbeefca"') && html.includes('<code>x-2026</code>') && !html.includes('<script'));
  const evil = [{ ...diffTemplates(base, { ...clone(), _version: '<img src=x onerror=1>', anthropic_beta: base.anthropic_beta + ',<b>' }), sha: 'abc', date: '2026-09-11T12:00:00Z', subject: 's', pr: null }];
  check('HTML escapes template-sourced text', !renderHtml(evil, '').includes('<img src=x') && renderHtml(evil, '').includes('&lt;img'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
