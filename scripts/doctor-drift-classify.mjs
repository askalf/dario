// Pure parse + classify half of check-doctor-drift.mjs. Split out so the drift
// logic is unit-testable without a docker exec — the runner script execs into
// askalf-dario at module load, which a `node --test` subprocess can't do.
// Takes a `dario doctor --obedience` stdout dump and returns the parsed status
// rows plus the drift set. Zero dependencies; behaviour-identical to the
// inline version it replaced except for the OAuth gate documented below.

// Rows render as:  [ OK ]  OAuth   healthy (...)   /   [INFO]  Template   bundled capture, ...
function findRow(raw, labelRe) {
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*\[\s*(OK|INFO|WARN|FAIL|ERROR)\s*\]\s+(.*\S)\s*$/i);
    if (!m) continue;
    const status = m[1].toUpperCase();
    const rest = m[2];
    if (labelRe.test(rest)) return { status, detail: rest };
  }
  return null;
}

// Like findRow but collects every match — the obedience probe emits one
// row PER model family.
function findRows(raw, labelRe) {
  const rows = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*\[\s*(OK|INFO|WARN|FAIL|ERROR)\s*\]\s+(.*\S)\s*$/i);
    if (!m) continue;
    const status = m[1].toUpperCase();
    const rest = m[2];
    if (labelRe.test(rest)) rows.push({ status, detail: rest });
  }
  return rows;
}

/**
 * Parse a `dario doctor --obedience` dump and classify the runtime drifts no
 * other watcher catches.
 *
 * @param {string} raw doctor stdout
 * @returns {{oauth, template, identity, obedience, drift, parsedAnchors: boolean}}
 *   `parsedAnchors` is false when neither the OAuth nor the Template anchor row
 *   parsed — the caller treats that as an infra/format error (exit 3), NOT a
 *   clean run.
 */
export function classifyDoctorOutput(raw) {
  const oauth = findRow(raw, /^OAuth\b/i);
  const template = findRow(raw, /^Template\b(?!\s+drift)/i); // the capture row, NOT "Template drift"
  const identity = findRow(raw, /^Identity\b/i);
  const obedience = findRows(raw, /^Obedience\b/i);

  const drift = [];

  // OAuth is gated on the obedience ground truth. The non-Haiku obedience
  // probes (Sonnet / Opus / Fable) each require a live bearer to answer;
  // Haiku can fall back. So when they all PONG, OAuth is serving regardless
  // of the stored-token expiry the doctor reads: dario refreshes the bearer
  // in-memory per request in single-account mode and does NOT write the fresh
  // expiry back to the on-disk credential doctor inspects, so a cosmetic
  // "OAuth expired" row coexists with a fully-serving fleet (dario#721).
  // Only file OAuth drift when serving is NOT proven — obedience missing (a
  // deployed dario predating --obedience) or a non-Haiku probe not OK (a
  // genuinely dead bearer 401s and FAILs the probe anyway, so it still trips).
  const nonHaiku = obedience.filter((o) => /\b(sonnet|opus|fable)\b/i.test(o.detail));
  const oauthServes = nonHaiku.length > 0 && nonHaiku.every((o) => o.status === 'OK');
  if (oauth && oauth.status !== 'OK' && !oauthServes) {
    drift.push({ check: 'OAuth', status: oauth.status, detail: oauth.detail });
  }

  if (template && /\blive capture\b/i.test(template.detail)) {
    drift.push({ check: 'Template', status: template.status, detail: template.detail });
  }
  if (identity && identity.status === 'WARN') {
    drift.push({ check: 'Identity', status: identity.status, detail: identity.detail });
  }
  // Only FAIL is drift: WARN = probe couldn't complete (infra flake), INFO =
  // probe skipped (proxy not running — the container would be unhealthy and
  // caught elsewhere). No rows at all = deployed dario predates --obedience.
  for (const row of obedience) {
    if (row.status === 'FAIL') {
      drift.push({ check: 'Obedience', status: row.status, detail: row.detail });
    }
  }

  return { oauth, template, identity, obedience, drift, parsedAnchors: !!(oauth || template) };
}
