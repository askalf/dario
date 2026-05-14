# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

# su-exec is the alpine package that lets the entrypoint drop privileges
# from root → dario after the volume self-heal. ~10KB; no shell, no PAM.
RUN apk add --no-cache su-exec

# Bun ships dario's runtime TLS fingerprint — without it, dario auto-detects
# Node and falls back to bun-not-found mode. Copying the static binary from
# oven/bun:1-alpine keeps the runtime image free of bun's build deps.
COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun

RUN addgroup -S dario \
 && adduser -S -G dario -h /home/dario dario \
 && mkdir -p /home/dario/.dario \
 && chown -R dario:dario /home/dario

WORKDIR /app
COPY --from=build --chown=dario:dario /app/dist ./dist
# Doctor reads package.json (at __dirname/..) to surface the running version.
# Without this copy, container deploys see `[WARN] dario package.json not
# readable — version unknown` even though the binary itself works fine.
COPY --from=build --chown=dario:dario /app/package.json ./package.json

# Expose `dario` on PATH so `docker exec <container> dario login --manual`
# works without falling back to `node /app/dist/cli.js`. The shebang in
# cli.ts (`#!/usr/bin/env node`) handles the rest.
RUN chmod +x /app/dist/cli.js \
 && ln -s /app/dist/cli.js /usr/local/bin/dario

# Self-heal entrypoint: starts as root, chowns the mounted config volume to
# dario:dario, then drops privileges via su-exec before running the CLI.
# Required because Docker volume mounts don't inherit the build-time chown,
# and any prior `--user 0` recovery op leaves the volume root-owned. Without
# this the dario user can't write credentials and the container drifts into
# a state that looks like an OAuth bug. See entrypoint script for details.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Container starts as root briefly — the entrypoint script self-heals the
# volume and drops to the dario user before exec'ing the CLI. Operators who
# want to skip the self-heal (e.g. immutable CI runners) can override with
# `docker run --user dario ...`.

ENV DARIO_HOST=0.0.0.0 \
    DARIO_PORT=3456

EXPOSE 3456
VOLUME ["/home/dario/.dario"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${DARIO_PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["proxy"]
