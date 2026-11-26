// Preload for a spawned CLI: `NODE_OPTIONS=--import <this file>`.
//
// Replaces globalThis.fetch before the CLI loads, so a proxy started from the
// real `dist/cli.js` never reaches the network. It answers /v1/models (the
// model catalog the proxy fetches at startup) and /v1/messages (one canned
// message), passes loopback URLs (the test's own requests to the proxy) to the
// real fetch, and refuses every other URL. Each line it prints to stderr starts
// with `[fetch-stub]`, so the parent can read what the child asked for:
//   [fetch-stub] models                  a model catalog fetch (the proxy's startup)
//   [fetch-stub] messages bytes=<n>      an inference call and its body size
//   [fetch-stub] refused <url>           a URL it did not answer
// It only runs under Node: Bun does not read NODE_OPTIONS, so the parent sets
// DARIO_NO_BUN=1 to keep the CLI from relaunching under Bun.

const realFetch = globalThis.fetch;

globalThis.fetch = async (url, init) => {
  const target = String(url instanceof Request ? url.url : url);
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(target)) return realFetch(url, init);
  if (target.includes('/v1/models')) {
    console.error('[fetch-stub] models');
    return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5', type: 'model' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  if (target.includes('/v1/messages')) {
    const body = init?.body;
    const bytes = body == null ? 0 : (typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);
    console.error(`[fetch-stub] messages bytes=${bytes}`);
    return new Response(JSON.stringify({
      id: 'msg_cli_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: 'served through the CLI' }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_cli_1' } });
  }
  console.error(`[fetch-stub] refused ${target}`);
  throw new Error(`unexpected network call in test: ${target}`);
};
