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

## In-flight 429 failover

When a Claude request hits a 429 mid-flight, dario retries the *same request* against a different account before the client sees an error. The client sees one successful response; the pool sees the rejected account go cold until its window resets. Combined with session stickiness, long agent runs survive pool-level exhaustion without dropping user-facing turns.

## Inspection

```bash
curl http://localhost:3456/accounts     # per-account utilization, claim, sticky bindings, status
curl http://localhost:3456/analytics    # per-account / per-model stats, burn rate, exhaustion predictions
```

Every request carries a `billingBucket` field (`subscription` / `subscription_fallback` / `extra_usage` / `api` / `unknown`) so you can see which bucket each request billed against and a `subscriptionPercent` headline number tells you at a glance whether dario is actually routing through your subscription or silently falling to API overage.
