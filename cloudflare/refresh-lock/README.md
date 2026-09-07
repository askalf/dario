# dario refresh lock

A Cloudflare Worker + Durable Object that serializes OAuth refresh-token
calls across every dario instance pointed at the same Claude account — see
[dario#993](https://github.com/askalf/dario/issues/993). Optional and
additive: `src/accounts.ts` falls back to today's in-process-only behavior
whenever `DARIO_REFRESH_LOCK_URL` is unset, or whenever this Worker is
unreachable (fails open, never blocks a refresh on a Cloudflare outage).

## Why a lock alone doesn't fix this

Anthropic invalidates the previous `refresh_token` on every refresh. Two
dario instances refreshing the same account **serialized but back-to-back**
would still break: instance B's `refresh_token` is already burned by
instance A's refresh by the time B gets its turn. So `/acquire` doesn't
just block — a caller that loses the race gets the **winner's fresh
credentials** back directly and adopts them, skipping its own (guaranteed-
stale) refresh attempt entirely.

## Deploy

```
wrangler secret put LOCK_TOKEN     # generate a real random value, don't reuse another service's
wrangler deploy
```

Then on every dario instance:

```
DARIO_REFRESH_LOCK_URL=https://dario-refresh-lock.<subdomain>.workers.dev
DARIO_REFRESH_LOCK_TOKEN=<same value as LOCK_TOKEN>
```

## API

`POST /lock/<alias>/acquire` `{holder, ttlMs?}` →
`{acquired: true, lockId}` or `{acquired: false, credentials?, retryAfterMs?}`

`POST /lock/<alias>/release` `{holder, lockId, credentials?}` →
`{released: true}` or `409 {released: false, reason: "not holder"}` (lease
already expired and reassigned — do not treat this as an error worth
retrying, it means someone else is now the source of truth)

Ownership is the server-generated `lockId`, not `holder`: every dario
instance authenticates with the same `LOCK_TOKEN`, so `holder` is a value
the caller picks (typically a guessable hostname/pid), not a fact the
Worker can verify. The `lockId` comes back only in the `acquired: true`
response and must be echoed on `/release`. `holder` is still required —
for logs, not ownership. See `redis-lock/README.md` for the full
reasoning; the two backends deliberately share this contract.

Upgrading: a dario instance older than the `lockId` contract gets
`400 {error: "lockId required"}` on release, and its locks clear on their
own `ttlMs` (20s default) instead — slower serialization during the
window, nothing deadlocks. Locks held at the moment of Worker deploy have
no stored `lockId` and likewise expire on TTL once, at most 60s.

## Shared pool state

Since dario's `--pool-shared-state` (`DARIO_POOL_SHARED_STATE=1`), instances also exchange their
rate-limit readings and sticky bindings through this service, under the same bearer:

`POST /pool/seat/<alias>` `{instance, at, snapshot, rejected}` → `{ok: true}` — one instance's
last reading of one seat (`at` is the reading's epoch ms; `snapshot` is dario's rate-limit
snapshot; `rejected` says that instance holds the seat parked on it).

`POST /pool/seats` `{instance}` → `{seats: {<alias>: {instance, at, snapshot, rejected}}}` — every
seat's latest reading. Clients adopt a reading only when it is newer than their own and not
older than six hours, so nothing here needs a TTL. The service keeps only the newest report per seat (compare-and-set on `at`), so a stalled older report never replaces a fresher one (one `__pool__` object holds them).

`POST /pool/sticky/<key>/bind` `{alias, ttlMs?}` → `{ok: true}` and
`POST /pool/sticky/<key>/get` `{}` → `{alias}` or `{alias: null}` — which seat a conversation
(keyed by dario's 16-hex sticky key, a hash of its first user message) is bound to.

Nothing here is a credential: readings, aliases and hashed keys only. Every call fails open on
the dario side — a service outage leaves each instance on its own state, as before.
