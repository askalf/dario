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

The Durable Object keeps those credentials for 30 days after release. It
used to be 5 minutes, which covered only a race at the same instant: each
replica ticks on its own 15-minute phase, and one that came back later
refreshed with a token its peer had already rotated away
([#1733](https://github.com/askalf/dario/issues/1733)). 30 days is past the
28-day life of a refresh grant, and a newer login always beats an older one
(see `/peek` below), so a long-lived entry never hands back a stale grant.

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

Every call needs `Authorization: Bearer <LOCK_TOKEN>`; without it the Worker
answers `401` before reaching any Durable Object. If `LOCK_TOKEN` is not set
the Worker answers `503` to every call. Request bodies over 64 KB get `413`.

`POST /lock/<alias>/acquire` `{holder, ttlMs?, currentExpiresAt?, currentGrantedAt?}` →
`{acquired: true, lockId}` or `{acquired: false, credentials?, retryAfterMs?}`

`POST /lock/<alias>/peek` `{currentExpiresAt?, currentGrantedAt?}` →
`{credentials}` when the shared credentials are newer than the caller's, `{}`
otherwise. Takes no lock; dario calls it at startup and on every refresh tick
before deciding to refresh. Newer means a later `grantedAt` (a fresh
`dario login`) when both sides carry one, else a later `expiresAt`. A Worker
deployed before this endpoint answers 404, which dario reads as nothing to
adopt, so redeploy the Worker along with the dario upgrade.

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

## Shared account registry

Since dario's `--pool-shared-accounts` (`DARIO_POOL_SHARED_ACCOUNTS=1`), instances also keep one
list of Claude accounts here, under the same bearer, so a replica that starts with an empty
accounts directory gets its peers' accounts and an add or removal on one reaches the rest:

`POST /accounts/list` `{}` → `{accounts: {<alias>: <credentials>}, removed: {<alias>: <epoch ms>}}`:
every account record and every removal marker.

`POST /accounts/<alias>/put` `{credentials}` → `{stored}`: stores the record only when it is newer
than the one held (a newer `grantedAt`, or the same grant with a later `expiresAt`) and, under a
removal marker, only when it was granted after that removal. Storing clears the marker. A record
whose `alias` is not `<alias>`, or with no tokens or expiry, is a 400.

`POST /accounts/<alias>/remove` `{removedAt}` → `{removed}`: deletes the record unless it was granted
after `removedAt` (a later login wins), and keeps the latest removal time as the marker. The
marker is what stops an instance that was offline from pushing the removed account back.

**Unlike the pool state above, this is credentials.** Each record is a seat's full OAuth
credentials, refresh token included, and neither records nor markers expire. They live in the `__pool__` object as `account:<alias>` and `removed:<alias>`, so access to this Worker and its account needs the same care as the accounts directory itself. Anyone who
can read it can use every subscription in the pool, so give the service a real random
`LOCK_TOKEN` and keep it private.

Upgrading: rebuild or redeploy to serve these endpoints. Until then a dario with
`--pool-shared-accounts` gets a 404, logs the registry as unreachable once, and serves the
accounts on its own disk, as it did before.

## Pending logins

Admin API logins that are started and not yet completed ride the same switch, so a login started
on one replica completes on another. Per engine (`claude` or `codex`):

`POST /logins/<engine>/<alias>/put` `{login: {codeVerifier, state, expiresAt}, ttlMs, create?}` → `{stored}`:
keeps the login for `ttlMs` (clamped to an hour) and replaces any other for the alias. With
`create: true` a live login under the alias is left alone and the answer is `{stored: false, taken: true}`;
dario sends it for generated aliases, so two instances picking the same default cannot replace each
other. A new alias past 64 held for the engine gets `{stored: false, full: true}`. Lapsed logins are dropped on every put.

`POST /logins/<engine>/<alias>/get` `{}` → `{login}`: the login, or `null` when none is held or it lapsed.
Never writes, and does not consume the login, so a paste with the wrong state does not burn it.

`POST /logins/<engine>/<alias>/remove` `{state}` → `{removed}`: deletes the login only if its state is `state`
(`state` is required, a 400 without it). True for exactly one of two callers removing the same live
login, which is how one login is completed once; false when none is held, it lapsed, or another login
has replaced it, so a completion never deletes or spends a restarted login.

`POST /logins/<engine>/list` `{}` → `{aliases}`: the aliases with a live login, so a generated default
alias skips ones another instance is waiting on.

The verifier and state are secrets: they are stored as the account records are, in the `__pool__` object as `login:<engine>:<alias>`. A lapsed login is never served. A Durable Object alarm deletes each one at its lapse, whether or not a request follows, and re-arms for the next; the alarm fires at or after the lapse, so a delete can trail it by the platform's alarm delay. A
caller holding `LOCK_TOKEN` can complete any login it can read here, so the same care applies. An
older service answers 404, and each instance then keeps its pending logins to itself, as before.
