# Analytics, `/metrics`, and the dashboard

dario keeps two kinds of numbers. The **rolling window** (`src/analytics.ts`) lives in memory and forgets on restart: per-request records with tokens, latency, seat, model, consumer and billing claim, summarised over the last 60 minutes and since start. The **ledger** (`src/ledger.ts`, `~/.dario/ledger.json`) survives restarts: one row per day, per model, per billing bucket, priced at read time from the published rate cards.

Every surface below is a view over those two. Nothing here collects anything new.

## Surfaces

| path | what | format |
|---|---|---|
| `GET /analytics` | window summary (with `window.perFiveMinutes`, the hour in twelve bins) + `queue` snapshot + `overage` (the halt state, for a reader who cannot open `/admin/resume`) + `lifetime` ledger summary | JSON |
| `GET /analytics/ledger` | the ledger's per-day table, with `priced`: the same rows as USD at each day's rate | JSON |
| `GET /analytics/stream` | live tail of request records (drives the TUI) | SSE |
| `GET /metrics` | the same state as Prometheus text exposition | text/plain 0.0.4 |
| `GET /analytics/donuts.svg` | spend by model / by key / by billing | SVG |
| `GET /analytics/view` | the server-rendered summary (the page before 6.17; still served) | HTML fragment |
| `GET /analytics/ui` | the dashboard (no data of its own; asks for the token, then reads the routes above, `/accounts`, `/codex` and `/health` with it and tails `/analytics/stream`) | HTML page |

CLI: `dario usage` prints the ledger; `--json` dumps `/analytics`; `--card[=file]` writes the share card; `--donut[=file]` writes the three rings.

## Who can read them

By default the proxy binds loopback and these paths need no credential. With `DARIO_API_KEY` set, they need the key like everything else.

`--analytics-token=<secret>` (or `DARIO_ANALYTICS_TOKEN`) adds a **read-only** credential accepted on exactly the paths in the table above, on `GET` only. It is refused on `/v1/*`, `/accounts`, `/status`, `/admin/*`, and any non-GET. That is the point: a Grafana box or a browser tab can hold the numbers without holding request rights. The root key keeps working on the analytics paths too. On an unkeyed proxy the token gates nothing, and the proxy says so at startup.

`/analytics/ui` itself is served without a credential because it contains no data. It stores the token you type in `sessionStorage` and sends it as a bearer on every read. With the analytics token it shows spend, routing, the live feed and the ledger; the seats panel needs an API key, because `/accounts` and `/codex` refuse the read-only token, and the keys panel needs the admin API (`DARIO_ADMIN=1`, the admin token). The page loads nothing from outside the proxy, follows the system theme (with a toggle), has a table view behind every chart, and opened from disk (`dist/analytics-ui.html`) it runs on sample data.

## `/metrics` families

Names ending in `_total` are counters; everything else is a gauge. Labels are escaped per the exposition format.

| family | labels | source |
|---|---|---|
| `dario_info` | `version` | always 1 |
| `dario_requests_total`, `dario_tokens_total{kind}`, `dario_estimated_cost_usd_total`, `dario_error_rate` | `kind` ∈ input, output, cache_read, cache_create, thinking | since start |
| `dario_window_requests`, `_avg_latency_ms`, `_error_rate`, `_cached_prompt_percent`, `_estimated_cost_usd` | `window_minutes` | rolling window |
| `dario_window_billing_requests` | `bucket` ∈ subscription, subscription_fallback, extra_usage, api, credits, unknown | claims folded by `billingBucketFromClaim` |
| `dario_account_requests_total`, `dario_account_estimated_cost_usd`, `dario_account_utilization{window}` | `account`, `window` ∈ 5h, 7d | last rate-limit headers per seat |
| `dario_model_requests_total`, `dario_model_estimated_cost_usd` | `model` | since start |
| `dario_consumer_requests_total`, `dario_consumer_estimated_cost_usd` | `consumer` (named key or `x-dario-consumer`) | since start |
| `dario_queue_active`, `_queued`, `_max_concurrent`, `_max_queued`, `_stalled`, `_max_wait_ms`, `_consumers_active` | (none) | request queue |
| `dario_request_latency_ms{quantile}` + `_sum`, `_count` | `quantile` ∈ 0.5, 0.9, 0.99 | nearest-rank over the most recent 1,000 records |
| `dario_queue_wait_ms`, `dario_pacing_wait_ms`, `dario_upstream_ttfb_ms`, `dario_upstream_latency_ms`, `dario_overhead_ms` — each `{quantile}` + `_sum`, `_count` | `quantile` ∈ 0.5, 0.9, 0.99 | the timing split (below), nearest-rank over the recent records that carry one |
| `dario_window_avg_upstream_ttfb_ms`, `_avg_upstream_latency_ms`, `_avg_overhead_ms`, `_avg_queue_wait_ms`, `_avg_pacing_wait_ms` | `window_minutes` | the split averaged over the rolling window; omitted until a request has carried one |
| `dario_predicted_exhaustion_minutes` (omitted when unknown), `dario_burn_tokens_per_minute`, `dario_burn_total_tokens_per_minute`, `dario_burn_cost_usd_per_minute` | (none) | window predictions |
| `dario_ledger_requests_total`, `_api_equivalent_usd`, `_metered_usd`, `_recent_api_equivalent_usd{window}`, `_model_api_equivalent_usd{model,provider}`, `_model_requests_total{model,provider}`, `_consumer_api_equivalent_usd{consumer}` | `window` ∈ today, 7d, 30d | ledger (absent when the ledger is off) |

`dario_request_latency_ms` is the number dario has always kept: dispatch to response end, as the client saw it. Since 6.9 every request also carries the split below, so the one figure can be read as its parts.

The two token burn gauges differ in scope: `dario_burn_tokens_per_minute` is input and output only, cache reads and writes are not in it, while `dario_burn_total_tokens_per_minute` counts every kind. On a cached prompt the second is many times the first. `/analytics` carries the same pair as `predictions.tokenBurnRate` and `predictions.totalTokenBurnRate`.

## The timing split

A request's wall-clock time through dario is five stamps (`src/timing.ts`), all in milliseconds, all on dario's clock:

| leg | measures | where it shows |
|---|---|---|
| `queueMs` | waited for a `--max-concurrent` slot | `x-dario-queue-ms`, `dario_queue_wait_ms`, log `queue_ms` |
| `pacingMs` | slept in the rate governor (`--pace-min`, think-time, session-start floors) | `x-dario-pacing-ms`, `dario_pacing_wait_ms`, log `pacing_ms` |
| `upstreamTtfbMs` | first outbound byte → upstream response headers; the provider's time to first byte, failover attempts included | `x-dario-upstream-ttfb-ms`, `dario_upstream_ttfb_ms`, log `upstream_ttfb_ms` |
| `upstreamMs` | first outbound byte → upstream body fully consumed | `dario_upstream_latency_ms`, log `upstream_ms` |
| `totalMs` | request arrived at dario → response ended | log `total_ms` |

and one derived figure, **overhead** = `total − upstream − queue − pacing`: the time dario itself spent reading the body, building the template, translating shapes and relaying SSE. The two deliberate waits are reported on their own so "overhead" never has to be guessed at; it does not include them. `x-dario-prep-ms` on the response is the pre-upstream part of that overhead (arrival → first outbound byte, minus the waits), the only part known before the body starts.

The four `x-dario-*-ms` response headers ride on every served `/v1/messages` and `/v1/chat/completions` response, streamed or not, so a `curl -i` answers "was that Anthropic or dario?" without opening `/analytics`. They are added to the response dario writes to the client and change nothing on the wire to the provider; `--passthrough` stays byte-identical upstream.

`GET /analytics` carries the split averaged over the window and since start as `window.timing` / `allTime.timing` (`samples` says how many rows had one), `dario status` prints it under **Avg latency**, and the TUI's Analytics tab shows it beneath the same row. A ChatGPT (codex) leg records its seat's TTFB and total the same way and its response carries the same four headers; the governor never runs for it, so its `pacingMs` is 0.

A minimal scrape config:

```yaml
scrape_configs:
  - job_name: dario
    static_configs: [{ targets: ['127.0.0.1:3456'] }]
    authorization: { credentials: '<DARIO_ANALYTICS_TOKEN>' }
```

## The cache trace

A ChatGPT (codex) request reports how much of its prompt the backend read from its cache, and that number alone cannot say why a turn missed. dario records next to it what it can see before the request goes out that bears on a hit (`src/cache-trace.ts`). These narrow a miss down to likely causes; they do not prove one:

| field | says | a miss reads as |
|---|---|---|
| `sinceMs` | ms since the previous request on the same `prompt_cache_key`; null on the first | a write is not readable at once, so a turn close behind the last may read nothing it wrote; the gap is measured, the backend's readiness is not |
| `items`, `prevItems`, `extends` | input items now and before, and whether the previous input is a strict prefix of this one, item for item; `extends` is null when the previous input ran past the first 2000 items, which are all that is kept; input items only, the front of the prompt is `prefixChanged` | a client that rewrites or reorders its history has no prefix to hit |
| `divergedAt` | the first input item that differs, when one does | which turn the rewrite happened at |
| `prefixChanged` | the model, system prompt or tool names changed between the two; tool schemas are not compared | the front of the prompt moved, so nothing behind it can match |
| `seatChanged` | a different account served this one | the cache is per account; a conversation that moved seats starts over |

The trace is hashes and counts only: no content leaves the request. It rides on every `/analytics` row of that path as `cache` (with the `key`: dario's own derived `dario-…` key as it went out, a key the client set itself only as a `key-…` digest of it; a `/v1/responses` request goes through as the client wrote it, so it is traced under its own key, as Codex CLI sends one on every request, and carries no trace when it sent none), on the `--log-file` record as `cache_key`, `cache_items`, `cache_since_ms`, `cache_prev_items`, `cache_extends`, `cache_diverged_at`, `cache_seat_changed`, `cache_prefix_changed`, and with `--cache-trace` / `DARIO_CACHE_TRACE=1` (or `-v`) as one stdout line per request:

```
[dario] #412 cache: key=dario-3f9a2c7e1b0d44a6 seat=work since=3.1s items=23/21 extends=yes read=0/44120 (0%)
```

Read a run of them by key. `extends=yes` with `read=0`, a short `since` and no `prefix_changed` or `seat_changed` points at the backend's write delay rather than the shape of the input, but only as the likely explanation: the trace measures the gap, not when the write became readable, and `extends` compares input items only, so a changed tool schema, which the trace does not compare, misses the same way. `extends=no` with a `diverged_at` names the item the client changed; `prefix_changed` is a moved model, system prompt or tool name in front of an input that may still extend; `seat_changed` is the pool moving a conversation. The entry for a key is kept for an hour, longer than the backend keeps a prefix, so a stale key never reads as a live conversation.

## The rings

`dario usage --donut` and `/analytics/donuts.svg` render the ledger's lifetime spend as three rings: **by model**, **by key** (empty until a named key or `x-dario-consumer` has traffic), and **subscription vs metered**. Each ring keeps the top five and folds the rest into *other*. Shares are of API-equivalent plus metered spend, so a model that only ever ran on an API key still shows.
