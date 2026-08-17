// Pure functions for the --check drift detector in `capture-and-bake.mjs`.
// Lives in its own module so the test suite can exercise drift detection
// without spawning a live CC capture (the top of capture-and-bake.mjs
// kicks off captureLiveTemplateAsync at import time, which is not what
// unit tests want).
//
// Added in v4.5.0 — unified-diff snippets in drift reports.

/**
 * Betas that `betaForModel()` (src/proxy.ts) appends to the base set per-request
 * based on the model — they are deliberately NOT part of the baked base set. A
 * live `--check` capture carries them depending on which model the capture used
 * (e.g. `context-1m` rides `[1m]` requests, `fallback-credit` rides fable), so
 * comparing them against the base would false-positive on every run forever
 * (issue #484). Excluded from the anthropic_beta drift comparison on both sides.
 * Keep in sync with CONTEXT_1M_BETA / FABLE_FALLBACK_CREDIT_BETA in src/proxy.ts.
 */
export const MODEL_CONDITIONAL_BETAS = new Set([
  'context-1m-2025-08-07',      // CONTEXT_1M_BETA — appended for [1m]-labelled requests only
  'fallback-credit-2026-06-01', // FABLE_FALLBACK_CREDIT_BETA — appended for fable requests only
]);

/**
 * Betas CC toggles by REMOTE CONFIG, independent of its version.
 *
 * Distinct from MODEL_CONDITIONAL_BETAS above, which are flags dario itself
 * appends per-request — those are ours, and comparing them against a base that
 * never carried them is a false positive we manufactured. These are CC's own:
 * it sends them or it does not, on Anthropic's schedule, and a bake captures
 * whichever state happened to be live that minute.
 *
 * Observed 2026-07-26: afk-mode flipped off (auto-rebake #869, 04:51Z), on
 * (8/8 captures at 15:45Z, baked into 5.4.13), then off again (#878, 16:45Z) —
 * four transitions in twelve hours. Each flip opened a rebake PR, bumped a
 * version and cut a full release: multi-arch GHCR build, Sigstore attestation,
 * npm publish, autodeploy. Release churn on Anthropic's remote-config cadence.
 *
 * Stripping is safe in both directions. betaForModel() documents that its
 * per-family shape is correct whether or not the base carries afk-mode — the
 * anchor-relative inserts degrade to append/no-op when the anchor is absent —
 * and `removing a beta can never provoke an upstream 400`. Sending it is the
 * side with a cost: afk-mode is rejected on Max 5x, which the unavailableBetas
 * recovery absorbs at one 400 per account. So a base without it is strictly
 * cheaper than a base that oscillates.
 *
 * The tradeoff, stated plainly: dario's beta set differs from CC's by this one
 * flag whenever CC is sending it. That is a deliberate divergence from wire
 * fidelity, taken because the alternative is a release per flip.
 */
export const REMOTE_CONFIG_CONDITIONAL_BETAS = new Set([
  'afk-mode-2026-01-31', // AFK_MODE_BETA in src/proxy.ts — remote-config gated
]);

/**
 * Strip the betas that must not reach the baked base: the model-conditional ones
 * betaForModel() appends per-request, and the remote-config ones CC toggles on
 * Anthropic's schedule (see the two sets above).
 *
 * Historical note on the name: it predates the remote-config class and is kept
 * from a comma-joined beta string. Used by the BAKE path (capture-and-bake.mjs) so
 * the canonical base set written to cc-template-data.json never carries them — a
 * live capture that happened to ride them (e.g. a `[1m]` request carrying
 * context-1m) would otherwise re-introduce them to the base on every rebake,
 * undoing #475's design. Mirrors the filter computeDrift applies for detection.
 */
export function stripModelConditionalBetas(beta) {
  return (beta || '')
    .split(',')
    .filter(Boolean)
    .filter((b) => !MODEL_CONDITIONAL_BETAS.has(b) && !REMOTE_CONFIG_CONDITIONAL_BETAS.has(b))
    .join(',');
}

/**
 * True when `live` is a strictly OLDER CC version than `bundled`. Used by the
 * stale-binary guard in capture-and-bake.mjs: a runner whose installed CC is
 * older than the CC that produced the current bundle re-captures yesterday's
 * wire shape and reports it as "drift" — which reached the ship gate as a
 * template DOWNGRADE on 2026-07-02 (PR #632: runner at 2.1.197 against a
 * 2.1.198-baked bundle). An older binary cannot observe forward drift.
 *
 * Fails OPEN: if either version is missing or doesn't parse as dotted
 * numerics (optional leading `v`), returns false — the guard must never
 * block a legitimate bake over a weird version string; shape detection
 * still applies downstream.
 */
export function isOlderCCVersion(live, bundled) {
  const parse = (v) => {
    if (typeof v !== 'string') return null;
    const m = v.trim().replace(/^v/, '');
    if (!/^\d+(\.\d+)*$/.test(m)) return null;
    return m.split('.').map(Number);
  };
  const a = parse(live);
  const b = parse(bundled);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Collapse the environment-specific CC memory directory path to a placeholder so
 * a cross-OS bake doesn't read as system_prompt drift: the bundle may be baked on
 * one platform (e.g. Windows `C:\Users\user\.claude\projects\…\memory\`) while the
 * drift-watch runner captures another (`/root/.claude/projects/project/memory/`).
 * That line differs on every cross-host bake and is not CC drift (issue #484).
 * Matches the backtick-quoted path token containing both `.claude` and `memory`.
 */
export function normalizeMemoryPath(s) {
  return (s || '').replace(/`[^`]*\.claude[^`]*memory[^`]*`/g, '`<MEMORY_DIR>`');
}

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

  // anthropic_beta — added/removed sets, ignoring two classes of flag.
  // The model-conditional ones betaForModel() appends per-request: the bundle's
  // anthropic_beta is the BASE set, so context-1m / fallback-credit ride a live
  // capture without being base drift (#484). And the remote-config ones CC
  // toggles on Anthropic's schedule, which flip faster than a release can ship
  // (afk-mode moved four times in twelve hours on 2026-07-26).
  //
  // Filtered from BOTH sides so the exclusion is symmetric — a base that still
  // carries an excluded flag from an older bake does not read as drift either.
  // Every other beta is still compared, so a genuine base-beta change surfaces.
  {
    const stripManaged = (s) =>
      new Set((s || '').split(',').filter(Boolean)
        .filter((b) => !MODEL_CONDITIONAL_BETAS.has(b) && !REMOTE_CONFIG_CONDITIONAL_BETAS.has(b)));
    const prevBetas = stripManaged(prev.anthropic_beta);
    const nowBetas = stripManaged(now.anthropic_beta);
    const addedB = [...nowBetas].filter((b) => !prevBetas.has(b));
    const removedB = [...prevBetas].filter((b) => !nowBetas.has(b));
    if (addedB.length > 0) out.push({ summary: `anthropic_beta added: ${addedB.join(', ')}` });
    if (removedB.length > 0) out.push({ summary: `anthropic_beta removed: ${removedB.join(', ')}` });
  }

  // system_prompt — content (detail = unified diff). Normalize the env-specific
  // memory directory path first so a cross-host bake (e.g. Windows bundle vs
  // Linux runner capture) doesn't read as drift on that one line. All other
  // content is still compared verbatim, so a real prompt edit still surfaces.
  {
    const prevSp = normalizeMemoryPath(prev.system_prompt || '');
    const nowSp = normalizeMemoryPath(now.system_prompt || '');
    if (prevSp !== nowSp) {
      const delta = nowSp.length - prevSp.length;
      out.push({
        summary: `system_prompt content changed (${prevSp.length} → ${nowSp.length} chars, delta ${delta >= 0 ? '+' : ''}${delta})`,
        detail: unifiedDiff(prevSp, nowSp),
      });
    }
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

// ── #881 tripwire: the intermittent +279-char base-prompt residue ─────
//
// About one local capture in ten, the scrubbed BASE system prompt comes back
// 5038 chars instead of the usual 4759 — an extra `# Context management`
// paragraph that is not in the baked bundle. Root cause unknown (dario#881);
// 26h of CI data says it has never reached the Linux runner, and #881
// deliberately defers any bake-time normalisation ("should not be taken on a
// hunch"). So this is a DETECTOR ONLY: it never strips, rewrites or suppresses
// anything. Its whole job is to make a 5038 capture impossible to mistake for
// a genuine CC prompt change if it ever does reach CI and auto-opens a rebake
// PR.

/**
 * The paragraph's opening sentence. `# Context management` alone is useless as
 * a discriminator — the CURRENT 4759-char bundle already has that heading, so
 * matching on it would flag every clean capture. This sentence is the part
 * that only appears in the 5038 readings.
 */
export const ISSUE_881_MARKER =
  'When you have enough information to act, act.';

/** Scrubbed base lengths from #881: the normal reading and the anomalous one. */
export const ISSUE_881_BASELINE_LEN = 4759;
export const ISSUE_881_ANOMALY_LEN = 5038;

/**
 * Decide whether a scrubbed base capture carries the #881 residue relative to
 * the bundled template.
 *
 * Two independent clauses, either sufficient:
 *
 *  1. **Marker clause** — the capture contains the marker sentence and the
 *     bundle does not. This is the primary signal and survives the paragraph's
 *     wording drifting in length.
 *  2. **Length clause** — the capture is exactly 5038 and the bundle exactly
 *     4759, the pair documented in #881. A backstop for the case where the
 *     sentence gets reworded but the byte count still lands on the known pair.
 *
 * Both clauses are relative to the bundle, which is what keeps the tripwire
 * from becoming permanent noise: if the paragraph is ever legitimately baked
 * in, the bundle gains the marker (and stops being 4759), both clauses go
 * false, and the detector silently disarms with no code change.
 *
 * A genuine CC prompt change — #881 cites the real 4754 -> 4759 step — trips
 * neither clause, so it flows through as ordinary drift. That specificity is
 * the point: flagging every base-length change would defeat the tripwire.
 *
 * @param {string} capturedPrompt scrubbed base system_prompt from the live capture
 * @param {string} bundledPrompt  system_prompt from src/cc-template-data.json
 * @returns {{detected: boolean, reason: string|null, capturedLen: number, bundledLen: number}}
 */
export function detectIssue881Residue(capturedPrompt, bundledPrompt) {
  const captured = typeof capturedPrompt === 'string' ? capturedPrompt : '';
  const bundled = typeof bundledPrompt === 'string' ? bundledPrompt : '';
  const result = { detected: false, reason: null, capturedLen: captured.length, bundledLen: bundled.length };

  if (captured.includes(ISSUE_881_MARKER) && !bundled.includes(ISSUE_881_MARKER)) {
    result.detected = true;
    result.reason = 'marker';
    return result;
  }
  if (captured.length === ISSUE_881_ANOMALY_LEN && bundled.length === ISSUE_881_BASELINE_LEN) {
    result.detected = true;
    result.reason = 'length';
    return result;
  }
  return result;
}

/**
 * Render the tripwire hit for the `--check` log. Line 1 is a GitHub Actions
 * `::warning::` annotation, so a hit surfaces on the run summary rather than
 * being buried in step output; the rest is prose for the human reading the
 * drift issue / PR body, both of which embed this stream verbatim.
 *
 * The annotation is emitted unconditionally rather than gated on `$GITHUB_ACTIONS`
 * — outside Actions it is just a prefixed line, and gating on the env var would
 * make the one path that matters the one path that is never exercised locally.
 */
export function formatIssue881Warning(detection) {
  const via = detection.reason === 'marker'
    ? `the "${ISSUE_881_MARKER}" marker sentence is in the capture but not the bundle`
    : `the capture is exactly ${ISSUE_881_ANOMALY_LEN} chars against a ${ISSUE_881_BASELINE_LEN}-char bundle`;
  return [
    `::warning title=dario#881 base-prompt residue::Base system prompt captured at ${detection.capturedLen} chars vs ${detection.bundledLen} bundled — matches the KNOWN dario#881 anomaly (${via}). Any rebake PR from this run is #881 residue, NOT a genuine CC prompt change. Do not merge without reading https://github.com/askalf/dario/issues/881`,
    '',
    'TRIPWIRE: dario#881 — intermittent +279-char base-prompt residue',
    `  captured base: ${detection.capturedLen} chars`,
    `  bundled base:  ${detection.bundledLen} chars`,
    `  matched via:   ${detection.reason} clause (${via})`,
    '',
    '  This capture carries the extra "# Context management" paragraph that #881',
    '  documents as appearing in roughly 1 local capture in 10 and never (until now)',
    '  in CI. Treat any resulting rebake PR as #881 residue until proven otherwise:',
    '  the base prompt did not change upstream, this run captured it wrong.',
    '',
    '  Do NOT merge the rebake on the assumption that CC edited its prompt. Re-run the',
    '  workflow; if the next capture comes back clean, this was the anomaly. Comment the',
    '  outcome on #881 either way — the correlating conditions are what that issue needs.',
  ];
}

// ──────────────────────────────────────────────────────────────────────
// Content-empty rebake guard (dario#990)
// ──────────────────────────────────────────────────────────────────────
//
// `cc-drift-template-watch.yml`'s auto-rebake step gates on
// `git diff --quiet -- src/cc-template-data.json` to answer "did the bake
// actually change the bundle?". That gate CANNOT fire: every
// `capture-and-bake` run stamps a fresh `_captured` timestamp, so the file is
// always textually dirty even when the wire shape is byte-identical. A
// transient `--check` capture therefore reaches the ship gate as a PR with a
// version bump and a "wire-fingerprint drift" CHANGELOG entry describing a
// change that isn't in the diff.
//
// Live case: PR #990 (v5.5.18). Every content key — tools, system_prompt,
// system_prompt_variants, anthropic_beta, header_order, header_values,
// body_field_order, agent_identity — was identical to v5.5.17; only
// `_captured` moved. The `--check` capture had matched the dario#881 residue
// signature, the bake's own capture had not, and nothing downstream noticed
// that the two disagreed to the point of an empty bundle.

/**
 * Fields a bake rewrites unconditionally, independent of wire shape. Only
 * `_captured` qualifies: it is a provenance stamp for WHEN the capture ran,
 * never a statement about what the capture found.
 *
 * Deliberately narrow. `_version` / `_supportedMaxTested` / the user-agent
 * header are NOT here — when those move the bundle genuinely ships something
 * (that is the whole content of a label-sync PR), so a rebake carrying only a
 * version-label move is still worth opening.
 */
export const TRANSIENT_TEMPLATE_FIELDS = new Set(['_captured']);

/**
 * Top-level keys whose value differs between two baked templates, ignoring
 * `TRANSIENT_TEMPLATE_FIELDS`. Compared by canonical JSON so key order inside
 * a nested object never reads as a change.
 *
 * An empty result means the freshly-baked bundle ships nothing: the capture
 * that triggered the rebake was transient, and merging would cut a release for
 * a wire-shape change that did not happen upstream.
 */
export function meaningfulTemplateKeys(prev, now) {
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(now || {})]);
  const changed = [];
  for (const k of keys) {
    if (TRANSIENT_TEMPLATE_FIELDS.has(k)) continue;
    if (JSON.stringify(prev?.[k]) !== JSON.stringify(now?.[k])) changed.push(k);
  }
  return changed.sort();
}
