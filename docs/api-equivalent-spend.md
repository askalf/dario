# API-equivalent spend — the ledger

What the traffic dario has served would have cost on the metered API, kept
across restarts. `dario usage` opens with it; `/analytics` carries it as
`lifetime`; the TUI's Analytics tab shows it as **API-equivalent**.

## Why a file

`/analytics` is a rolling in-memory window: 10k records, gone on restart. It
answers "what is this costing me right now" and could never answer the
question a subscription user actually has — what has this saved me since I
set it up. The ledger is the persistent half. It is deliberately small: one
row per UTC day, per model, per billing bucket, holding a request count and
the four token buckets (input, output, cache read, cache write). Nothing else.

It never stores a price. Rows are priced when read, at the rate in effect on
the row's day, from the same tables the rolling window uses (`PRICING` for
Claude, `OPENAI_PRICING` for the ChatGPT leg, both in `src/analytics.ts`).
Pricing has been wrong twice in this repo (#1047, #1048); a stored dollar
figure would have frozen the wrong number in, a stored token count gets
repriced the moment the table is fixed.

## What counts

Only responses with a 2xx status. A 429 carries no tokens and a 5xx bills
nothing.

Two columns per row:

- **covered** — served against a subscription: every Anthropic subscription
  claim (`five_hour`, `seven_day`, their `_fallback` and `_overage_included`
  forms), the ChatGPT leg, and a 2xx that carried no claim at all (a stream
  cut before the headers were read, api-key mode without the header). The
  API-equivalent cost of this column is the headline — the invoice that never
  arrived.
- **metered** — billed per token anyway: an API key upstream (`api`) or
  Anthropic's paid overage (`overage` → `extra_usage`). That money was spent.
  It is reported on its own line ("Paid per token on top") and never counted
  as saved.

A mid-stream continuation (6.1) is two upstream requests and records as two
rows, one per provider, each with the tokens that leg actually consumed.

## Where it lives

`~/.dario/ledger.json` for a proxy on the default port; `ledger-<port>.json`
for any other, so two instances sharing a home (a live-test rig next to
production) do not overwrite each other. `DARIO_LEDGER_PATH=<file>` moves it;
`--no-ledger` / `DARIO_LEDGER=0` turns it off, after which `/analytics`
reports `lifetime: null`, `/analytics/ledger` is a 404 and `dario usage` says
so.

Writes are debounced (3 s after the last record) and durable — temp file,
fsync, rename, directory fsync, the same path the credential store uses
(#790). The shutdown hook flushes what the debounce still holds, so a
`docker rm -f` loses at most the last few seconds. A file that will not parse
is moved aside as `ledger.json.corrupt-<ts>` and the ledger starts fresh; it
is never overwritten in place. Days past 730 roll off the front.

The test suite pins `DARIO_LEDGER_PATH` to a temp directory, so a suite run
does not add stub traffic to the operator's file.

## Reading it

```
$ dario usage
  API-equivalent spend (since 2026-09-11, 3 days, 1,515 requests):
    $413 would have been billed on the metered API — covered by subscriptions
      Claude       $388   1,204 reqs   (Opus 5 $301 · Sonnet 5 $86.68)
      ChatGPT    $24.75     311 reqs   (gpt-5.6-terra $24.75)
    Today $48.20 · Last 7d $413 · Last 30d $413
    Paid per token on top (API key / extra usage): $1.10
```

The proxy's view is preferred (it holds records the debounce has not flushed
yet); with no proxy on the port, the command reads the file the proxy on that
port would write. `--card[=file.svg]` renders the headline as a 640×320 SVG
(default `dario-api-equivalent.svg`) — plain system monospace, nothing to
fetch, so it looks the same in a README and a screenshot. `--json` is the raw
`/analytics` payload, `lifetime` included.

`GET /analytics` → `lifetime`:

```json
{
  "path": "/root/.dario/ledger.json",
  "since": "2026-09-11T02:14:09.000Z",
  "days": 3,
  "requests": 1515,
  "apiEquivalentCost": 412.87,
  "meteredCost": 1.1,
  "tokens": { "input": 1204000, "output": 388000, "cacheRead": 91200000, "cacheCreate": 4100000 },
  "perProvider": { "anthropic": { "requests": 1204, "apiEquivalentCost": 388.12 }, "openai": { "requests": 311, "apiEquivalentCost": 24.75 } },
  "perModel": { "claude-opus-5": { "provider": "anthropic", "requests": 900, "apiEquivalentCost": 301.44, "meteredCost": 1.1, "...": "token totals" } },
  "recent": { "today": 48.2, "last7d": 412.87, "last30d": 412.87 }
}
```

`GET /analytics/ledger` is the file itself: `{ path, version, since, updated,
days: { "YYYY-MM-DD": { "<model>": { covered: {…}, metered: {…} } } } }`.

## Pricing on the ChatGPT leg

Before 6.5 a `gpt-*` row fell through to the Claude fallback rate and the
"would-be API cost" of a ChatGPT-plan request was Anthropic's Sonnet 4.6
price for a model Anthropic does not sell. `OPENAI_PRICING` carries OpenAI's
published standard-tier rates for the models the codex backend serves, read
off `developers.openai.com/api/docs/pricing` on 2026-09-11. OpenAI charges
nothing to write a cache entry, so cache-write tokens (which the codex path
never reports anyway) are priced at the input rate. Unknown `gpt-*` ids take
gpt-5.6-terra's rate, dario's default codex model.

`scripts/check-pricing-drift.mjs` watches the Claude table against
Anthropic's page. Nothing watches the OpenAI table yet — an entry that is
correct today goes wrong the moment OpenAI changes it, and the only signal
would be this number moving.
