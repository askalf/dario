// Preload for a spawned CLI: `NODE_OPTIONS=--require <this file>`.
//
// Replaces globalThis.fetch before the CLI loads, so a proxy started from the
// real `dist/cli.js` never reaches the network. Three upstream routes are
// answered, each matched on the exact origin (https://api.anthropic.com), the
// exact pathname and the method:
//   GET  /v1/models                                      the model catalog
//   POST /v1/messages                                    inference, one canned message
//   POST /v1/code/sessions/<id>/client/presence          the session heartbeat
// Every other call is refused. There is no passthrough: the child only makes
// upstream calls, and the test's own requests to it do not go through this fetch.
//
// Each answer or refusal prints one stderr line starting with `[fetch-stub]`, so
// the parent can read what the child asked for:
//   [fetch-stub] models
//   [fetch-stub] messages bytes=<n>
//   [fetch-stub] presence
//   [fetch-stub] refused <method> <url>
// A CommonJS file, loaded with --require, because that works on every Node the
// package declares; --import needs 18.18. Bun does not read NODE_OPTIONS, so the
// parent sets DARIO_NO_BUN=1 to keep the CLI from relaunching under Bun.

const ORIGIN = 'https://api.anthropic.com';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const method = String((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
  let url = null;
  try { url = new URL(raw); } catch { /* refused below */ }
  if (url && url.origin === ORIGIN) {
    if (method === 'GET' && url.pathname === '/v1/models') {
      console.error('[fetch-stub] models');
      return json(200, { data: [{ id: 'claude-opus-5', type: 'model' }] });
    }
    if (method === 'POST' && url.pathname === '/v1/messages') {
      const body = init && init.body;
      const bytes = body == null ? 0 : (typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);
      console.error(`[fetch-stub] messages bytes=${bytes}`);
      return json(200, {
        id: 'msg_cli_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
        content: [{ type: 'text', text: 'served through the CLI' }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }, { 'request-id': 'req_cli_1' });
    }
    if (method === 'POST' && /^\/v1\/code\/sessions\/[^/]+\/client\/presence$/.test(url.pathname)) {
      console.error('[fetch-stub] presence');
      return json(200, {});
    }
  }
  console.error(`[fetch-stub] refused ${method} ${raw}`);
  throw new Error(`unexpected network call in test: ${method} ${raw}`);
};
