# Configuration

Every knob below is settable three ways. Precedence, highest first:

1. a CLI flag
2. an environment variable
3. `~/.dario/config.json`
4. the built-in default

`dario --help` is the complete list and always matches the binary you have installed. [`commands.md`](./commands.md) documents the proxy options flag-by-flag, including the OAuth overrides, session-rotation and TLS vars not repeated here.

This page is the other view: grouped by what you are trying to do, covering the vars that matter when you cannot pass a flag — Docker, Compose, k8s, systemd — plus the ones whose behaviour has a sharp edge worth stating in prose. Anything documented in `commands.md` is deliberately not restated here; two copies of a default is one that goes stale.

## Booleans

Two shapes, and the difference is not cosmetic.

**Off-switches** (`DARIO_OVERAGE_GUARD`, `DARIO_OVERAGE_NOTIFY`) accept `on|1|true|yes` and `off|0|false|no`. They guard features that default **on**, so they have to be able to say no.

**On-switches** (everything else) accept only `1|true|yes|on`. They guard features that default **off**, so an unset var and a falsy var mean the same thing and there is nothing to express.

An unrecognised value is ignored in both cases and the next source down wins. A typo leaves you on the default rather than silently flipping the knob.

> `DARIO_OVERAGE_GUARD=off` and `DARIO_OVERAGE_NOTIFY=off` were documented in `cli.ts` from v4.1 but did nothing until v5.4.14 — the shared parser could only return `true` or `undefined`, so `off` fell through the `?? … ?? true` chain and the guard stayed on. Container deployments were the only ones affected, because a flag was the sole working way to turn it off.

## Overage guard

Halts the proxy when an upstream response reports `representative-claim: overage`, so a subscription never silently starts billing per token. Defaults on. See [`#288`](https://github.com/askalf/dario/issues/288).

| Variable | Flag | Default | Values |
|---|---|---|---|
| `DARIO_OVERAGE_GUARD` | `--no-overage-guard` | on | off-switch |
| `DARIO_OVERAGE_BEHAVIOR` | `--overage-behavior=` | `halt` | `halt` returns 503 until cooldown or `dario resume`; `warn` logs and keeps serving |
| `DARIO_OVERAGE_COOLDOWN` | `--overage-cooldown=MS` | `1800000` (30 min) | ms |
| `DARIO_OVERAGE_NOTIFY` | `--no-overage-notify` | on | off-switch; suppresses the desktop notification only |

## Request queue

| Variable | Flag | Default | Notes |
|---|---|---|---|
| `DARIO_MAX_CONCURRENT` | `--max-concurrent=N` | `10` | in-flight ceiling |
| `DARIO_MAX_QUEUED` | `--max-queued=N` | `128` | buffered waiting for a slot; over this, dario returns 429 `queue-full` |
| `DARIO_QUEUE_TIMEOUT_MS` | `--queue-timeout=MS` | `60000` | a queued request waiting longer gets 504 `queue-timeout` |

## Template fidelity

dario replays Claude Code's wire shape from a template it captures from your installed `claude` binary, falling back to a baked snapshot. These two make the unsafe states require intent ([`#77`](https://github.com/askalf/dario/issues/77)).

| Variable | Flag | Default | Notes |
|---|---|---|---|
| `DARIO_NO_LIVE_CAPTURE` | `--no-live-capture` | off | Never spawn the installed CC; use the baked snapshot only. For air-gapped and reproducible-build runs. |
| `DARIO_STRICT_TEMPLATE` | `--strict-template` | off | Refuse to start if the live capture never succeeded or drifts from the installed CC version. |

## Client shape

Off by default, each one a deliberate divergence from what real CC sends.

| Variable | Flag | Notes |
|---|---|---|
| `DARIO_STEALTH` | `--stealth` | Behavioural-stealth preset. Per-knob pacing vars below still win, so you can flip this on and tune one axis. |
| `DARIO_HONOR_CLIENT_THINKING` | `--honor-client-thinking` | Pass a client's own `thinking` block through unchanged. |
| `DARIO_PRESERVE_OUTPUT_FORMAT` | `--preserve-output-format` | Carry a client's `output_config.format` schema through, for structured-output SDKs. |
| `DARIO_PRESERVE_ORCHESTRATION_TAGS` | `--preserve-orchestration-tags` | Keep orchestration tags instead of stripping them ([`#78`](https://github.com/askalf/dario/issues/78)). |
| `DARIO_EFFORT` | `--effort=` | Forces a reasoning-effort level. Can flip requests to overage billing — watch `-v` logs for representative-claim changes ([`#87`](https://github.com/askalf/dario/issues/87)). |
| `DARIO_MAX_TOKENS` | `--max-tokens=` | Anthropic enforces the per-model ceiling server-side, so too-high values return a clean 400 ([`#88`](https://github.com/askalf/dario/issues/88)). |

## Pacing

Only meaningful with stealth, and all default to 0 (off) except the cap. See [`wire-fidelity.md`](./wire-fidelity.md).

| Variable | Flag | Default |
|---|---|---|
| `DARIO_THINK_TIME_BASE_MS` | `--think-time-base=MS` | `0` |
| `DARIO_THINK_TIME_PER_TOKEN_MS` | `--think-time-per-token=MS` | `0` |
| `DARIO_THINK_TIME_JITTER_MS` | `--think-time-jitter=MS` | `0` |
| `DARIO_THINK_TIME_MAX_MS` | `--think-time-max=MS` | `30000` |
| `DARIO_SESSION_START_MIN_MS` | `--session-start-min=MS` | `0` |
| `DARIO_SESSION_START_JITTER_MS` | `--session-start-jitter=MS` | `0` |

## Pool and routing

The pool-strategy, fallback-model, alias and upstream-proxy vars live in [`commands.md`](./commands.md).

| Variable | Flag | Notes |
|---|---|---|
| `DARIO_SUSPENDED_MODELS` | — | Filters families from `/v1/models` so it never advertises a model that 404s. |
| `DARIO_SKIP_FIELDS` | `--skip-fields=CSV` | Drop named fields from the outbound body. |

## Networking and caches

| Variable | Flag | Default | Notes |
|---|---|---|---|
| `DARIO_DNS_RESULT_ORDER` | — | `ipv4first` | `verbatim` uses the resolver's own order. IPv4-first because an IPv6 answer is not universally routable. |
| `DARIO_MODEL_CATALOG_TTL_MS` | — | `3600000` (1h) | How long `/v1/models` caches Anthropic's live catalog. Model launches are rare; shorten it if you are chasing one. |
| `DARIO_USAGE_PORT` | `--port=N` | `3456` | Which proxy the `dario usage` subcommand queries. |

## Escape hatches

Reversible switches for behaviour that is normally correct. You should not need them; they exist so a bad guess on our side is not fatal.

| Variable | Values | Notes |
|---|---|---|
| `DARIO_CCH` | `random` | Stops replaying a calibrated `cch` token in the billing tag and randomises it per request instead. Only affects CC versions we hold a seed for — current CC sends no `cch` at all, so dario omits it and this does nothing. |

## Not part of the supported surface

`DARIO_LIVE_TEMPLATE_CACHE` and `DARIO_TEST_URL` exist for the test suite. They are not configuration, are not covered by semver, and can change or vanish in a patch release.

If an unsupported var is the only way to do something you need, that is a missing flag. Open an issue.
