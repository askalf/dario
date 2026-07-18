#!/bin/bash -eu
# Build the Jazzer.js fuzz targets for ClusterFuzzLite / OSS-Fuzz.
#
# dario sits between untrusted parties on both sides of the wire: clients hand
# it arbitrary /v1/messages and /v1/chat/completions bodies, and the upstream
# hands back SSE streams and rejection bodies that dario parses, translates,
# and rewrites. Each target feeds hostile bytes into one of those parsers and
# asserts its fail-safe contract — see the header of each fuzz/*.fuzz.js.

cd "$SRC/dario"

# npm ci verifies every integrity hash in the committed lockfile
# (Scorecard Pinned-Dependencies).
npm ci --no-audit --no-fund

# Jazzer.js is installed build-side rather than as a devDependency so the
# published package's dependency tree stays exactly as committed. It comes
# from its own lockfile (.clusterfuzzlite/package-lock.json) so every byte is
# integrity-checked, then gets merged into the project node_modules where
# compile_javascript_fuzzer expects to resolve it.
npm ci --prefix .clusterfuzzlite --no-audit --no-fund
cp -r .clusterfuzzlite/node_modules/. node_modules/

# The fuzz targets exercise the compiled output (dist/), same as the test
# suite — build it first.
npm run build

for target in sse_translate reject_parsers cch_stamp; do
  compile_javascript_fuzzer dario "fuzz/${target}.fuzz.js" --sync
done
