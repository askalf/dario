// Pure functions for the --check drift detector in `capture-and-bake.mjs`.
// Lives in its own module so the test suite can exercise drift detection
// without spawning a live CC capture (the top of capture-and-bake.mjs
// kicks off captureLiveTemplateAsync at import time, which is not what
// unit tests want).
//
// Added in v4.5.0 — unified-diff snippets in drift reports.

/**
 * Generate a line-level unified diff between two text blobs. Bounded
 * output for issue / PR embedding. Each line is prefixed with
 * ` ` (context), `-` (removed), `+` (added), or `  …` (truncation /
 * hunk separator).
 *
 * Algorithm: LCS-table backtrack — O(mn) time/space, fine for scrubbed-
 * system-prompt-sized inputs (~12 KB / ~200 lines in current bakes).
 *
 * Returns an empty array when the two inputs are identical.
 */
export function unifiedDiff(prev, now, opts = {}) {
  const { contextLines = 2, maxLines = 60 } = opts;
  const a = (prev || '').split('\n');
  const b = (now || '').split('\n');
  const m = a.length;
  const n = b.length;

  // Length of LCS for prefixes a[0..i-1] and b[0..j-1].
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce ops, then reverse.
  const ops = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ k: ' ', s: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ k: '+', s: b[j - 1] });
      j--;
    } else {
      ops.push({ k: '-', s: a[i - 1] });
      i--;
    }
  }
  ops.reverse();

  // Find indices of changed ops; expand context around each.
  const changed = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].k !== ' ') changed.push(k);
  }
  if (changed.length === 0) return [];

  const keep = new Set();
  for (const idx of changed) {
    keep.add(idx);
    for (let c = 1; c <= contextLines; c++) {
      if (idx - c >= 0) keep.add(idx - c);
      if (idx + c < ops.length) keep.add(idx + c);
    }
  }
  const sorted = [...keep].sort((x, y) => x - y);

  const out = [];
  let lastIdx = -2;
  for (let s = 0; s < sorted.length; s++) {
    const idx = sorted[s];
    if (idx > lastIdx + 1) out.push('  …');
    out.push(ops[idx].k + ops[idx].s);
    lastIdx = idx;
    if (out.length >= maxLines) {
      const remaining = sorted.length - s - 1;
      if (remaining > 0) {
        out.push(`  … (${remaining} more changed/context line${remaining === 1 ? '' : 's'} truncated)`);
      }
      break;
    }
  }
  return out;
}

/**
 * Describe a tool for the drift report — first 100 chars of description,
 * + input_schema property keys. Used to give a reviewer context on what
 * a newly-added (or removed) tool actually does.
 */
export function describeTool(tool) {
  if (!tool) return [];
  const lines = [];
  const desc = (tool.description || '').split('\n')[0];
  if (desc) {
    lines.push(`${tool.name}: ${desc.slice(0, 100)}${desc.length > 100 ? '…' : ''}`);
  } else {
    lines.push(tool.name);
  }
  const props = tool.input_schema?.properties;
  if (props && typeof props === 'object') {
    const keys = Object.keys(props);
    if (keys.length > 0) lines.push(`  input keys: ${keys.join(', ')}`);
  }
  return lines;
}

/**
 * Compute the meaningful template drift between `prev` (current bundled)
 * and `now` (freshly captured + scrubbed). Returns an array of entries —
 * each with a `summary` line and an optional `detail` array of lines that
 * the caller renders indented under the summary.
 *
 * Intentionally ignores transient fields that always differ between runs:
 *   - `_captured` (timestamp)
 *   - `header_values['user-agent']` (varies by CC version; replayed)
 *   - `_version`, `_supportedMaxTested` (the point of --check is to catch
 *     drift WITHIN the same version, so a version-string diff isn't drift)
 *
 * Catches drift in:
 *   - tools (added / removed by name; detail shows description + schema keys)
 *   - anthropic_beta header value (added / removed lists)
 *   - system_prompt content (any character delta; detail is a unified diff)
 *   - body_field_order (detail shows the before / after JSON)
 *   - header_order (detail shows the before / after JSON)
 *   - agent_identity content (detail is a unified diff)
 *
 * v4.5.0 added the rich `{ summary, detail }` entry format; previously each
 * entry was a single summary string.
 */
export function computeDrift(prev, now) {
  const out = [];

  // tools — by name set, detail = description + schema keys
  const prevTools = new Map((prev.tools || []).map((t) => [t.name, t]));
  const nowTools = new Map((now.tools || []).map((t) => [t.name, t]));
  const addedTools = [...nowTools.keys()].filter((n) => !prevTools.has(n));
  const removedTools = [...prevTools.keys()].filter((n) => !nowTools.has(n));
  if (addedTools.length > 0) {
    out.push({
      summary: `tools added: ${addedTools.join(', ')}`,
      detail: addedTools.flatMap((n) => describeTool(nowTools.get(n))),
    });
  }
  if (removedTools.length > 0) {
    out.push({
      summary: `tools removed: ${removedTools.join(', ')}`,
      detail: removedTools.flatMap((n) => describeTool(prevTools.get(n))),
    });
  }

  // anthropic_beta — exact string match
  if ((prev.anthropic_beta || '') !== (now.anthropic_beta || '')) {
    const prevBetas = new Set((prev.anthropic_beta || '').split(',').filter(Boolean));
    const nowBetas = new Set((now.anthropic_beta || '').split(',').filter(Boolean));
    const addedB = [...nowBetas].filter((b) => !prevBetas.has(b));
    const removedB = [...prevBetas].filter((b) => !nowBetas.has(b));
    if (addedB.length > 0) out.push({ summary: `anthropic_beta added: ${addedB.join(', ')}` });
    if (removedB.length > 0) out.push({ summary: `anthropic_beta removed: ${removedB.join(', ')}` });
  }

  // system_prompt — content (detail = unified diff)
  if ((prev.system_prompt || '') !== (now.system_prompt || '')) {
    const prevLen = (prev.system_prompt || '').length;
    const nowLen = (now.system_prompt || '').length;
    const delta = nowLen - prevLen;
    out.push({
      summary: `system_prompt content changed (${prevLen} → ${nowLen} chars, delta ${delta >= 0 ? '+' : ''}${delta})`,
      detail: unifiedDiff(prev.system_prompt || '', now.system_prompt || ''),
    });
  }

  // body_field_order — array deep-equal
  if (JSON.stringify(prev.body_field_order || []) !== JSON.stringify(now.body_field_order || [])) {
    out.push({
      summary: 'body_field_order changed',
      detail: [
        `- ${JSON.stringify(prev.body_field_order)}`,
        `+ ${JSON.stringify(now.body_field_order)}`,
      ],
    });
  }

  // header_order — array deep-equal
  if (JSON.stringify(prev.header_order || []) !== JSON.stringify(now.header_order || [])) {
    out.push({
      summary: 'header_order changed',
      detail: [
        `- ${JSON.stringify(prev.header_order)}`,
        `+ ${JSON.stringify(now.header_order)}`,
      ],
    });
  }

  // agent_identity — exact string, detail = unified diff
  if ((prev.agent_identity || '') !== (now.agent_identity || '')) {
    const prevLen = (prev.agent_identity || '').length;
    const nowLen = (now.agent_identity || '').length;
    out.push({
      summary: `agent_identity content changed (${prevLen} → ${nowLen} chars)`,
      detail: unifiedDiff(prev.agent_identity || '', now.agent_identity || ''),
    });
  }

  return out;
}

/**
 * Render a drift report (from `computeDrift`) into the line list that
 * `capture-and-bake.mjs --check` logs through `log()`. Each summary
 * appears as a bullet; each detail line is indented under its bullet so
 * the [bake] prefix doesn't break the visual hierarchy.
 */
export function formatDriftReport(diff) {
  const lines = [];
  for (const item of diff) {
    lines.push(`  • ${item.summary}`);
    if (item.detail && item.detail.length > 0) {
      for (const d of item.detail) lines.push(`      ${d}`);
    }
  }
  return lines;
}

/**
 * Classify drift entries into a structured summary + a one-word
 * verdict the reviewer can scan at a glance. v4.7.0 — built so the
 * auto-rebake bot's PR body can lead with "ship this" or "investigate"
 * instead of forcing the reviewer to skim a unified-line diff.
 *
 * Verdicts (in increasing severity):
 *   - 'benign'       — only text content changed (system_prompt /
 *                      agent_identity / tool descriptions). No tool
 *                      added/removed, no structural shifts. The vast
 *                      majority of class-B drift events.
 *   - 'moderate'     — tools added (CC gained a capability), beta
 *                      headers added/removed (CC opted into/out of
 *                      a feature flag), agent_identity changed.
 *                      Probably ship, but worth a closer read.
 *   - 'substantive'  — tools REMOVED, body_field_order / header_order
 *                      changed. These can break dario's canonical-
 *                      rebuild path; don't auto-trust.
 *
 * The categorization is conservative — when in doubt, escalate. False
 * positives (calling something substantive when it's actually fine) waste
 * a reviewer's attention; false negatives (calling something benign when
 * it can break clients) waste subscribers' money via reclassification.
 */
export function interpretDrift(diff) {
  const summary = {
    toolsAdded: [],
    toolsRemoved: [],
    betasAdded: [],
    betasRemoved: [],
    systemPromptDelta: 0,
    agentIdentityChanged: false,
    bodyFieldOrderChanged: false,
    headerOrderChanged: false,
  };

  for (const entry of diff) {
    const s = entry.summary;
    if (s.startsWith('tools added:')) {
      summary.toolsAdded = s.replace('tools added:', '').trim().split(',').map((t) => t.trim()).filter(Boolean);
    } else if (s.startsWith('tools removed:')) {
      summary.toolsRemoved = s.replace('tools removed:', '').trim().split(',').map((t) => t.trim()).filter(Boolean);
    } else if (s.startsWith('anthropic_beta added:')) {
      summary.betasAdded = s.replace('anthropic_beta added:', '').trim().split(',').map((t) => t.trim()).filter(Boolean);
    } else if (s.startsWith('anthropic_beta removed:')) {
      summary.betasRemoved = s.replace('anthropic_beta removed:', '').trim().split(',').map((t) => t.trim()).filter(Boolean);
    } else if (s.startsWith('system_prompt content changed')) {
      const m = s.match(/delta ([+-]?\d+)/);
      if (m) summary.systemPromptDelta = parseInt(m[1], 10);
    } else if (s.startsWith('agent_identity content changed')) {
      summary.agentIdentityChanged = true;
    } else if (s === 'body_field_order changed') {
      summary.bodyFieldOrderChanged = true;
    } else if (s === 'header_order changed') {
      summary.headerOrderChanged = true;
    }
  }

  // Verdict ladder. Each tier dominates the ones below it.
  let verdict;
  if (summary.toolsRemoved.length > 0 || summary.bodyFieldOrderChanged || summary.headerOrderChanged) {
    verdict = 'substantive';
  } else if (summary.toolsAdded.length > 0 || summary.betasAdded.length > 0 || summary.betasRemoved.length > 0 || summary.agentIdentityChanged) {
    verdict = 'moderate';
  } else {
    verdict = 'benign';
  }

  return { ...summary, verdict };
}

/**
 * Render the interpreted drift summary as a human-scannable markdown
 * block — used at the top of the auto-rebake PR body and (in compact
 * form) the --check log output. Each line is its own list item; the
 * verdict gets a leading emoji + bold label.
 */
export function formatDriftSummary(interpretation) {
  const lines = [];
  const v = interpretation.verdict;
  const verdictEmoji = v === 'benign' ? '✅' : v === 'moderate' ? '🟡' : '🔴';
  const verdictLabel = v === 'benign' ? 'Benign'
    : v === 'moderate' ? 'Moderate — worth a closer read'
    : 'Substantive — investigate before merging';
  lines.push(`**Verdict:** ${verdictEmoji} ${verdictLabel}`);
  lines.push('');

  if (interpretation.toolsAdded.length > 0) {
    lines.push(`- **Tools added:** \`${interpretation.toolsAdded.join('`, `')}\` (CC gained a capability)`);
  }
  if (interpretation.toolsRemoved.length > 0) {
    lines.push(`- **Tools removed:** \`${interpretation.toolsRemoved.join('`, `')}\` ⚠ (can break canonical-rebuild paths)`);
  }
  if (interpretation.betasAdded.length > 0) {
    lines.push(`- **anthropic_beta added:** \`${interpretation.betasAdded.join('`, `')}\` (CC opted into a feature flag)`);
  }
  if (interpretation.betasRemoved.length > 0) {
    lines.push(`- **anthropic_beta removed:** \`${interpretation.betasRemoved.join('`, `')}\` (CC opted out of a feature flag)`);
  }
  if (interpretation.systemPromptDelta !== 0) {
    const sign = interpretation.systemPromptDelta > 0 ? '+' : '';
    lines.push(`- **system_prompt:** ${sign}${interpretation.systemPromptDelta} chars net (text-content drift — see unified diff below)`);
  }
  if (interpretation.agentIdentityChanged) {
    lines.push(`- **agent_identity:** changed (CC's "You are..." line shifted — affects classifier signal #4)`);
  }
  if (interpretation.bodyFieldOrderChanged) {
    lines.push(`- **body_field_order:** changed ⚠ (classifier signal #7 — affects every request shape)`);
  }
  if (interpretation.headerOrderChanged) {
    lines.push(`- **header_order:** changed (HTTP/2 header sequence — affects classifier signal)`);
  }

  if (lines.length === 2) {
    // Verdict line + blank, no axis bullets — should not happen if the
    // diff was non-empty, but defensive.
    lines.push('- *(no specific axes flagged — drift detector returned an empty interpretation)*');
  }

  return lines;
}
