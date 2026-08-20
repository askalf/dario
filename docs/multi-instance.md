# Running more than one dario against the same accounts

Short answer: **you can share credentials safely between instances, but dario is not HA.** Those are different claims, and the difference matters before you scale a Deployment to 2.

This page covers what actually breaks with two instances, which part is solved, how to turn the fix on, and how to prove it works on your own infrastructure.

Raised in [#993](https://github.com/askalf/dario/issues/993).

---

## What breaks with two instances

Three things, and they fail differently.

### 1. The OAuth refresh race — **solved**

Anthropic's refresh tokens are **single-use**. Refreshing returns a new access token *and* a new refresh token, and invalidates the old one.

Two instances holding the same account both notice the token is near expiry, and both refresh. One wins. The loser's refresh token is now dead, and it has no way to know — so that instance is locked out of the account until someone runs `dario login` again. On a shared NAS or a k8s volume this is not a rare race; it is the normal outcome of two pods with synchronized clocks and the same 45-minute refresh margin.

A plain mutex does not fix this. The loser waits, acquires the lock, and then refreshes with a token that is *already* stale — it just loses more slowly. The fix is that the loser **adopts the winner's fresh credentials** instead of attempting its own. That is what dario's refresh lock does.

### 2. Rate-limit accounting — **not solved**

`pool.ts` keeps `accounts: Map<string, PoolAccount>` in process memory, and updates it only from rate-limit headers on responses *that instance* saw.

Two instances sharing an account each believe it has full headroom. Both route to it. Neither can see what the other is spending, so the pool overshoots the real 5-hour and 7-day windows and starts getting rejections it did not predict. Adding instances makes this worse, not better.

### 3. Session stickiness — **not solved**

`computeStickyKey()` hashes the first user message and pins that conversation to one account, so its prompt cache stays warm. The binding lives in process memory.

With two instances behind one Service, the same conversation can land on either, and get a different account each time. The prefix is re-cached per account, so you pay cache writes instead of reads. See [`docs/multi-account-pool.md`](./multi-account-pool.md) for why that costs real money.

---

## So what should you actually run?

| you want | do this |
|---|---|
| Zero-downtime restarts / rolling deploys | Two instances **with the refresh lock**. Brief overlap is fine; the credential race is the only thing that corrupts state, and the lock covers it. |
| More throughput from more accounts | **One instance, more accounts in the pool.** The pool is the horizontal-scaling mechanism; a second instance is not. |
| Survive a node failure | Two instances with the lock, and accept that rate-limit accounting is approximate while both are live. |
| Precise rate-limit accounting | One instance. There is no shared-state mode today. |

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

Any lock-service error — bad response, network failure, timeout — and dario proceeds with its own refresh exactly as if no lock were configured.

The lock is resilience layered on top of dario's job, not a new dependency dario's core function needs. An outage of your Redis must not stop your proxy serving traffic. The cost of that choice is that during a lock outage you are back to the plain race, so do not treat the lock as a hard guarantee.

---

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

There is no shared-state mode today, and building one is a larger change than a lock: rate-limit snapshots and sticky bindings would both have to move out of process memory, which means every routing decision takes a network hop.

If you want that, say so on [#993](https://github.com/askalf/dario/issues/993) with your deployment shape. Concrete requirements are considerably more useful than a general "make it HA" — the design depends heavily on whether you need precise accounting or merely approximate.
