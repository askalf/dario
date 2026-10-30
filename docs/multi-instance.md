# Running more than one dario against the same accounts

Short answer: **you can share credentials safely between instances, and with shared pool state on they also share what they know about the seats.** dario is still not a consensus system; the difference matters before you scale a Deployment to 2.

This page covers what actually breaks with two instances, which part is solved, how to turn the fix on, and how to prove it works on your own infrastructure.

Raised in [#993](https://github.com/askalf/dario/issues/993).

---

## What breaks with two instances

Three things, and they fail differently.

### 1. The OAuth refresh race — **solved**

Anthropic's refresh tokens are **single-use**. Refreshing returns a new access token *and* a new refresh token, and invalidates the old one.

Two instances holding the same account both notice the token is near expiry, and both refresh. One wins. The loser's refresh token is now dead, and it has no way to know — so that instance is locked out of the account until someone runs `dario login` again. On a shared NAS or a k8s volume this is not a rare race; it is the normal outcome of two pods with synchronized clocks and the same 45-minute refresh margin.

A plain mutex does not fix this. The loser waits, acquires the lock, and then refreshes with a token that is *already* stale — it just loses more slowly. The fix is that the loser **adopts the winner's fresh credentials** instead of attempting its own. That is what dario's refresh lock does.

The handoff has to outlast the gap between replicas, not just the race. Each instance checks its tokens every 15 minutes on its own phase, so the second one can come back well after the first refreshed. The lock service keeps the latest credentials for 30 days, and every instance reads them at startup and on each tick before deciding to refresh. Until [#1733](https://github.com/askalf/dario/issues/1733) that window was five minutes, and a replica that came back later refreshed with a dead token.

### 2. Rate-limit accounting — **solved with shared state**

`pool.ts` keeps `accounts: Map<string, PoolAccount>` in process memory, and updates it only from rate-limit headers on responses *that instance* saw.

Two instances sharing an account each believe it has full headroom. Both route to it. Neither can see what the other is spending, so the pool overshoots the real 5-hour and 7-day windows and starts getting rejections it did not predict — and each instance eats its own 429 to learn what the other already knew.

With `--pool-shared-state` every instance reports each reading it takes to the lock service and pulls the others' every two seconds, adopting any reading newer than its own. A 429 taken on one instance parks the seat on all of them within a pull; the listings say whose reading a seat carries (`readingFrom`), and `rejectedCount` stays each instance's own. The accounting is eventually consistent — a pull interval behind, never ahead — which is what makes it approximate rather than wrong.

### 3. Session stickiness — **solved with shared state**

`computeStickyKey()` hashes the first user message and pins that conversation to one account, so its prompt cache stays warm. The binding lives in process memory.

With two instances behind one Service, the same conversation can land on either, and get a different account each time. The prefix is re-cached per account, so you pay cache writes instead of reads. See [`docs/multi-account-pool.md`](./multi-account-pool.md) for why that costs real money.

With `--pool-shared-state` a binding made on one instance is published, and an instance that sees a conversation it holds no binding for asks the service before choosing — so the second turn of a conversation that started on the other replica reads the cache the first turn wrote. Failover rebindings are published the same way.

---

## So what should you actually run?

| you want | do this |
|---|---|
| Zero-downtime restarts / rolling deploys | Two instances **with the refresh lock**. Brief overlap is fine; the credential race is the only thing that corrupts state, and the lock covers it. |
| More throughput from more accounts | **One instance, more accounts in the pool.** The pool is the horizontal-scaling mechanism; a second instance is not. |
| Survive a node failure | Two instances with the lock and shared pool state; accounting is a pull interval behind while both are live. |
| Precise rate-limit accounting | One instance. Shared state is eventually consistent (a pull interval behind), not exact. |

dario starts in well under a second, so for most people a single replica with a sensible `restartPolicy` is the honest answer — which is roughly where [#993](https://github.com/askalf/dario/issues/993) landed too.

---

## Turning the refresh lock on

Two reference backends implement the identical contract. `src/accounts.ts` knows only the two environment variables — it has no idea which one is answering.

```
DARIO_REFRESH_LOCK_URL=http://<lock-host>:8080
DARIO_REFRESH_LOCK_TOKEN=<shared secret>
```

Set both on **every** instance. Unset `DARIO_REFRESH_LOCK_URL` and the code path is byte-identical to not having the feature at all.

### Redis backend — no external dependency

Use this if you are airgapped, or do not want dario's availability to depend on a third party.

```
cd redis-lock
docker build -t dario-refresh-lock .
docker run -d -p 8080:8080 \
  -e LOCK_TOKEN=<a real random value, not reused from another service> \
  -e REDIS_HOST=<your redis host> \
  -e REDIS_PORT=6379 \
  dario-refresh-lock
```

Zero new runtime dependencies — the RESP2 client is hand-rolled over `node:net` rather than pulling in `redis`/`ioredis`, so dario's zero-dependency invariant is intact. Details in [`redis-lock/README.md`](../redis-lock/README.md).

**Be clear about what this is:** a single Redis instance holding lock and credential-handoff state. It is a coordination point, not a consensus system. If Redis is down, the lock fails open (below). It does not do leader election, and it is not Raft — if you need split-brain guarantees, this is not that.

### Cloudflare backend — nothing to host

A Durable Object gives you serialized access without running anything yourself. See [`cloudflare/refresh-lock/README.md`](../cloudflare/refresh-lock/README.md).

Not suitable for airgapped deployments, and it adds an internet dependency to a component that otherwise only talks to Anthropic.

### It fails open, deliberately

On any lock-service error (bad response, network failure, timeout), dario first waits if it can. While the access token still has more than 20 minutes left, the refresh is put off to a later tick, because refreshing alone is what can strand a peer. Inside 20 minutes dario refreshes on its own, exactly as if no lock were configured.

The lock is resilience layered on top of dario's job, not a new dependency dario's core function needs. An outage of your Redis must not stop your proxy serving traffic. The cost of that choice is that an outage lasting into a token's last 20 minutes puts you back to the plain race, so do not treat the lock as a hard guarantee.

### Upgrading the lock service

The 30-day handoff and the `/peek` endpoint live in the lock service, so rebuild the Redis image or redeploy the Worker along with the dario upgrade. In either order nothing breaks: a new dario against an old service gets a 404 from `/peek` and treats it as nothing to adopt, and an old dario against a new service still gets the longer handoff on `/acquire`.

---

## Turning shared pool state on

Same service, same two variables, one more switch on every instance:

```
DARIO_REFRESH_LOCK_URL=http://<lock-host>:8080
DARIO_REFRESH_LOCK_TOKEN=<shared secret>
DARIO_POOL_SHARED_STATE=1            # or: dario proxy --pool-shared-state
DARIO_POOL_SHARED_STATE_INTERVAL_MS=2000   # optional; how often to pull peers' readings
```

Both reference backends serve the three extra endpoints (`/pool/seat/<alias>`, `/pool/seats`, `/pool/sticky/<key>/{bind,get}`); redeploy the one you run. What crosses the wire is rate-limit snapshots, aliases and hashed sticky keys — no token, no message content.

The proxy says what it is doing at startup (`Pool shared state: on (instance …, via …, pulling peers every 2000ms; fails open)`), `GET /accounts` carries a `sharedState` block (instance id, last pull, readings adopted and reported, bindings pushed and adopted, errors), and each seat says whose reading it holds in `readingFrom`. A seat parked on a peer's 429 is logged on every instance: `seat "busy" parked by peer <id>'s reading: 5h 104%, 7d 25%, claim five_hour, resets in 37m`.

It fails open like the lock: an unreachable service is one log line per outage and each instance carries on with its own state until the service answers again.

## Sharing the account list

Without it, each instance serves the accounts in its own `~/.dario/accounts/`. With `--pool-shared-accounts` the instances keep one account list in the same lock service: a replica that starts with an empty accounts directory (a second pod on a fresh volume) starts with its peers' accounts, and an account added or removed on one instance is added or removed on all of them.

```
DARIO_REFRESH_LOCK_URL=http://<lock-host>:8080
DARIO_REFRESH_LOCK_TOKEN=<shared secret>
DARIO_POOL_SHARED_ACCOUNTS=1         # or: dario proxy --pool-shared-accounts
```

Set it on every instance. It works with or without `--pool-shared-state`.

- **At startup**, before the pool loads, an instance reads the registry and merges it with its accounts directory. Per alias the newer record wins: a newer login first, then, for the same login, the later expiry. Accounts only this instance holds are published; accounts only the registry holds are written to this instance's accounts directory. The pool then loads from that directory as usual, so `/health` is ready as soon as a peer has an account.
- **Every 15 seconds** after that it merges again, and updates the running pool too: a new account joins it, newer credentials replace older ones, and a removed account leaves it. A `dario accounts add`, an admin API login or a token refresh on one instance reaches the others within one sync. An admin API login or removal is published straight away, and the other instances apply it on their next sync.
- **A removal leaves a marker** in the registry. The marker beats every login made before the removal, so an instance that was offline and still holds the old file deletes it instead of publishing it back. A login made after the removal beats the marker, and the account comes back everywhere.
- **`dario accounts remove <alias>`** publishes the removal first and deletes the file only once the service has taken it. If the service cannot be reached it removes nothing and says so, since the other instances would put the account straight back. A login made after the removal stays, in the registry or in the file here, and the command says so; run it again to remove that login too. If the file here can't be deleted, the command says so and exits non-zero, and this instance keeps serving the account until the file goes.

The proxy says it is on at startup (`Pool shared accounts: on (via …, syncing every 15s; fails open)`), and `GET /accounts` carries a `sharedAccounts` block: the last sync and the last good one, how many accounts and removal markers the registry holds, the files this instance saved and removed from it, the accounts and removals it published, and errors. Each change is logged: `added account "work" (wo***@example.com) from the registry`, `removed account "spare"; it was removed on another instance`, `published account "home" to the registry`.

Before turning it on:

- **The registry holds every seat's credentials, refresh tokens included, and they do not expire there.** That is what lets a new replica start with no files. Guard the lock service like the accounts directory itself: a real random `DARIO_REFRESH_LOCK_TOKEN`, the service on a private network, and a Redis that nothing else uses. Anyone who can read that Redis or the Durable Object can use every subscription in the pool.
- **Aliases are one namespace across all instances.** Two instances that each log a different subscription in under the same alias (`login`, most often) keep only the newer login, and the instance whose account was replaced logs it loudly: `account "login" here was ... and is now ...; aliases are shared across instances, so give each subscription its own alias`. Give each subscription its own alias.
- **Clocks have to agree.** The newer login and removal rules compare wall-clock times taken on different machines. Run NTP; Kubernetes nodes do by default.
- **Claude seats only.** ChatGPT accounts stay per instance, and the switch is off under `--no-claude-auth`.
- **It fails open.** With the service unreachable, each instance serves the accounts on its own disk and logs once per outage. A removal made while it is down is published when it answers again; if the instance restarts before then, that removal is lost and the account comes back from the registry, so remove it again.
- **Upgrade the lock service.** The `/accounts/*` endpoints are new: rebuild the Redis image or redeploy the Worker. An older service answers 404, which an instance logs as the service being unreachable and then serves its own disk, so nothing breaks, but nothing is shared either.

## Proving it works on your own setup

Do not take the above on trust. `test/integration/dual-instance-race.mjs` runs the real scenario: **two genuinely separate `node` processes**, each with its own isolated `~/.dario`, sharing nothing but the lock service, both racing to refresh the same account at the same instant.

```
npm run test:refresh-lock-race
```

Point it at your own lock service by setting `DARIO_REFRESH_LOCK_URL` / `DARIO_REFRESH_LOCK_TOKEN` first.

**Run it both ways.** The flag is the useful part:

```
node test/integration/dual-instance-race.mjs --no-lock   # reproduce the failure
node test/integration/dual-instance-race.mjs             # show it prevented
```

Without the lock you should watch one instance end up holding a dead refresh token. With it, the loser adopts the winner's credentials and both keep working. Seeing the failure first is what makes the fix mean something.

Anthropic's token endpoint is the one mocked part, and only that — hammering the real endpoint with production credentials for adversarial testing risks burning your actual refresh token. The lock calls, the two processes, the isolated homes and the race itself are all real.

---

## If you need true HA

Everything above is as far as dario goes today: shared credentials through the lock, shared rate-limit readings and sticky bindings through `--pool-shared-state`, and a shared account list through `--pool-shared-accounts`, all eventually consistent and all failing open. Without `--pool-shared-accounts` the account list is per instance too, and copying the account files to every instance is safe with the refresh lock on: the copies share one refresh token, and whichever instance refreshes first hands the result to the others ([#1733](https://github.com/askalf/dario/issues/1733)). Without the lock, copies race exactly as described in section 1. Three things are still per instance:

- **ChatGPT seats.** The Codex accounts have their own refresh flow and usage windows; neither the lock nor the shared state covers them.
- **The ledger.** Each instance writes its own file, so `dario usage` and `/analytics` show that instance's share of the spend.
- **The overage guard's halt**, which each instance tracks on its own.

A design where every routing decision reads Redis on the request path is not planned: it adds a network hop per request and turns the coordination point into a hard dependency, which is exactly what the fail-open rule avoids. Extending the report-and-pull model to the ChatGPT seats is the natural next step. If you need it, say so on [#1733](https://github.com/askalf/dario/issues/1733) with your deployment shape: replica count, Claude only or both plans, and whether accounting has to be exact or may lag a pull interval.
