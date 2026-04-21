# Stability Policy

Dario is approaching the shape of a dependency other tools can build on. This document defines what "stable" means for dario's public surface, how deprecations are handled, and what support commitments come with each release line.

If anything in this document is unclear or a specific API's tier isn't visible in its JSDoc, [open an issue](https://github.com/askalf/dario/issues/new) — ambiguity in stability claims is a bug.

## Stability tiers

Every public export in `src/index.ts` (the library surface), every documented CLI flag (`dario --help`), every documented env var (`DARIO_*`), and every documented HTTP endpoint (`/v1/messages`, `/v1/chat/completions`, `/health`, `/status`, `/accounts`, `/analytics`) is tagged with one of the following stability tiers. Tags are asserted in code via JSDoc on exports, and in docs via inline annotations on flags / env vars.

### `@stable`

- **Contract:** does not break without a major-version bump and at least one minor-version deprecation cycle (see below).
- **Use:** build downstream dependencies, vendor-integrate, pin in production.
- **Examples:** `startProxy`, `getAccessToken`, `getStatus`, the `/health` endpoint shape, the `--host` and `--port` flags, the `ANTHROPIC_BASE_URL` env var as an input.

### `@experimental`

- **Contract:** can change or be removed in any minor release, with a short (single-version) notice when practical but no guarantees.
- **Use:** evaluate, prototype against, give feedback before they stabilize.
- **Examples:** `--effort=client` passthrough (dario#87), `--max-tokens=client` passthrough (dario#88), `--strict-template` / `--no-live-capture` (dario#77). New flags default to `@experimental` for at least one minor release cycle before being promoted to `@stable`.

### `@deprecated`

- **Contract:** will be removed in the next major release. Stays functional with a runtime warning (logged once per process) pointing at the replacement.
- **Use:** migrate away — we'll tell you what to migrate to.
- **Examples:** `DARIO_MIN_INTERVAL_MS` (superseded by `DARIO_PACE_MIN_MS` in v3.24; still honored for backward compat).

### Unmarked (internal)

Anything not exported from `src/index.ts` or not documented in `dario --help` is **internal** — free to change without notice. Examples: private module functions, internal types, CLI parsers, env parsers. If you're depending on something internal, that's between you and the next refactor.

## Deprecation cycle

When a `@stable` API needs to go away:

1. Next minor release: mark it `@deprecated` in JSDoc and add a runtime one-shot `console.warn` pointing at the replacement. Also note in `CHANGELOG.md` under `### Deprecated`.
2. The release after that: add the removal to the roadmap entry for the next major. The deprecated API keeps working.
3. Next major release: removal. Migration path documented in the major's migration guide (e.g., `docs/migrate-v4.md`).

Minimum time from `@deprecated` to removal: **one minor release + one major release cycle**, typically 60–90 days. Never less than 30 days in any circumstance.

For flags / env vars / endpoints, the same cycle applies — the flag stays accepted (ignored, if behavior was removed) through one extra major release beyond the JSDoc deprecation so shell scripts don't break silently.

## LTS branches

After each major release, the previous major's last minor gets an `*-lts` branch with **12 months of security-only backports**:

| Major | LTS branch | LTS ends | Notes |
|---|---|---|---|
| v3.x | *(current active track — no LTS cut yet)* | — | v3.x is the active series; LTS cuts happen at v4.0 |
| v4.x | *(future)* | — | When v4 ships, `3.30.x-lts` gets cut from whatever 3.x's last minor was |

LTS scope:
- **In-scope:** CVEs, credential-handling regressions, supply-chain advisories, CC-drift fixes that restore OAuth-subscription billing
- **Out-of-scope:** new features, new flag support, new backends, performance improvements, new model IDs

## Release cadence

- **Patch (`3.30.x`):** bug fixes, review-feedback closeouts, drift patches, new tests. Ship as needed, sometimes several per day during active weeks.
- **Minor (`3.31.0`):** new flags, new env vars, new library exports, new HTTP endpoints. Always carries a `### Added` or `### Changed` CHANGELOG entry describing the new surface.
- **Major (`4.0.0`):** removes `@deprecated` APIs, changes `@stable` behavior, ships the accumulated breaking changes. Always carries a migration guide under `docs/migrate-v4.md`.

## What dario will never do without a major bump

- Rename or remove a `@stable` CLI flag.
- Change the shape of a `@stable` HTTP endpoint's request or response JSON.
- Change the shape of a `@stable` library-mode export's signature.
- Change a config file's field name or type without accepting the old name for one major.
- Remove an env var without accepting the old name for one major.

## Current API surface by tier

### `@stable`

- **Library:** `startProxy(opts)`, `getAccessToken()`, `getStatus()`, `sanitizeError(err)`, `listBackends()`
- **CLI:** `dario login`, `dario logout`, `dario status`, `dario refresh`, `dario proxy`, `dario doctor`, `dario accounts list/add/remove`, `dario backend list/add/remove`
- **CLI flags:** `--port`, `--host`, `--verbose`, `--preserve-tools`, `--hybrid-tools`, `--model`, `--passthrough`
- **Env vars:** `DARIO_API_KEY`, `DARIO_HOST`, `DARIO_CORS_ORIGIN`, `ANTHROPIC_BASE_URL` (as input to proxied clients)
- **HTTP endpoints:** `POST /v1/messages`, `POST /v1/chat/completions`, `GET /v1/models`, `GET /health`, `GET /status`

### `@experimental`

- **CLI flags (v3.28+):** `--session-idle-rotate`, `--session-rotate-jitter`, `--session-max-age`, `--session-per-client`, `--strict-tls`, `--pace-min`, `--pace-jitter`, `--drain-on-close`
- **CLI flags (v3.30.x review-feedback cycle):** `--preserve-orchestration-tags`, `--strict-template`, `--no-live-capture`, `--unsafe-no-auth`, `--max-concurrent`, `--max-queued`, `--queue-timeout`, `--effort`, `--max-tokens`
- **HTTP endpoints:** `GET /accounts`, `GET /analytics` (pool mode surfaces)
- **MCP server (v3.27):** `dario mcp` and all exposed MCP tools
- **Shim transport (v3.13+):** `dario shim`

All `@experimental` items graduate to `@stable` after at least one minor release of unchanged behavior and an explicit "promoted to stable" entry in `CHANGELOG.md`.

### `@deprecated`

- **Env vars:** `DARIO_MIN_INTERVAL_MS` (superseded by `DARIO_PACE_MIN_MS` in v3.24)

## Reporting a stability incident

If a `@stable` API breaks without a deprecation cycle, that's a bug — [open an issue tagged `stability-regression`](https://github.com/askalf/dario/issues/new) and we'll treat it as a patch-release priority.

## History

- **v3.31.0 (first release of this policy):** stability policy formalized; existing public surface tagged per the tiers above; LTS and deprecation cycles defined.
