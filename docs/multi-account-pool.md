# Multi-account pool mode

Pool mode activates automatically when `~/.dario/accounts/` contains 2+ accounts. Single-account dario is unchanged.

```bash
dario accounts add work
dario accounts add personal
dario accounts add side-project
dario accounts list
dario proxy
```

If you already have a single-account `dario login` set up and run `dario accounts add <alias>` for the first time, dario **back-fills** your existing login credentials into the pool under the reserved alias `login` before running OAuth for the new alias. Net effect: your first `accounts add` gives you two pool accounts (login + new alias), pool mode activates immediately. Back-fill is one-shot, idempotent, and never touches your existing `credentials.json` — if you later `dario accounts remove` below the 2+ threshold, single-account mode reads it unchanged. Skipped if you explicitly pick `login` as the new alias — your intent wins.

Each request picks the account with the highest headroom:

```
headroom = 1 - max(util_5h, util_7d)
```

The response's `anthropic-ratelimit-unified-*` headers are parsed back into the pool so the next selection sees fresh utilization. An account that returns a 429 is marked `rejected` and routed around until its window resets. When every account is exhausted, requests queue for up to 60 seconds waiting for headroom to reappear. Plan tiers mix freely in the same pool — dario doesn't care about tier, only headroom.

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
