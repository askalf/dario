# Pinned by digest, and to the SAME base the root Dockerfile already uses.
# An unpinned tag is a supply-chain hole (Scorecard Pinned-Dependencies), and
# this file is reference material people copy into their own infrastructure,
# so it is the one most worth getting right. Dependabot watches this directory
# for docker updates, which is what keeps a pinned digest from going stale.
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80
WORKDIR /app
COPY resp-client.mjs server.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
