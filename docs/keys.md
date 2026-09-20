# Named keys — one credential per developer

A team runs one dario for several people. `DARIO_API_KEY` is one secret for
all of them, so nothing says whose traffic is whose except an
`x-dario-consumer` header any client can set to anything. A named key ties
attribution to the credential: the request authenticated with alice's key
*is* alice's — in `/analytics`, in the ledger, on every log line — and a key
can carry two things a header never could: a preferred seat and a model
allowlist.

```bash
dario keys create alice
#   Key "alice" created (id 3f1c9a2b).
#
#     dk_7c0e…   ← shown once; dario keeps only a hash
#
dario keys create bob --seat=bobs-max --models=claude-sonnet-5,claude-haiku*
dario keys create ci --expires=30d
dario keys list
```

Give each person their key as the API key of whatever they point at dario
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, a `Bearer` header — both wire shapes,
both headers). Nothing else changes: the root `DARIO_API_KEY` keeps working
beside the named keys, and a running proxy sees a new, rotated or revoked key
on its next request, no restart.

## What a key carries

| Option | Effect |
|---|---|
| `--seat=<alias>` | The pool seat this key's traffic prefers. Taken whenever that seat is eligible right now; when it is parked on a 429, cooling down after an auth failure, or missing, the request routes like any other. A preference, not a pin: in-flight failover is unchanged, and the sticky binding follows the key so a conversation stays on the developer's own subscription. |
| `--models=a,b,prefix*` | An allowlist. A request for any other model is refused with `403` — in the request's own wire shape, before anything goes upstream. Entries are exact ids or `prefix*`, case-insensitive. |
| `--expires=30d` | Refused after this, like a revoked key. `12h`, `2w`, or an ISO date. |
| `--budget=$5/day` | A daily cap on the API-equivalent price of the key's traffic. See **Budgets**. |
| `--budget-tokens=2M/day` | A daily cap on tokens, every bucket counted. See **Budgets**. |

`dario keys revoke <name>` refuses a key from now on and keeps it in the list;
`dario keys rotate <name>` prints a new secret under the same name, seat,
models and expiry, and the old secret stops at once; `dario keys remove
<name>` forgets it.

## Budgets

`dario keys create alice --budget=$5/day --budget-tokens=2M/day` — or
`dario keys budget alice --budget=$5/day` on an existing key, `--clear` to
remove it — caps what a key may use **per UTC day**:

- **`--budget=$5/day`**: the API-equivalent price of the key's traffic, the
  same number `dario usage --by-key` prints — covered and metered rows both
  count, because a budget is about what the key caused, not who paid.
- **`--budget-tokens=2M/day`** (`250k`, `2000000`): every token the key sent
  or received, cache reads included.

The check runs at request **start** against the ledger's completed rows plus
what is **reserved** for the key's requests still in flight. A request is
reserved at an upper bound on what it can cost — its body at 3 bytes per token
priced as cache-create, plus `max_tokens` (8,192 when the client sets none) at
the output rate — until its response is in and the ledger has the real number.
So the most a key can complete in a day is the cap plus one request, whatever
the size of a burst or of the requests in it. A request past the cap is refused
with `429`
in the request's own wire shape (`rate_limit_error`; OpenAI shape adds
`code: "key_budget_exceeded"`), a `retry-after` at the UTC day boundary, and
`reject: "key-budget-usd"` / `"key-budget-tokens"` on the log line. Served
responses carry the same `x-dario-budget-*` headers (`-key`, `-usd`,
`-used-usd`, `-tokens`, `-used-tokens`, `-inflight`, `-resets-at`) so a client can watch
its own headroom. `GET /analytics` lists every budgeted key under `budgets`
with today's use; `GET /metrics` exports `dario_key_budget_usd_per_day`,
`_used_usd`, `_tokens_per_day`, `_used_tokens` per key.

Budgets are **read from the ledger**. With the ledger off (`--no-ledger`,
`DARIO_LEDGER=0`) there is nothing to read; the proxy says so at startup
(`budgets on alice are NOT enforced`) and the key is served as if it had none.
Over HTTP: `budget_usd_per_day` / `budget_tokens_per_day` on
`POST /admin/keys`, and `POST /admin/keys/<name>/budget` with the same
fields (an empty body clears), audited as `key_budget`.

## Where it shows

- **`GET /analytics`** — `perConsumer` (the rolling window) and
  `lifetime.perConsumer` (the ledger) are keyed by the key's name. A request
  that carries a named key *and* an `x-dario-consumer` header is attributed
  to the key; the header cannot overrule a credential.
- **`dario usage --by-key`** — the lifetime API-equivalent number split per
  consumer: named keys, header names, and the `u_…` hash of a client's user
  id, whichever named the request.
- **The log file** — `consumer` on every request line; `reject: "key-model"`
  on a model refusal; `event: "admin.key_create|key_rotate|key_revoke"` with
  `key: <name>` when the admin API changed something.
- **`--max-concurrent-per-consumer`** — the per-consumer cap keys on the same
  name, so a named key is paced like a header-named consumer.

## The file

`~/.dario/keys.json`, mode `0600`, holding a `sha256` hash per key and never
a secret. `DARIO_KEYS_PATH=<file>` / `--keys-path=<file>` moves it;
`--no-keys` / `DARIO_KEYS=0` ignores it (only `DARIO_API_KEY` authenticates).
The proxy re-reads the file when its mtime moves — one `stat` per
authenticated request, the cost of "no restart" — and records each key's
`last_used` with a debounced write that re-reads first, so it never clobbers
an edit the CLI made in between. A file that does not parse is reported and
the last good state stays in force: a bad edit does not lock everyone out,
and an empty read never silently revokes everyone.

Matching is constant-time over every record, every time, so a miss takes as
long as a hit and neither the number of keys nor which one matched leaks
through timing. A revoked, expired and unknown key are the same `401`.

The wire is untouched. dario already replaces the inbound key with the seat's
own bearer before upstream, so a named key changes what dario knows, not what
Anthropic or OpenAI sees — passthrough stays byte-identical.

## Over HTTP

With the [admin API](./admin-api.md) on (`DARIO_ADMIN=1`, `DARIO_ADMIN_TOKEN`),
the same file is editable without shell access:

```bash
curl -s -H "authorization: Bearer $DARIO_ADMIN_TOKEN" http://localhost:3456/admin/keys
curl -s -X POST -H "authorization: Bearer $DARIO_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"alice","seat":"work","models":["claude-sonnet-5"],"expires":"30d"}' \
  http://localhost:3456/admin/keys
# -> 201 { "key": { "id", "name", "status", "seat", "models", "expires", … }, "secret": "dk_…" }
curl -s -X POST   -H "authorization: Bearer $DARIO_ADMIN_TOKEN" http://localhost:3456/admin/keys/alice/rotate
curl -s -X DELETE -H "authorization: Bearer $DARIO_ADMIN_TOKEN" http://localhost:3456/admin/keys/alice
```

Every mutation is audited by key name; the secret appears in exactly one
response and is never stored, listed or logged.

## A keys-only proxy

A named key is additive: it never changes what a request *without* one gets.
On loopback with no `DARIO_API_KEY`, an anonymous request is still served, as
it always was; a request that presents a `dk_` credential that matches
nothing is refused, because a revoked key must mean refused, not anonymous.
For a deployment where only named keys should get in, set `DARIO_API_KEY` to
a long random value nobody is given — the non-loopback bind requires one
anyway — and hand out named keys.

## Compared with a gateway

A LiteLLM-style gateway in front of dario does this with a database, a UI and
its own key format, and knows nothing about seats. A named key is a line in a
0600 file, attribution rides the credential rather than a header the client
chooses, and the seat preference is something only the thing holding the
subscriptions can offer. Quotas per key — a share of a seat's 5-hour and
7-day window — are the obvious next step and are deliberately not in this
version; the attribution they would need is.
