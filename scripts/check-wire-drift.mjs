#!/usr/bin/env node
/**
 * Runtime wire-drift watcher — the request-time counterpart to
 * scripts/check-cc-drift.mjs (which statically scans the installed Claude Code
 * package and so can't see anything CC only decides at REQUEST time).
 *
 * Two wire signals drifted silently between CC 2.1.170 and 2.1.199 because
 * nothing ran the installed `claude` and compared the request it sends to what dario
 * emits (dario#528 follow-up):
 *
 *   1. Per-model `anthropic-beta` set. betaForModel encodes CC's per-family
 *      add/drop/reorder rules; those moved (sonnet-5 keeps mid-conversation-
 *      system, haiku drops afk-mode + reorders, fable/[1m] positions). This
 *      check spawns the installed `claude` for opus/sonnet/haiku/fable, reads each
 *      anthropic-beta header, and asserts betaForModel reproduces it from the
 *      opus base — EXACTLY, order included.
 *
 *   3. Header SET and static header VALUES. dario synthesises CC's header set on
 *      the template-rebuild path (non-CC clients). A header CC starts sending, or
 *      a value CC nudges, is invisible to the static scan and to check 1/2 — the
 *      same silence that hid the beta drift before #528. Compares CC's captured
 *      request against what the REAL proxy emits, in-process via
 *      ProxyOptions.fetchImpl, because computing the expected set from the pure
 *      helpers misses call-site additions — exactly the bug class that shipped a
 *      no-op header fix in #886.
 *
 *   4. Top-level body key ORDER. Captured as body_field_order and replayed; a
 *      reorder upstream is a real wire difference and nothing watched it.
 *
 *   2. `cch` billing-integrity token. CC dropped it entirely (sdk-cli); dario
 *      now omits it unless a calibrated seed exists (hasCchSeed). This check
 *      reads whether CC's billing block still carries `cch=` and asserts
 *      dario's gate agrees: CC-emits-cch XOR we-have-a-seed is a drift.
 *
 * Mechanism: spawn the installed `claude` pointed at a loopback endpoint with a
 * stub api key and read the request it sends. No OAuth, no real Anthropic call
 * — the beta header and billing block are built into the request before it
 * leaves the process.
 *
 * Run on the self-hosted `dario-drift` runner (it has `claude`); GH-hosted
 * runners don't. Exits non-zero on any HARD drift (empty findings => clean).
 *
 *   node scripts/check-wire-drift.mjs
 *   DARIO_CLAUDE_BIN=/path/to/claude node scripts/check-wire-drift.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// live-fingerprint.js does not import cc-template.js (no circularity), so this
// is safe to import and use BEFORE proxy.js/cc-template.js ever load.
import { refreshLiveFingerprintAsync } from '../dist/live-fingerprint.js';
import { hasCchSeed } from '../dist/cch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const CC_BIN = process.env.DARIO_CLAUDE_BIN || 'claude';
const useShell = process.platform === 'win32' && !/[\\/]/.test(CC_BIN);
const cleanHome = mkdtempSync(join(tmpdir(), 'wire-drift-'));

// Force a fresh live capture onto ~/.dario/cc-template.live.json BEFORE proxy.js
// is ever imported. cc-template.ts loads CC_TEMPLATE synchronously, ONCE, at
// module init (`const TEMPLATE = loadTemplate(...)`) — refreshLiveFingerprintAsync
// writes a fresh capture to disk but is explicitly "picked up on the next dario
// startup" (its own docstring), never live-reloaded into an already-running
// process. Importing proxy.js first (as this script used to) meant every
// header.values comparison below was measuring whatever cache happened to be on
// disk at import time, not what dario would actually emit on its next start —
// so a runner whose cache predates a just-released CC version always reported a
// spurious "the overlay is not reaching these keys" drift (dario#914) that a
// process restart alone would have cleared. Forcing the capture here, and only
// THEN importing proxy.js, makes this check measure the same "if dario
// restarted right now" fidelity as a real deploy, closing that false-positive
// class without weakening genuine persistent drift.
await refreshLiveFingerprintAsync({ force: true, silent: false }).catch((err) => {
  console.error(`[wire-drift] pre-check live capture failed (continuing with whatever cache is on disk): ${err instanceof Error ? err.message : err}`);
});
const { betaForModel, startProxy } = await import('../dist/proxy.js');

// The families dario transforms betaForModel for. Opus is the base.
// claude-opus-5 added 2026-07-25: the runner probed every family EXCEPT the
// current flagship, so opus-5's fallback-credit beta went unmodelled through a
// whole release. The base for comparison stays opus-4-8 (unchanged transform).
const MODELS = ['claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5'];

function log(m) { console.error(`[wire-drift] ${m}`); }

function capture(model) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.url.includes('/v1/messages') && req.method === 'POST' && !server._cap) {
          // rawHeaders preserves wire order; req.headers does not. Both are kept:
          // order for the set comparison, the object for value lookups.
          server._cap = { headers: req.headers, rawHeaders: req.rawHeaders, buf: Buffer.concat(chunks) };
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const env = {
        ...process.env,
        HOME: cleanHome, USERPROFILE: cleanHome,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: 'sk-capture-stub',
        CLAUDE_NONINTERACTIVE: '1',
      };
      const cc = spawn(CC_BIN, ['--print', '--model', model, '-p', 'hi'], {
        env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, shell: useShell,
      });
      const done = () => {
        try { server.close(); } catch {}
        const cap = server._cap;
        if (!cap) return resolve(null);
        let buf = cap.buf;
        if ((cap.headers['content-encoding'] || '').includes('gzip')) { try { buf = gunzipSync(buf); } catch {} }
        const text = buf.toString('utf8');
        const beta = typeof cap.headers['anthropic-beta'] === 'string' ? cap.headers['anthropic-beta'] : null;
        const billing = (/x-anthropic-billing-header:[^"]*/.exec(text) || [])[0] || null;
        const version = (/cc_version=([0-9]+\.[0-9]+\.[0-9]+)/.exec(text) || [])[1] || null;
        const cchEmitted = /cch=[0-9a-fA-F]{5}/.test(text);
        const headerNames = [];
        const seenH = new Set();
        for (let i = 0; i < (cap.rawHeaders || []).length; i += 2) {
          const n = String(cap.rawHeaders[i]).toLowerCase();
          if (!seenH.has(n)) { seenH.add(n); headerNames.push(n); }
        }
        let bodyKeys = null;
        try { bodyKeys = Object.keys(JSON.parse(text)); } catch { /* not JSON: leave null */ }
        resolve({ model, beta, billing, version, cchEmitted, headerNames, headerValues: cap.headers, bodyKeys });
      };
      cc.on('exit', () => setTimeout(done, 200));
      cc.on('error', (e) => { log(`spawn error for ${model}: ${e.message}`); resolve(null); });
      setTimeout(() => { try { cc.kill(); } catch {}; done(); }, 40000);
    });
  });
}


// ── what dario ACTUALLY emits, measured not computed ──
//
// Runs the real proxy in-process with an injected fetchImpl that records the
// upstream request instead of sending it. Deliberately NOT computed from
// staticHeaders + overlayTemplateHeaderValues: those are pure and correct in
// isolation while the assembled call site adds, overrides and reorders. #886
// shipped a header fix that passed every unit test and emitted nothing, because
// it gated on a startup flag rather than a per-request one. Only the assembled
// path tells the truth.
//
// A PLAIN body is used on purpose so dario takes the template-REBUILD path. That
// is where it synthesises CC's shape, so that is where synthesis can drift. The
// passthrough path forwards the client's own headers (#886) and has nothing to
// drift against.
async function emitViaDario() {
  const PORT = 39877;
  let seen = null;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/v1/messages')) {
      const h = {};
      const raw = init?.headers;
      if (Array.isArray(raw)) for (const [k, v] of raw) h[String(k).toLowerCase()] = String(v);
      else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) h[String(k).toLowerCase()] = String(v);
      // dario passes the outbound body as a Uint8Array, not a string. Decoding
      // is not optional: parsing it as a string throws, and the first version of
      // this left keys=null, which made the body-order check skip in silence --
      // the precise failure this script exists to catch.
      let keys = null;
      let bodyErr = null;
      try {
        const b = init?.body;
        const text = (b instanceof Uint8Array) ? new TextDecoder().decode(b)
          : (typeof b === 'string') ? b
          : (b && typeof b.byteLength === 'number') ? new TextDecoder().decode(new Uint8Array(b))
          : null;
        if (text === null) bodyErr = `unrecognised body type ${b?.constructor?.name ?? typeof b}`;
        else keys = Object.keys(JSON.parse(text));
      } catch (e) { bodyErr = e.message; }
      if (!seen) seen = { headers: h, bodyKeys: keys, bodyErr };
    }
    return new Response(JSON.stringify({
      id: 'msg_wire_drift', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await startProxy({
      port: PORT, host: '127.0.0.1',
      upstreamApiKey: 'sk-ant-wire-drift-stub',
      noClaudeAuth: true, fetchImpl,
    });
  } catch (e) {
    log(`could not start the in-process proxy: ${e.message}`);
    return null;
  }
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'dario' },
      body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
  } catch (e) {
    log(`in-process request failed: ${e.message}`);
  }
  return seen;
}

// Headers excluded from the SET/VALUE comparison, with the reason each is not a
// fidelity signal. Everything else CC sends is expected to appear.
const WIRE_COMPARE_SKIP = new Set([
  // auth: dario substitutes the pool account's credential by design
  'authorization', 'x-api-key',
  // transport: owned by the HTTP stack, injected after dario builds the record
  'host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'keep-alive',
  // rotate per call — presence is meaningful, value is not
  'x-claude-code-session-id', 'x-client-request-id', 'x-request-id',
  // already asserted exactly, order included, by check 1
  'anthropic-beta',
]);

const findings = [];
const caps = {};
for (const m of MODELS) {
  const c = await capture(m);
  if (!c || !c.beta) {
    findings.push({ severity: 'high', category: 'capture', message: `Failed to capture a /v1/messages request for ${m} (is claude installed and runnable?).` });
    continue;
  }
  caps[m] = c;
}

const opus = caps['claude-opus-4-8'];
if (opus && opus.beta) {
  // ── (1) per-model beta transform vs the installed CC ──
  // Opus IS the base; assert betaForModel reproduces every other family from it.
  for (const m of MODELS) {
    const c = caps[m];
    if (!c || !c.beta) continue;
    const derived = betaForModel(opus.beta, m);
    if (derived !== c.beta) {
      findings.push({
        severity: 'high',
        category: 'beta.transform',
        model: m,
        message: `betaForModel drift for ${m}: dario would emit a beta set that does not match the installed CC ${c.version || ''}.`,
        expected: c.beta,
        got: derived,
      });
    }
  }

  // Informational: is the BAKED base still current (modulo the OAuth flag dario
  // appends only in production and afk-mode's remote-config volatility)?
  try {
    const tmpl = JSON.parse(readFileSync(join(repoRoot, 'src/cc-template-data.json'), 'utf-8'));
    const norm = (s) => s.split(',').filter((f) => f && f !== 'oauth-2025-04-20' && f !== 'afk-mode-2026-01-31').join(',');
    if (tmpl.anthropic_beta && norm(tmpl.anthropic_beta) !== norm(opus.beta)) {
      findings.push({
        severity: 'low',
        category: 'beta.base',
        message: 'Baked template anthropic_beta differs from the installed opus base (ignoring oauth-2025-04-20 + volatile afk-mode). Re-run capture-and-bake; the periodic template refresh heals this automatically.',
        expected: opus.beta,
        got: tmpl.anthropic_beta,
      });
    }
  } catch { /* template unreadable — the static drift check covers that */ }
}

// ── (2) cch gate vs CC's billing block ──
for (const m of MODELS) {
  const c = caps[m];
  if (!c || !c.version) continue;
  const weWouldEmit = hasCchSeed(c.version);
  if (c.cchEmitted && !weWouldEmit) {
    findings.push({
      severity: 'high', category: 'cch.gate', model: m,
      message: `CC ${c.version} emits a cch token but dario has no seed for it (hasCchSeed=false) — dario would OMIT cch while CC sends one. Run scripts/cch-calibrate.mjs to add the seed.`,
    });
  } else if (!c.cchEmitted && weWouldEmit) {
    findings.push({
      severity: 'high', category: 'cch.gate', model: m,
      message: `CC ${c.version} emits NO cch token but dario holds a seed (hasCchSeed=true) — dario would emit a cch CC no longer sends. Drop ${c.version} from CCH_SEEDS.`,
    });
  }
}


// ── (3) header SET + (4) static header VALUES + (5) body key ORDER ──
// Compared against the opus base capture, which is the one CC shape dario
// reproduces without transforms.
if (opus && opus.headerNames) {
  const emitted = await emitViaDario();
  if (!emitted) {
    findings.push({
      severity: 'low', category: 'emit.probe',
      message: 'Could not measure what dario emits in-process; header/body-order checks skipped this run.',
    });
  } else {
    // (3) every header CC sends should appear in dario's emitted set.
    const missing = opus.headerNames.filter((h) => !WIRE_COMPARE_SKIP.has(h) && !(h in emitted.headers));
    if (missing.length > 0) {
      findings.push({
        severity: 'high', category: 'header.set',
        message: `CC ${opus.version || ''} sends header(s) dario does not emit. A header that appears upstream and never in dario's request is a wire difference on every call.`,
        expected: missing.join(', '),
        got: '(absent from the outbound headers dario built)',
      });
    }

    // (4) values for the static headers — catches both a stale hardcoded
    // fallback and a template that stopped matching reality.
    const valueDrift = [];
    for (const h of opus.headerNames) {
      if (WIRE_COMPARE_SKIP.has(h)) continue;
      const ccVal = opus.headerValues?.[h];
      const ourVal = emitted.headers[h];
      if (typeof ccVal !== 'string' || typeof ourVal !== 'string') continue;
      if (ccVal !== ourVal) valueDrift.push(`${h}: CC=${ccVal} dario=${ourVal}`);
    }
    if (valueDrift.length > 0) {
      findings.push({
        severity: 'high', category: 'header.values',
        message: `dario emits different values than CC ${opus.version || ''} for header(s) it is meant to replay. The live template overlay normally heals this; a persistent difference means the overlay is not reaching these keys.`,
        expected: valueDrift.join(' | '),
        got: '(see expected — CC vs dario pairs)',
      });
    }

    // (5) top-level body key order. An unreadable body on either side is
    // REPORTED — a check that cannot measure must not report agreement.
    if (!Array.isArray(emitted.bodyKeys) || !Array.isArray(opus.bodyKeys)) {
      findings.push({
        severity: 'low', category: 'body.order.unmeasured',
        message: `Could not read the top-level body keys on both sides, so body key order was NOT checked this run${emitted.bodyErr ? ` (dario side: ${emitted.bodyErr})` : ''}.`,
      });
    } else {
      const shared = opus.bodyKeys.filter((k) => emitted.bodyKeys.includes(k));
      const ourShared = emitted.bodyKeys.filter((k) => opus.bodyKeys.includes(k));
      if (shared.join(',') !== ourShared.join(',')) {
        findings.push({
          severity: 'high', category: 'body.order',
          message: 'Top-level body key order differs from CC for the keys both requests carry. body_field_order is replayed from the capture, so a mismatch means the baked order is stale.',
          expected: shared.join(','),
          got: ourShared.join(','),
        });
      }
    }
  }
}

const report = {
  drift: findings.some((f) => f.severity === 'high'),
  checkedAt: new Date().toISOString(),
  ccVersion: opus?.version ?? null,
  captured: Object.fromEntries(Object.entries(caps).map(([m, c]) => [m, { beta: c.beta, cchEmitted: c.cchEmitted, billing: c.billing }])),
  ccHeaderOrder: opus?.headerNames ?? null,
  ccBodyKeys: opus?.bodyKeys ?? null,
  findings,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.drift ? 1 : 0);
