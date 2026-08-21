# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Base pinned by digest (Scorecard Pinned-Dependencies). OSS-Fuzz rolls this
# image, so bump the digest periodically if the weekly fuzz build breaks.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:2e218dedc1603f15e34cec784030789e06db1df8eb5356f0a8e27285619ac8c2
COPY . $SRC/dario
WORKDIR $SRC/dario
COPY .clusterfuzzlite/build.sh $SRC/build.sh
