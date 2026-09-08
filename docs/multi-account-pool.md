# The account pool

As of v5.0 the account pool is dario's one credential model. A plain `dario login` is a **pool of one** (materialized as `~/.dario/accounts/login.json` under the reserved `login` alias); adding accounts just makes it a pool of many. There's no separate single-account mode — a pool of one and a pool of many run the identical request path.

```bash
dario login                     # a pool of one
dario accounts add work         # now a pool of two
dario accounts add personal
dario accounts list
dario proxy
```

Your `dario login` credentials materialize into the pool automatically — on `dario login` itself, and again on `dario proxy` startup as a safety net. `~/.dario/credentials.json` is left in place; the back-fill is a one-way copy, never a move. If you run `dario accounts add <alias>` on top of a login-only setup, the `login` account is already in the pool, so you simply gain the new alias alongside it. Picking `login` as an explicit alias is your call — dario won't clobber it.

Each request picks the account with the highest headroom:

```
headroom = 1 - max(util_5h, util_7d)
```

The response's `anthropic-ratelimit-unified-*` headers are parsed back into the pool so the next selection sees fresh utilization. An account that returns a 429 is marked `rejected` and routed around until its window resets. When every account is exhausted, requests queue for up to 60 seconds waiting for headroom to reappear. Plan tiers mix freely in the same pool — dario doesn't care about tier, only headroom.

## Routing strategy

Headroom spreading is the default and stays the right call when every seat is equal. `--pool-strategy=fill-first` (env `DARIO_POOL_STRATEGY`, config `pool.strategy`) flips to concentration: new conversations land on the **alphabetically-first** eligible seat until its headroom drains to the 2% floor, then spill to the next alias in line. Failover follows the same order — after a 429 the retry goes to the next alias, not the max-headroom seat.

Two situations where that beats spreading:

- **Primary/backup seats.** A `z-backup` account stays completely untouched — fresh 5h and 7d windows — until `a-main` is actually drained. Headroom spreading would nibble at both from the first request.
- **Cache concentration.** Every fresh conversation lands where the prompt-cache pressure already is, so the spill seat's windows are fully fresh when the primary hits its wall.

Alias order is the operator's knob: name seats `1-main` / `2-overflow` to pick the fill order. Strategy only decides where **unbound** conversations land — sticky bindings (below) behave identically in both modes, and a conversation bound to a seat stays there until that seat is rejected, expiring, or under the floor.

## Session stickiness

Multi-turn agent sessions pin to one account for the life of the conversation, so the Anthropic prompt cache isn't destroyed by account rotation between turns.

**The problem.** Claude prompt cache is scoped to `{account × cache_control key}`. When the pool rotates a long agent conversation across accounts on headroom alone, turn 1 builds a cache entry on account A, turn 2 lands on account B and reads nothing from A's cache — paying full cache-create cost again. For a long agent session that's a **5–10× token-cost multiplier** on every turn after the first.

**The fix.** Dario hashes a conversation's first user message into a 16-hex-char `stickyKey` (SHA-256 truncated, deterministic) and binds the key to whichever account `select()` would have picked on turn 1. Subsequent turns re-use that account as long as it's still healthy (not rejected, token not near expiry, headroom > 2%). On 429 failover, dario rebinds the key to the new account so the next turn doesn't re-select the exhausted one. 6h TTL, 2,000-entry cap, lazy cleanup. No client cooperation required.

## Pool-exhausted fallback

`--pool-fallback=<models>` (env `DARIO_POOL_FALLBACK`, config `poolFallback.model`) is a strictly opt-in escape hatch for when a provider can't serve. A request the Claude pool can't take — at selection time, or after a mid-flight 429 with no peer left — is served as the nominated model by whichever provider can, instead of returning the 429/503.

The value may be a **chain**, read left to right, each provider taking the first entry it can actually serve:

```bash
dario proxy --pool-fallback=gpt-5.6-sol,claude-sonnet-5
```

- Claude pool drained → served as `gpt-5.6-sol` from your ChatGPT subscription.
- Subscription rate-limited or down → handed back to the Claude pool as `claude-sonnet-5`.

Neither subscription hitting its ceiling can take the deployment down on its own. A single-entry chain is one-way and behaves exactly as it did before v6.0.0.

**Since v6.0.0 a subscription is a first-class failover target**, on both wire shapes. Before that the only target was an api-key backend on `/v1/chat/completions`, which made failover inert for anyone whose second provider is a ChatGPT plan — and left Anthropic-shape clients (Claude Code, the Anthropic SDKs, agent runtimes) with nowhere to go at all.

Deliberate limits:

- **Only a 429 or 5xx fails over.** A 400 surfaces to the client. A bad request that fails over just reproduces itself on the other provider and buries the real cause.
- **The Claude entry is validated positively, against the live catalog.** "Not a codex slug" would also match a typo, or a model meant for a third provider, and swapping that in trades a recoverable 429 for an unrecoverable 404. Worse, when model discovery degrades the codex slug list arrives EMPTY, at which point elimination would call *every* entry Claude-servable. So each entry is tested for what it is rather than what it isn't: canonical ids, `[1m]` variants, catalog shorthands (`opus`, `sonnet1m`) and explicit `claude:` / `anthropic:` prefixes all qualify; anything else is skipped and the real error surfaces.
- **The api-key backend is still OpenAI-shape only.** There is no Messages translation on that route. A Codex account has one, which is why it is preferred.
- **Never silent.** Every substituted response carries `x-dario-pool-fallback: <model>`. A quietly swapped model is exactly the surprise this project exists to avoid.
- **Empty pool still errors.** A pool with zero accounts is a setup mistake (`dario login` never ran); that returns the usual 503 rather than silently re-billing every request to another provider.
- **Strictly opt-in.** Without the flag, a drained pool returns its honest 429/503.

`dario doctor` reports which state you are actually in — including *armed but INERT*, meaning a fallback is configured with no provider able to serve it:

```
[ OK ]  Failover   symmetric: gpt-5.6-sol → claude-sonnet-5, across 1 Codex account
[WARN]  Failover   armed (gpt-5.6-sol) but INERT — no Codex account and no backend
                   to fall back to. Add one: `dario add altman`
```

An api-key backend still works as a target, on the OpenAI path:

```bash
dario backend add openrouter --key=sk-or-... --base-url=https://openrouter.ai/api/v1
dario proxy --pool-fallback=openrouter/anthropic/claude-3.5-sonnet
```

## In-flight 429 failover

When a Claude request hits a 429 mid-flight, dario retries the *same request* against a different account before the client sees an error. The client sees one successful response; the pool sees the rejected account go cold until its window resets. Combined with session stickiness, long agent runs survive pool-level exhaustion without dropping user-facing turns.

## Inspection

```bash
curl http://localhost:3456/accounts     # per-account utilization, claim, sticky bindings, status
curl http://localhost:3456/analytics    # per-account / per-model stats, burn rate, exhaustion predictions
```

## Reading a seat's `status`

`GET /accounts` (and the admin API's `GET /admin/accounts`, in snake_case) report one `status` per seat. It is the routing verdict, and every value comes with the fields that explain it. Next to it, `action` is the last column of this table in one word: `none`, `wait` (the seat comes back on its own; `resetInMs` says when) or `regrant` (an auth-failure streak, which is a dead refresh token).

| `status` | What it means | What to do |
|---|---|---|
| `allowed` | The seat's last response was a 200 with headroom. `util5h` / `util7d` are that response's reading — a ratio against 1.0, so `0.42` is 42% — `lastObservedAt` / `utilAgeMs` say how old it is, `resetAt` / `resetInMs` when its representative window rolls. | Nothing. |
| `rejected` | The seat's last response was a 429 **that named an exhausted window**: `claim` says which (`five_hour`, `seven_day`, …) and the reading is at or past the 1.0 threshold — `util5h: 1.04` is 104% of the five-hour window, not 1%. `rejectedCount` / `lastRejectedAt` say the seat was tried — a 429 serves nothing, so `requestCount` does not move — and `resetInMs` says how long it stays parked. Requests route around it; it returns on its own when the window rolls. | Nothing — the window clears itself. If the reading surprises you (your usage page for that account says 0%), the token belongs to a different organization than the page you are looking at, or to the same organization as another seat: the reading is Anthropic's own, taken on that token. `dario accounts check <alias>` asks the seat directly. |
| `unknown` | No current observation: a seat that has served nothing yet, or a rejection whose window has rolled (`resetInMs: 0`) and that nothing has measured since. | Nothing; the next request measures it. |
| `auth-cooldown` | Upstream answered 401/403 or `invalid_grant`. `consecutiveAuthFailures` tells a blip (1) from a dead refresh token (a streak); the cool-down doubles with the streak, from 1 minute to 30. | A streak means re-grant the seat — `dario accounts remove` + `add`, or the admin login flow under the same alias. A new grant starts the seat fresh: no carried-over cool-down, rejection or identity. See [Refresh-token grant age](#refresh-token-grant-age) for the 28-day wall behind most streaks. |

**A 429 that names no exhausted window is not a parking.** A rejection whose headers show no claim, or a claim with utilization nowhere near 1.0 (`5h 0%, 7d 0%, claim unknown`), is a refusal of some other kind — concurrency, an account-level lock, a monthly credit — and the `reset` it states is not this seat's window rolling. Until 6.0.39 the status code alone decided, and a seat on the fleet box was parked for 546 hours on exactly that reading. Such a seat now cools for the response's own `retry-after` (or one minute) and stays probeable; the log says so: `429 without an exhausted window (5h 0%, 7d 0%, claim unknown; stated reset in 546h 49m not honoured) — cooling 1m, seat stays probeable`.

**When every seat is parked.** A pool whose seats are all `rejected` inside live windows does not probe them again: dario answers the request itself with `429`, `retry-after` set to the earliest reset, `x-dario-upstream-rejection: pool_parked`, and nothing sent upstream. One log line marks the transition (`pool parked: all 6 seats are over their rate-limit windows, earliest resets in 21m`). Before 6.0.35 every such request re-probed the earliest-reset seat, so `rejectedCount` on that seat grew by one per request — a seat reading `rejected_count: 500` next to `request_count: 1` was that, not a seat that needed a re-login. With a `--pool-fallback` armed, the request goes to the fallback instead, as before.

The proxy logs every parking as it happens, once per window: `rate limited (429) on account "spare": 5h 104%, 7d 25%, claim five_hour, resets in 37m — parked until the window rolls`. The re-probes the all-exhausted fallback makes of an already-parked seat are logged only under `-v`.

`dario accounts list --live` prints the same view from the running proxy — status with its countdown, the reading and its age, requests served and 429s answered, the organization, shared windows, grant age — where the plain `dario accounts list` only knows what is on disk.

## One subscription under two aliases

A pool of six is only six accounts if the six tokens belong to six accounts. Two aliases granted from the same account share one set of windows and one set of limits — the pool routes on real headroom either way, and the duplicate simply parks on the first 429 until the window rolls, but the operator should know.

dario knows it from the token itself. At grant time (`dario accounts add`, the admin login, the keychain import, the `login` back-fill) it reads the token's OAuth profile and records the **account uuid** — plus the masked email and the organization's tier fields — on the seat's record. A record written before this exists is filled in on its next token refresh.

- **`accountId`** / **`accountEmail`** — who the token is. Two seats with the same `accountId` are the same account, full stop.
- **`sameAccountAs`** (and `sharesWindowWith`, the same list under its original name) — the other aliases that are this account.
- **`organizationId`** — the `anthropic-organization-id` the seat's responses carry. Several accounts can share an organization (a Team) and still have their own windows: *organization* is not *account*.

Until 6.0.38, `sharesWindowWith` was **inferred**: two seats whose last readings named the same window (`claim@reset`) were called one subscription, on the assumption that independent windows never share a reset second. They do — Anthropic aligns the five-hour reset to a 20-minute grid, so a window has 15 possible reset seconds and a pool of 18 seats collides by pigeonhole. That inference told an operator seven independent colleagues were one subscription (dario#1263). It is gone; nothing is claimed that the token did not say.

Both facts are on `GET /accounts` (`distinctAccounts` — and `distinctWindows`, kept for readers of the older payload — count the accounts the pool really has), on `GET /admin/accounts` as `account_id` / `account_email` / `same_account_as`, in `dario accounts list --live`, and on the `Accounts` row of `dario doctor`. The proxy also says it once per pair at start-up: `seats "busy" and "twin" are the same account (ma***@example.com)`.

## Client identity: what a seat presents as

Every request carries `metadata.user_id` — a client identity (`device_id`, `account_uuid`) that Claude Code derives from its install, and that Anthropic ties the bearer token to. dario stores one per seat.

Before 6.0.39 every add path copied the **machine's** Claude Code identity into every alias when Claude Code was installed. On a machine running a pool of colleagues' tokens that meant eighteen different accounts all presenting one identity — and one operator's seats parking on rate-limit readings that no colleague's own usage page reflected (dario#1244).

Now a new alias takes the local Claude Code identity only when no other alias holds it, or when the holder is proven (same `accountId`) to be the same account; otherwise the alias gets its own, exactly as a machine without Claude Code always did. Existing seats are not rewritten behind your back. To see what each seat presents, and which seats share one identity across different accounts:

```
dario accounts identity                      # per-seat report
dario accounts identity --fresh <alias>...   # give these seats their own
dario accounts identity --fresh --all
```

The running proxy presents a rewritten identity on the seat's next request; no restart. `dario doctor` warns on the `Client identity` row when seats share one across different accounts.

## Consumers: who a request is for

A pool shared by a team serves several people through one `DARIO_API_KEY`, and until now nothing said whose traffic went where. A request can now name its consumer, and dario attributes and, optionally, paces by it:

- **`x-dario-consumer: <name>`** — one printable token, up to 64 characters, no spaces. Set it per user in whatever fronts dario (LiteLLM's per-key headers, a reverse proxy, the client itself). This is the name the per-consumer cap keys on.
- **Without the header**, attribution falls back to a hash of the body's user id: the Anthropic `metadata.user_id` (Claude Code sends `user_<hash>_account_<uuid>_session_<uuid>`; the session part is dropped, so one person is one key across sessions) or the OpenAI `user` field. The key is `u_` plus twelve hex characters — no account id or raw user id becomes an analytics key. The fallback is attribution only: the body is parsed after the concurrency slot is taken, so only the header can pace.

Where it shows: `GET /analytics` gains `perConsumer` (requests, tokens, cache share, estimated cost, the seats the consumer landed on, last model) next to `perAccount`; every request log line and the `-v` usage line carry `consumer`; the TUI's Hits tab shows it on the selected request.

**Fairness.** `--max-concurrent-per-consumer=N` (`DARIO_MAX_CONCURRENT_PER_CONSUMER`) caps in-flight requests per named consumer. A consumer at the cap waits in the queue while slots are free for everyone else; when a slot frees, the first waiter whose consumer is under its cap is admitted, so one heavy user's backlog never holds up another user's next turn. Requests that name no consumer are never capped. Off by default — the plain `--max-concurrent` ceiling still applies to everyone together.

Every request carries a `billingBucket` field (`subscription` / `subscription_fallback` / `extra_usage` / `api` / `unknown`) so you can see which bucket each request billed against and a `subscriptionPercent` headline number tells you at a glance whether dario is actually routing through your subscription or silently falling to API overage.

## Refresh-token grant age

A token refresh keeps the access token fresh. It does not move the wall on the refresh token: Anthropic expires the refresh-token family about **28 days after the original OAuth grant**, rotation or not. A seat that refreshed every 8h for four weeks still died with `invalid_grant "Refresh token expired"` 28d 10h after its grant (2026-09-05), and every request on it failed over silently.

dario records `grantedAt` on every grant (`dario login`, `dario accounts add`, the admin login flow), preserves it across refreshes, and ages it everywhere the pool is inspected:

```bash
dario accounts list        # "grant 12d old, ~16d to the ~28d wall" under each seat
dario doctor               # "Refresh grant" row: warn at 21d, fail at 26d, info when unknown
curl http://localhost:3456/accounts   # grantedAt, grantAgeDays, grantLevel, refreshWallAt, daysToWall per seat
curl http://localhost:3456/health     # refreshGrant: { level, oldestAgeDays, daysToWall, seats } (trusted callers)
```

The proxy also warns on stderr and sends an OS notification when a seat crosses `warn` or `urgent` (once per level, repeated daily while it stays there). A seat minted before this field existed, or imported from a Claude Code keychain, reports `unknown` — re-grant it to start the clock.

Re-grant a seat before the wall with `dario accounts add <alias>` (remove the old entry first) or `dario login --force-reauth` for the `login` seat. Thresholds: `DARIO_REFRESH_GRANT_LIFETIME_DAYS` (28), `DARIO_REFRESH_GRANT_WARN_DAYS` (21), `DARIO_REFRESH_GRANT_URGENT_DAYS` (26).
