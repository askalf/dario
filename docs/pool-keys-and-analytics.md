# Many seats, one endpoint

**Every dario is a pool.** A plain `dario login` is a pool of one; there is no separate mode to switch on. Hold more than one seat — a personal Max and a work Max, a couple of Pros, team seats — and the same `localhost:3456` routes every request to whichever seat has the most headroom, live, per request.

```bash
dario accounts add work
dario accounts add personal
dario proxy
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../.github/readme/tui-accounts-dark.svg">
  <img alt="The dario TUI Accounts tab: a table of pooled seats (work, personal, side) with token expiry, 5-hour and 7-day utilization, and status." src="../.github/readme/tui-accounts-light.svg" width="100%">
</picture>

Three things it does that a round-robin doesn't:

- **Per-model headroom routing.** Anthropic meters each model family separately: a `5h` bucket, a `7d` bucket and a per-model `7d_<family>` bucket. dario reads all of them off every response and routes each request by the bucket that governs it — an Opus call to the seat with Opus room, a Sonnet call to the seat with Sonnet room, independently. Plan tiers mix freely; dario cares about headroom, not tier.
- **Session stickiness.** Claude's prompt cache is scoped to `{account × cache key}`, so rotating a long conversation across seats on headroom alone re-pays cache-create every turn, a **5–10× token-cost multiplier** on the cached portion. dario pins each conversation to one seat (hashed from its first message, deterministic) for the life of the session and rebinds only when that seat is exhausted.
- **In-flight 429 failover.** A seat hits its wall mid-request and dario retries the *same request* against the next-best seat before your client ever sees an error. The sticky binding follows, so the next turn doesn't re-select the cold one. A seat parked on a 429 rejoins the pool on its own when its window resets.

<img src="../.github/readme/pool.jpg" alt="Three pooled seats, work, personal and side, each with a headroom bar. dario routes the request to the seat with the most headroom." width="100%">

`--pool-strategy=fill-first` concentrates new conversations on one seat until it drains, for primary/backup setups; `--pool-strategy=expiring-first` fills in order of each seat's 7-day reset, soonest first, so capacity that expires soonest is spent first. `--pool-headroom-floor=5%` (env `DARIO_POOL_HEADROOM_FLOOR`, config `pool.headroomFloor`; default 2%) moves the line at which a seat counts as drained: a sticky session rebinds off it and new conversations skip it once its headroom is at or below the floor, so a seat that answers with API errors in its last percent is left alone before the 429, not at it. Refresh tokens expire about 28 days after the original grant regardless of rotation, so every seat's grant age is tracked and surfaced in `dario accounts list`, `dario doctor` and `GET /accounts` before it becomes a silent outage. Provision over HTTP with the headless [admin API](admin-api.md); pin one request to one seat with `dario accounts check <alias>` (admin API required: `DARIO_ADMIN=1` and a `DARIO_ADMIN_TOKEN`). Internals and the live `/accounts` + `/analytics` endpoints: [multi-account-pool.md](multi-account-pool.md); covered end-to-end by [`test/pool-e2e.mjs`](../test/pool-e2e.mjs).

## One key per developer

A shared dario serves several people through one `DARIO_API_KEY`, and nothing says whose traffic is whose except a header any client can set. Since 6.8 a **named key** ties attribution to the credential:

```bash
dario keys create alice
dario keys create bob --seat=bobs-max --models=claude-sonnet-5,claude-haiku*
```

Since 6.10 a key can carry a **daily budget** — `--budget=$5/day`, `--budget-tokens=2M/day` — read from the ledger, refused with a `429` and a `retry-after` at UTC midnight, with the headroom on every response as `x-dario-budget-*` headers ([details](keys.md#budgets)). The secret is printed once and only its hash is kept, in `~/.dario/keys.json`. The request authenticated with alice's key *is* alice's in `/analytics`, in the ledger (`dario usage --by-key`) and on every log line; a key can prefer one pool seat (taken while it has headroom, normal routing otherwise, so a developer's conversations ride their own subscription) and can be held to a model allowlist (`403` before anything goes upstream, in either wire shape). The running proxy picks up a created, rotated or revoked key on its next request; the root `DARIO_API_KEY` keeps working beside them; `/admin/keys` does the same over HTTP. Details: [keys.md](keys.md).

## Watch it happen

Type `dario` with no arguments for a full-screen control panel: live request stream, per-model burn rate, rate-limit utilization per seat, billing-bucket breakdown, and an in-place config editor that writes `~/.dario/config.json`. Pure ANSI, zero new runtime deps. <kbd>Tab</kbd> moves between tabs, <kbd>r</kbd> refreshes, <kbd>R</kbd> resumes a halted overage guard, <kbd>q</kbd> quits.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../.github/readme/tui-analytics-dark.svg">
  <img alt="The dario TUI Analytics tab: requests per minute, tokens in and out, thinking tokens, average latency, subscription percentage, the lifetime API-equivalent spend from the ledger, a per-model bar chart, per-account rate-limit bars for the 5-hour and 7-day windows, and a billing breakdown." src="../.github/readme/tui-analytics-light.svg" width="100%">
</picture>

<sub>Both screenshots are rendered from the real TUI against a fixture proxy by <a href="../scripts/readme/tui.mjs"><code>scripts/readme/tui.mjs</code></a>, so a layout change shows up here instead of rotting a mock-up. The numbers are illustrative; the pixels are not.</sub>

## What it would have cost

The rolling window forgets on every restart; the **ledger** does not. Since 6.6 dario keeps one small row per day, per model, per billing bucket in `~/.dario/ledger.json` — request counts and the four token buckets, never a price — and prices them at read time from the published API rate cards (Anthropic's, and OpenAI's for the ChatGPT leg), so a pricing correction reprices history instead of freezing the old number in. `dario usage` opens with it, `/analytics` carries it as `lifetime`, the TUI shows it as **API-equivalent**, and it reads from the file when the proxy is down:

```
  API-equivalent spend (since 2026-09-11, 3 days, 1,515 requests):
    $413 would have been billed on the metered API — covered by subscriptions
      Claude       $388   1,204 reqs   (Opus 5 $301 · Sonnet 5 $86.68)
      ChatGPT    $24.75     311 reqs   (gpt-5.6-terra $24.75)
    Today $48.20 · Last 7d $413 · Last 30d $413
```

Only served requests count. Traffic that was metered anyway — an API key upstream, or Anthropic's paid `extra_usage` overage — is kept in its own column and reported as spent, not saved. `dario usage --card` writes the headline as a 640×320 SVG you can drop in a README or a post, and `--donut` writes the same number as three rings — by model, by key, subscription vs metered; `--no-ledger` / `DARIO_LEDGER=0` turns the file off, `DARIO_LEDGER_PATH` moves it, and `GET /analytics/ledger` is the per-day table behind the number. Details: [api-equivalent-spend.md](api-equivalent-spend.md).

**Scrape it, or open it.** `GET /metrics` is the same state as Prometheus text exposition — window, seats, models, consumers, queue, latency quantiles, burn rates, ledger — so Grafana reads dario like anything else. Since 6.9 every request also carries its **timing split**: queue wait, governor sleep, the provider's time to first byte, the provider's total, and what is left — dario's own overhead — as `x-dario-*-ms` response headers on the request itself, as `window.timing` on `/analytics`, and as five more `/metrics` families, so "was that Anthropic or the proxy?" is a `curl -i` away ([details](analytics.md#the-timing-split)). `GET /analytics/ui` is a self-contained dashboard page with the headline, the rings and the tables, refreshing every minute. Both sit behind the same gate as `/analytics`; `--analytics-token` (env `DARIO_ANALYTICS_TOKEN`) adds a **read-only** credential accepted on those paths and nowhere else, so a scraper or a browser can hold the numbers without holding request rights. Families and the gate: [analytics.md](analytics.md).

---

[← README](../README.md) · [all reference docs](../README.md#reference)
