# Running dario in Docker

Official image: **`ghcr.io/askalf/dario`**

Multi-arch (`linux/amd64` + `linux/arm64`), published from the same release
workflow that ships the npm package, so image tags are always in lockstep
with `@askalf/dario` versions on npm.

## Tags

| Tag        | Tracks                                                |
|------------|-------------------------------------------------------|
| `latest`   | Latest published release                              |
| `vX.Y.Z`   | A specific release (recommended for production pins)  |
| `vX.Y`     | Latest patch on a minor line                          |
| `vX`       | Latest minor on a major line                          |

## Quick start

```sh
# 1. One-time OAuth bootstrap — interactive, manual flow (no localhost callback).
docker volume create dario-config
docker run --rm -it -v dario-config:/home/dario/.dario \
  ghcr.io/askalf/dario:latest login --manual

# 2. Run the proxy. DARIO_API_KEY is REQUIRED — see "Why an API key is mandatory" below.
docker run -d --name dario \
  -p 3456:3456 \
  -v dario-config:/home/dario/.dario \
  -e DARIO_API_KEY="$(openssl rand -hex 32)" \
  ghcr.io/askalf/dario:latest

# 3. Point your tools at it (using the same key you set above).
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=<the key from step 2>
```

### Why an API key is mandatory

The image binds to `0.0.0.0` so port maps and k8s services can reach the
proxy. dario refuses to start on a non-loopback bind unless `DARIO_API_KEY`
is set, because an unauthenticated proxy on a reachable interface is an
open OAuth-subscription relay for anyone on the network (dario#74). The
image inherits that refusal — there is no "just don't set a key" path.

Escape hatches if you have out-of-band network controls:

- `-e DARIO_HOST=127.0.0.1` — bind loopback inside the container. Useless
  for `-p` port maps, but makes sense if another container in the same
  network namespace is the only client.
- `--unsafe-no-auth` as a CMD arg. Don't.

## OAuth in a container

`dario login --manual` skips the localhost-callback flow and prints a URL you
open in any browser on any machine. Anthropic's authorize endpoint renders the
authorization code on a copy-paste page; paste it back into the container's
stdin and dario writes `~/.dario/credentials.json` into the mounted volume.
Subsequent container starts find the credentials and the `proxy` subcommand
uses them directly.

The container detector (`/.dockerenv` + cgroup probe) auto-suggests
`--manual` if you accidentally run `login` without it — but the suggestion
prints to stdout and then fails on the localhost bind, so just use `--manual`
from the start.

### Pre-seeding credentials (no interactive container needed)

If you can't allocate a TTY (k8s Job, CI, immutable infra), run
`dario login --manual` once on your workstation, then ship
`~/.dario/credentials.json` into the volume by your usual secrets path
(SOPS, sealed-secrets, `kubectl create secret generic … --from-file`, etc.).
The refresh token in that file is good until you revoke it.

### Headless bootstrap over HTTP (`DARIO_ADMIN=1`) — no console at all

The third option skips both the interactive container *and* the pre-seeded
file: start the container **empty** with the admin API enabled, then provision
the first account over HTTP from anywhere:

```bash
docker run -d -v dario-data:/home/dario/.dario -p 3456:3456 \
  -e DARIO_API_KEY=<proxy-key> -e DARIO_ADMIN=1 -e DARIO_ADMIN_TOKEN=<admin-token> \
  ghcr.io/askalf/dario:latest

curl -s -X POST -H "authorization: Bearer <admin-token>" \
  http://<host>:3456/admin/login/start          # -> { authorize_url, alias, ... }
# open authorize_url in any browser, approve, paste the code back:
curl -s -X POST -H "authorization: Bearer <admin-token>" \
  http://<host>:3456/admin/login/complete -d '{"alias":"account-1","code":"<code>"}'
```

The account is routable the moment the `200` lands — the live pool hot-reloads,
no restart. Until then, LLM requests answer a truthful
`503 { "error": "No account configured" }` and `/health` reports `degraded`,
so gate any bootstrap automation on the container being *up*, not *healthy*.
Full endpoint reference, audit trail, and rate-limit behavior:
[`docs/admin-api.md`](./admin-api.md).

## Configuration

All flags have env-var equivalents. The image sets sensible container defaults:

| Variable                  | Default in image | Purpose                                       |
|---------------------------|------------------|-----------------------------------------------|
| `DARIO_HOST`              | `0.0.0.0`        | Bind address (image flips from `127.0.0.1`)   |
| `DARIO_PORT`              | `3456`           | Listen port                                   |
| `DARIO_API_KEY`           | unset (**required**) | Required because of the `0.0.0.0` bind — see "Why an API key is mandatory" |
| `DARIO_CORS_ORIGIN`       | unset            | Override the default `http://localhost:<port>` allow-list |
| `DARIO_LOG_FILE`          | unset            | Path inside the container (mount a volume)    |
| `DARIO_LOG_BODIES`        | unset            | `1` to log request/response bodies            |
| `DARIO_PASSTHROUGH_BETAS` | unset            | `1` to forward `anthropic-beta` headers as-is |
| `DARIO_CLAUDE_BIN`        | unset            | Path to a Claude Code binary (optional, for live template capture) |
| `DARIO_NO_BUN`            | unset            | `1` to skip the Bun auto-relaunch (not recommended) |
| `DARIO_ADMIN`             | unset            | `1` mounts the headless admin API at `/admin/*` — see [`docs/admin-api.md`](./admin-api.md) |
| `DARIO_ADMIN_TOKEN`       | unset            | Bearer token for admin calls (falls back to `DARIO_API_KEY`); enabled-but-tokenless fails closed |
| `DARIO_ADMIN_RATE_LIMIT`  | unset            | `off` to disable admin rate limiting (on by default) |

### Why `DARIO_HOST=0.0.0.0` in the image

dario defaults to `127.0.0.1` on host installs because it's a local-only
proxy. In a container the loopback interface is internal to the container,
so the proxy would be unreachable through `-p` port maps or k8s services.
The image flips the default to `0.0.0.0` and pairs it with the
mandatory-API-key refusal above; the container's network namespace boundary
becomes the trust boundary instead.

## Persistence

Mount `/home/dario/.dario` as a volume. It holds:

- `credentials.json` — OAuth tokens (access + refresh)
- `accounts/*.json` — multi-account pool entries, if you use the pool
- `cc-oauth-cache-v6.json` — cached CC OAuth config (auto-refreshes)
- `oauth-config.override.json` — user-supplied OAuth config override

Without a volume, you'd lose the refresh token on every container restart and
have to re-run `dario login` each time.

## Healthcheck

The image ships a Docker `HEALTHCHECK` that hits `/health` every 30s. Once an
account is loaded and its OAuth is usable the endpoint returns HTTP 200
`{"status":"ok", ...}`; when OAuth is broken/absent it returns HTTP 503
`{"status":"degraded", ...}`. Use the same endpoint for k8s liveness/readiness
probes:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 3456 }
  periodSeconds: 30
readinessProbe:
  httpGet: { path: /health, port: 3456 }
  periodSeconds: 5
```

> **Empty admin-mode start:** with `DARIO_ADMIN=1` and no accounts yet,
> `/health` is `degraded`/503 by design (every LLM call would 503 until an
> account exists), so a readiness probe on `/health` holds the pod out of
> rotation until you provision the first account via the
> [admin API](./admin-api.md). Provision before relying on readiness, or use a
> long-window `startupProbe` around the bootstrap.

## Kubernetes example

```yaml
apiVersion: v1
kind: Secret
metadata: { name: dario-credentials }
type: Opaque
stringData:
  # The API key clients send as `ANTHROPIC_API_KEY` to reach the proxy.
  api-key: <SOME_RANDOM_SECRET>
data:
  # base64-encoded contents of ~/.dario/credentials.json from a prior
  # `dario login --manual` on your workstation.
  credentials.json: <BASE64>
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: dario }
spec:
  replicas: 1
  selector: { matchLabels: { app: dario } }
  template:
    metadata: { labels: { app: dario } }
    spec:
      containers:
        - name: dario
          image: ghcr.io/askalf/dario:latest
          ports: [{ containerPort: 3456 }]
          env:
            - { name: DARIO_API_KEY, valueFrom: { secretKeyRef: { name: dario-credentials, key: api-key } } }
          volumeMounts:
            - { name: config, mountPath: /home/dario/.dario }
          livenessProbe:
            httpGet: { path: /health, port: 3456 }
            periodSeconds: 30
          readinessProbe:
            httpGet: { path: /health, port: 3456 }
            periodSeconds: 5
      volumes:
        - name: config
          projected:
            sources:
              - secret:
                  name: dario-credentials
                  items:
                    - { key: credentials.json, path: credentials.json }
---
apiVersion: v1
kind: Service
metadata: { name: dario }
spec:
  selector: { app: dario }
  ports: [{ port: 3456, targetPort: 3456 }]
```

Replicas should stay at `1` — dario's OAuth refresh races on a single
credentials file. For HA, run multiple dario instances each with their own
account in a [multi-account pool](./multi-account-pool.md).

## Image updates

The image is rebuilt on every release tag, so any image-update tool that
watches semver tags works out of the box:

- **Renovate** — `docker:enableMajor` + `:vX.Y.Z` pin
- **Argo CD Image Updater** — `update-strategy: semver`
- **Keel** — `keel.sh/policy: minor`

`:latest` is provided for convenience but you should pin a major or minor in
production so a breaking change in dario doesn't roll out unattended.
