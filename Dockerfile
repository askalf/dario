# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime

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

USER dario

ENV DARIO_HOST=0.0.0.0 \
    DARIO_PORT=3456

EXPOSE 3456
VOLUME ["/home/dario/.dario"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${DARIO_PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["proxy"]
