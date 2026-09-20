# Analytics, `/metrics`, and the dashboard

dario keeps two kinds of numbers. The **rolling window** (`src/analytics.ts`) lives in memory and forgets on restart: per-request records with tokens, latency, seat, model, consumer and billing claim, summarised over the last 60 minutes and since start. The **ledger** (`src/ledger.ts`, `~/.dario/ledger.json`) survives restarts: one row per day, per model, per billing bucket, priced at read time from the published rate cards.

Every surface below is a view over those two. Nothing here collects anything new.

## Surfaces

| path | what | format |
|---|---|---|
| `GET /analytics` | window summary + `queue` snapshot + `lifetime` ledger summary | JSON |
| `GET /analytics/ledger` | the ledger's per-day table | JSON |
| `GET /analytics/stream` | live tail of request records (drives the TUI) | SSE |
| `GET /metrics` | the same state as Prometheus text exposition | text/plain 0.0.4 |
| `GET /analytics/donuts.svg` | spend by model / by key / by billing | SVG |
| `GET /analytics/view` | server-rendered dashboard body | HTML fragment |
| `GET /analytics/ui` | the dashboard shell (no data; asks for the token, loads `/view` every 60 s) | HTML page |

CLI: `dario usage` prints the ledger; `--json` dumps `/analytics`; `--card[=file]` writes the share card; `--donut[=file]` writes the three rings.

## Who can read them

By default the proxy binds loopback and these paths need no credential. With `DARIO_API_KEY` set, they need the key like everything else.

`--analytics-token=<secret>` (or `DARIO_ANALYTICS_TOKEN`) adds a **read-only** credential accepted on exactly the paths in the table above, on `GET` only. It is refused on `/v1/*`, `/accounts`, `/status`, `/admin/*`, and any non-GET. That is the point: a Grafana box or a browser tab can hold the numbers without holding request rights. The root key keeps working on the analytics paths too. On an unkeyed proxy the token gates nothing, and the proxy says so at startup.

`/analytics/ui` itself is served without a credential because it contains no data. It stores the token you type in `sessionStorage` and sends it as a bearer on every fetch of `/analytics/view`.

## `/metrics` families

Names ending in `_total` are counters; everything else is a gauge. Labels are escaped per the exposition format.

| family | labels | source |
|---|---|---|
| `dario_info` | `version` | always 1 |
| `dario_requests_total`, `dario_tokens_total{kind}`, `dario_estimated_cost_usd_total`, `dario_error_rate` | `kind` ∈ input, output, cache_read, cache_create, thinking | since start |
| `dario_window_requests`, `_avg_latency_ms`, `_error_rate`, `_cached_prompt_percent`, `_estimated_cost_usd` | `window_minutes` | rolling window |
| `dario_window_billing_requests` | `bucket` ∈ subscription, subscription_fallback, extra_usage, api, unknown | claims folded by `billingBucketFromClaim` |
| `dario_account_requests_total`, `dario_account_estimated_cost_usd`, `dario_account_utilization{window}` | `account`, `window` ∈ 5h, 7d | last rate-limit headers per seat |
| `dario_model_requests_total`, `dario_model_estimated_cost_usd` | `model` | since start |
| `dario_consumer_requests_total`, `dario_consumer_estimated_cost_usd` | `consumer` (named key or `x-dario-consumer`) | since start |
| `dario_queue_active`, `_queued`, `_max_concurrent`, `_max_queued`, `_stalled`, `_max_wait_ms`, `_consumers_active` | — | request queue |
| `dario_request_latency_ms{quantile}` + `_sum`, `_count` | `quantile` ∈ 0.5, 0.9, 0.99 | nearest-rank over the most recent 1,000 records |
| `dario_queue_wait_ms`, `dario_pacing_wait_ms`, `dario_upstream_ttfb_ms`, `dario_upstream_latency_ms`, `dario_overhead_ms` — each `{quantile}` + `_sum`, `_count` | `quantile` ∈ 0.5, 0.9, 0.99 | the timing split (below), nearest-rank over the recent records that carry one |
| `dario_window_avg_upstream_ttfb_ms`, `_avg_upstream_latency_ms`, `_avg_overhead_ms`, `_avg_queue_wait_ms`, `_avg_pacing_wait_ms` | `window_minutes` | the split averaged over the rolling window; omitted until a request has carried one |
| `dario_predicted_exhaustion_minutes` (omitted when unknown), `dario_burn_tokens_per_minute`, `dario_burn_cost_usd_per_minute` | — | window predictions |
| `dario_ledger_requests_total`, `_api_equivalent_usd`, `_metered_usd`, `_recent_api_equivalent_usd{window}`, `_model_api_equivalent_usd{model,provider}`, `_model_requests_total{model,provider}`, `_consumer_api_equivalent_usd{consumer}` | `window` ∈ today, 7d, 30d | ledger (absent when the ledger is off) |

`dario_request_latency_ms` is the number dario has always kept: dispatch to response end, as the client saw it. Since 6.9 every request also carries the split below, so the one figure can be read as its parts.

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

`GET /analytics` carries the split averaged over the window and since start as `window.timing` / `allTime.timing` (`samples` says how many rows had one), `dario status` prints it under **Avg latency**, and the TUI's Analytics tab shows it beneath the same row. A ChatGPT (codex) leg records its seat's TTFB and total the same way; the governor never runs for it, so its `pacingMs` is 0.

A minimal scrape config:

```yaml
scrape_configs:
  - job_name: dario
    static_configs: [{ targets: ['127.0.0.1:3456'] }]
    authorization: { credentials: '<DARIO_ANALYTICS_TOKEN>' }
```

## The rings

`dario usage --donut` and `/analytics/donuts.svg` render the ledger's lifetime spend as three rings: **by model**, **by key** (empty until a named key or `x-dario-consumer` has traffic), and **subscription vs metered**. Each ring keeps the top five and folds the rest into *other*. Shares are of API-equivalent plus metered spend, so a model that only ever ran on an API key still shows.
