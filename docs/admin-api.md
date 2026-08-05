# Headless admin API

An opt-in HTTP control plane for managing dario's account pool without console
access: provision the first account on an empty proxy, add or remove accounts
later, and read live per-account status — all over HTTP, with no `dario login`,
no TTY, and no restart. Built for the deployments where a console is the
awkward part: Docker, Kubernetes, a Raspberry Pi in a closet, a VPS you'd
rather not SSH into.

Requires dario **v4.8.111+** (the `/status` / `/health` behavior described
below is accurate as of **v4.8.117**).

## Enabling it

```bash
DARIO_ADMIN=1 DARIO_ADMIN_TOKEN=<long-random-string> dario proxy
```

| Variable | Purpose |
|---|---|
| `DARIO_ADMIN=1` | Mounts the API at `/admin/*`. Off by default — the endpoints don't exist otherwise. |
| `DARIO_ADMIN_TOKEN` | Bearer token for every admin call. Falls back to `DARIO_API_KEY` if unset. |
| `DARIO_ADMIN_RATE_LIMIT=off` | Disables the built-in rate limiting (see below). Leave on. |

Two deliberate security properties:

- **Auth is always required, even on loopback.** These endpoints add and remove
  OAuth credentials; the localhost trust shortcut the proxy key allows for LLM
  routes does not apply here.
- **Enabled-but-tokenless fails closed.** `DARIO_ADMIN=1` with neither
  `DARIO_ADMIN_TOKEN` nor `DARIO_API_KEY` set returns `403` with a message
  telling you to set the token — account control is never left open.

Admin mode also changes one startup behavior: the proxy **starts with zero
accounts** instead of exiting `Not authenticated`. Until an account exists,
LLM requests return a truthful `503 { "error": "No account configured" }` with
a hint pointing at `POST /admin/login/start`.

## Zero to serving, over HTTP only

The login flow mirrors `dario accounts add --manual` (PKCE + manual code
paste), split into two calls:

```bash
ADMIN='authorization: Bearer <your DARIO_ADMIN_TOKEN>'
BASE=http://127.0.0.1:3456

# 1. Start a login. Alias is optional — omit it and a non-colliding
#    default (account-1, account-2, …) is generated and returned.
curl -s -X POST -H "$ADMIN" "$BASE/admin/login/start" -d '{"alias":"main"}'
# -> { "alias": "main",
#      "authorize_url": "https://claude.ai/oauth/authorize?...",
#      "expires_at": "...",
#      "instructions": "Open authorize_url, approve, then POST ... to /admin/login/complete." }

# 2. Open authorize_url in any browser on any machine, approve, and copy the
#    code Anthropic displays. Paste it back ("code#state" or bare code both work):
curl -s -X POST -H "$ADMIN" "$BASE/admin/login/complete" \
  -d '{"alias":"main","code":"<pasted code>"}'
# -> { "alias": "main", "status": "added", "expires_at": "..." }
```

**The account is routable the moment the `200` lands.** `login/complete` (and
account removal) hot-reload the live pool from disk before responding — no
proxy restart, superseding the "takes effect on next restart" behavior of
early builds. The model catalog also refetches immediately with the new
account's credentials, so `/v1/models` upgrades from the baked list without
waiting out a retry window.

Pending-login mechanics, for scripting against it:

- A pending login lives **10 minutes** and is **single-use** — `/complete`
  consumes it whether or not the token exchange succeeds.
- **One pending login per alias**; a second `/start` for the same alias
  replaces the first.
- If the pasted blob carries a `state` and it doesn't match the pending
  login's, `/complete` refuses (`400 state mismatch`) — the code came from a
  different login attempt.
- An expired or unknown alias gets `410` — start a new login.
- The PKCE verifier and state never touch disk and are never returned to the
  client.

## Endpoint reference

All endpoints accept the token as `authorization: Bearer <token>` or
`x-api-key: <token>`.

| Method + path | Body | Returns |
|---|---|---|
| `POST /admin/login/start` | `{ "alias"?: string }` | `{ alias, authorize_url, expires_at, instructions }` |
| `POST /admin/login/start-needed` | `{ "threshold"?: number }` | `{ started: [...], count, truncated? }` |
| `POST /admin/login/complete` | `{ "alias": string, "code": string }` | `{ alias, status: "added", expires_at }` |
| `POST /admin/login/complete` (batch) | `{ "items": [{ "alias", "code" }, ...] }` | `{ results: [...], count, truncated? }` |
| `GET /admin/accounts` | — | `{ accounts: [...], count }` |
| `DELETE /admin/accounts/<alias>` | — | `{ alias, removed }` (`404` if no such alias) |

`GET /admin/accounts` is the monitoring surface: each entry carries the
persisted metadata (`alias`, `scopes`, `expires_in_ms`) **plus live pool
status whenever pool mode is active** — `util5h` / `util7d` utilization,
representative `claim` (e.g. `five_hour`), routing `status`,
`request_count`, and `consecutive_auth_failures`. It's the admin-token-gated
equivalent of the proxy-key-gated `GET /accounts` pool view; a headless
operator needs only the admin token to watch headroom.

## Bulk re-auth, in one round-trip

For a pool with several accounts, the round-trip of "notice one's broken,
`/start` it, `/complete` it" per account doesn't scale. Two endpoints collapse
that:

```bash
# 1. One call: every account that's actually stuck, each with a ready link.
curl -s -X POST -H "$ADMIN" "$BASE/admin/login/start-needed"
# -> { "started": [
#      { "alias": "acct-3", "authorize_url": "...", "expires_at": "...",
#        "consecutive_auth_failures": 5 },
#      { "alias": "acct-7", "authorize_url": "...", "expires_at": "...",
#        "consecutive_auth_failures": 12 }
#    ], "count": 2 }

# 2. Open each authorize_url, collect each code, complete them all in one call.
curl -s -X POST -H "$ADMIN" "$BASE/admin/login/complete" -d '{
  "items": [
    { "alias": "acct-3", "code": "<code from acct-3'"'"'s authorize_url>" },
    { "alias": "acct-7", "code": "<code from acct-7'"'"'s authorize_url>" }
  ]
}'
# -> { "results": [
#      { "alias": "acct-3", "status": "added", "expires_at": "..." },
#      { "alias": "acct-7", "status": "added", "expires_at": "..." }
#    ], "count": 2 }
```

**Why a threshold, not "any account currently cooling down."** A single
upstream 401 already puts an account into a 60-second cool-down
(`status: "auth-cooldown"` — see [multi-account-pool.md](./multi-account-pool.md)),
and that looks identical, field-for-field, to an account whose refresh token
is permanently dead. The only thing that actually separates a passing blip
from a genuinely stuck account is `consecutive_auth_failures` climbing over
several failed retries — `/admin/login/start-needed` filters on that count
(default floor: 3, roughly "failed, waited, failed again, waited longer,
failed a third time" — a few minutes of sustained failure, past what one bad
request produces), not the raw cool-down flag. Pass `{ "threshold": 1 }` to
be more aggressive, or a higher number to wait for a longer failure streak
before it's worth an operator's attention.

**No pool, no signal.** `consecutive_auth_failures` only exists once pool
mode is active (see the `poolStatus` note above); `start-needed` returns an
empty `started: []` outside pool mode rather than guessing.

**Rate limiting is per account acted on, not per HTTP call.** Both bulk
endpoints draw from the same mutation bucket as every other admin mutation —
starting or completing 10 accounts in one request costs the same 10 tokens
as 10 separate calls would. If the bucket runs dry partway through, the
response carries `truncated: true` and whatever succeeded before that point;
re-issue the same call (already-completed aliases won't be re-started —
`start-needed` only lists accounts still above the threshold) to pick up the
rest once the bucket refills.

**Batch `/complete` reports per-item, not all-or-nothing.** A bad or expired
code in one item doesn't fail the others — `results[i]` carries its own
`status: "added" | "error"`, mirroring what a solo `/complete` call for that
alias would have returned. The single-object form (`{ "alias", "code" }`,
no `items` wrapper) is unchanged and still returns the flat
`{ alias, status, expires_at }` shape.

**Not what idea 3 in #913 asked for, and doesn't need to be.** The
`redirect_uri` in `authorize_url` is Anthropic's own hosted
`https://platform.claude.com/oauth/code/callback` page, not anything dario
serves — open it in any browser on any machine, exactly as the zero-to-serving
walkthrough above already does. There's no dario-hosted callback in this flow
for a `DARIO_DOMAIN`/`DARIO_CALLBACK` variable to redirect.

## What the generic surfaces report (v4.8.117+)

`/status` and `/health` derive from the live pool whenever pool mode is
active, so they track the admin lifecycle truthfully:

| Stage | `/status` | `/health` |
|---|---|---|
| Started empty (`DARIO_ADMIN=1`, no accounts) | `authenticated:false`, `status:"none"`, hint: add one via `POST /admin/login/start` | **503** `degraded` — correct: every LLM call 503s until an account exists |
| ≥1 account added | `authenticated:true`, `status:"healthy"`, `mode:"pool"`, `accounts:N`, earliest token expiry | **200** `ok` — docker healthchecks and `depends_on: service_healthy` pass |
| All accounts in auth-cooldown (upstream 401s) | `status:"broken"`, `authenticated:false` | **503** `degraded` — the next request would fail |

If you're wiring a container healthcheck against a proxy that starts empty,
expect it to report unhealthy until the first account is provisioned — that's
the API telling you the truth, not a bug. Gate your bootstrap job on the
container being *up* (TCP/HTTP response), not *healthy*.

## Audit trail

Every mutation (`login_start`, `login_complete`, `account_remove`) and every
auth reject or throttle is logged with the action, target alias, outcome, HTTP
status, and client address — to the console always (so `docker logs` /
journald has the trail with zero setup), and as a structured
`event: "admin.<action>"` line when `--log-file` / `DARIO_LOG_FILE` is set.
Secrets never reach the audit sink.

## Rate limiting

Two global token buckets (per proxy, not per-IP — the surface is
loopback-default, so per-IP keying buys nothing), applied **after** auth for
mutations and **to failed auth attempts** separately:

- **Failed auth**: 10 burst, then 1 per 2s — a wrong-token flood is slowed,
  not answered at full speed.
- **Mutations** (`login/start`, `login/complete`, account removal): 30 burst,
  then 1 per 1s.

Over the limit returns `429` with a `Retry-After` header, and the throttle
itself is audited (`rate_limited`). Reads (`GET /admin/accounts`) and
successful auth are never throttled. `DARIO_ADMIN_RATE_LIMIT=off` disables
both buckets; the defaults are generous for a human plus scripts and only
bite runaway callers.

## Relationship to the CLI

The admin API and `dario accounts add/remove/list` manage the same on-disk
store (`~/.dario/accounts/`) and can be mixed freely. Pool mode activates at
**one** account, so a single `login/start`/`complete` round-trip on a fresh
box yields a serving proxy — `dario login` remains the single-default-account
one-liner for interactive setups and is never required on the admin path. See
[`docs/multi-account-pool.md`](./multi-account-pool.md) for how the pool
routes, and [`docs/docker.md`](./docker.md) for the container deployment this
API was built for.
