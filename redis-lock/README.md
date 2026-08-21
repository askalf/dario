# dario refresh lock (Redis backend)

A Redis-backed alternative to [`cloudflare/refresh-lock`](../cloudflare/refresh-lock)
that speaks the **identical** HTTP contract — same paths, same request/response
shapes, same auth header. `src/accounts.ts` doesn't know or care which backend
is behind `DARIO_REFRESH_LOCK_URL`; point it at this server instead of the
Cloudflare Worker and nothing else changes. See
[dario#993](https://github.com/askalf/dario/issues/993) for the original
Cloudflare-specific-dependency concern this exists to address — for airgapped
environments, or operators who already run Redis and don't want a Cloudflare
account in the loop.

Optional and additive, same as the Cloudflare version: `src/accounts.ts` falls
back to today's in-process-only behavior whenever `DARIO_REFRESH_LOCK_URL` is
unset, or whenever this server is unreachable (fails open, never blocks a
refresh on a lock-service outage).

## Why a lock alone doesn't fix this

Anthropic invalidates the previous `refresh_token` on every refresh. Two dario
instances refreshing the same account **serialized but back-to-back** would
still break: instance B's `refresh_token` is already burned by instance A's
refresh by the time B gets its turn. So `/acquire` doesn't just block — a
caller that loses the race gets the **winner's fresh credentials** back
directly and adopts them, skipping its own (guaranteed-stale) refresh attempt
entirely. Here that handoff is a `creds:<alias>` key with Redis's own `PX`
TTL doing the "how recent is recent enough" bookkeeping — no separate
timestamp field to track by hand, unlike the Durable Object version.

Zero new runtime dependencies: `resp-client.mjs` is a minimal hand-rolled
RESP2 client over `node:net` (dario ships with 0 runtime deps and this
doesn't break that), not the `redis`/`ioredis` packages.

## Run

```
docker build -t dario-refresh-lock .
docker run -d -p 8080:8080 \
  -e LOCK_TOKEN=<generate a real random value, don't reuse another service's> \
  -e REDIS_HOST=<your redis host> \
  -e REDIS_PORT=6379 \
  -e REDIS_PASSWORD=<if your redis requires one> \
  dario-refresh-lock
```

Or without Docker: `LOCK_TOKEN=... REDIS_HOST=... node server.mjs`.

Then on every dario instance:

```
DARIO_REFRESH_LOCK_URL=http://<host>:8080
DARIO_REFRESH_LOCK_TOKEN=<same value as LOCK_TOKEN>
```

## API

`POST /lock/<alias>/acquire` `{holder, ttlMs?, currentExpiresAt?}` →
`{acquired: true, lockId}` or `{acquired: false, credentials?, retryAfterMs?}`

`POST /lock/<alias>/release` `{holder, lockId, credentials?}` →
`{released: true}` or `409 {released: false, reason: "not holder"}` (lease
already expired and reassigned — do not treat this as an error worth
retrying, it means someone else is now the source of truth)

### `lockId` — why release needs more than `holder`

Every dario instance authenticates with the SAME shared `LOCK_TOKEN`, so
`holder` is a value the caller picks, not a fact the server can verify.
Holder strings are also guessable in practice (hostnames, pids), which makes
"release someone else's lock" a one-line request for anyone already inside
the trust boundary — the whole point of the lock is defeated exactly when
contention is highest.

So the value actually stored at `lock:<alias>` is a server-generated
`lockId` (`randomUUID()`), handed back only in the `acquired: true`
response and never derivable from anything the client controls. `/release`
compares the caller's `lockId` against the stored one inside the same
compare-and-delete Lua script that already guarded against expired-lease
deletes; `holder` is still required and still useful for logs, but no longer
carries ownership.

Practical consequence when upgrading: `lockId` is REQUIRED on `/release`,
and a client that omits it gets `400 {error: "lockId required"}`. Roll the
server and dario instances in either order — an un-upgraded client's releases
fail, and its locks then clear on their own `ttlMs` (20s by default) instead
of on release, so refreshes serialize more slowly during the window but stay
correct. Nothing deadlocks and no lock is leaked permanently.

The Cloudflare Worker (`cloudflare/refresh-lock/`) does not need this: a
Durable Object is addressed per-alias and verifies `holder` against its own
storage, so it issues no `lockId`. dario's client sends whatever the acquire
response gave it, which for that backend is `undefined` and is dropped by
`JSON.stringify` — one client, either backend, no configuration.

## Tested

Verified against a live Redis instance with the same 7-case contract suite
used against the Cloudflare Worker (lock/unlock, contested acquire, late
adoption of fresh credentials after release, wrong-holder release rejection,
bad-token 401) plus dario's own live dual-process race test
(`test/integration/dual-instance-race.mjs`) pointed at this server instead of
Cloudflare: 6/6 clean runs, one real refresh reaching the OAuth endpoint per
run, the other worker adopting the winner's credentials.
