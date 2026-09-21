# Pinned by digest, and to the SAME base the root Dockerfile already uses.
# An unpinned tag is a supply-chain hole (Scorecard Pinned-Dependencies), and
# this file is reference material people copy into their own infrastructure,
# so it is the one most worth getting right. Dependabot watches this directory
# for docker updates, which is what keeps a pinned digest from going stale.
FROM node:26-alpine@sha256:dbaa92e5758cbbcf85d65d5403fdb530fe3442cbe8c6dbfb7ef23365450d5070
WORKDIR /app
COPY resp-client.mjs server.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
