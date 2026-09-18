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
| `dario_predicted_exhaustion_minutes` (omitted when unknown), `dario_burn_tokens_per_minute`, `dario_burn_cost_usd_per_minute` | — | window predictions |
| `dario_ledger_requests_total`, `_api_equivalent_usd`, `_metered_usd`, `_recent_api_equivalent_usd{window}`, `_model_api_equivalent_usd{model,provider}`, `_model_requests_total{model,provider}`, `_consumer_api_equivalent_usd{consumer}` | `window` ∈ today, 7d, 30d | ledger (absent when the ledger is off) |

Latency here is end-to-end through dario as the client saw it. Time-to-first-token and the split between dario's own overhead and the provider's time are not recorded per request today; they are the natural next columns on `RequestRecord` if a scrape wants them.

A minimal scrape config:

```yaml
scrape_configs:
  - job_name: dario
    static_configs: [{ targets: ['127.0.0.1:3456'] }]
    authorization: { credentials: '<DARIO_ANALYTICS_TOKEN>' }
```

## The rings

`dario usage --donut` and `/analytics/donuts.svg` render the ledger's lifetime spend as three rings: **by model**, **by key** (empty until a named key or `x-dario-consumer` has traffic), and **subscription vs metered**. Each ring keeps the top five and folds the rest into *other*. Shares are of API-equivalent plus metered spend, so a model that only ever ran on an API key still shows.
