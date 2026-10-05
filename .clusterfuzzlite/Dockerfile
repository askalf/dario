# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Base pinned by digest (Scorecard Pinned-Dependencies). OSS-Fuzz rolls this
# image, so bump the digest periodically if the weekly fuzz build breaks.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:ca1d2a7f50cc4c37dd7b535d1adeae631843ce8a3ba35bfb7b8ad176e0b07038
COPY . $SRC/dario
WORKDIR $SRC/dario
COPY .clusterfuzzlite/build.sh $SRC/build.sh
