# Pinned by digest, and to the SAME base the root Dockerfile already uses.
# An unpinned tag is a supply-chain hole (Scorecard Pinned-Dependencies), and
# this file is reference material people copy into their own infrastructure,
# so it is the one most worth getting right. Dependabot watches this directory
# for docker updates, which is what keeps a pinned digest from going stale.
FROM node:26-alpine@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5
WORKDIR /app
COPY resp-client.mjs server.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
