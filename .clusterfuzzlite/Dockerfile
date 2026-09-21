# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Base pinned by digest (Scorecard Pinned-Dependencies). OSS-Fuzz rolls this
# image, so bump the digest periodically if the weekly fuzz build breaks.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:03ac823bf065049cbd129b8c8f4305eaead0e2282a237cf2843770abf2a330a2
COPY . $SRC/dario
WORKDIR $SRC/dario
COPY .clusterfuzzlite/build.sh $SRC/build.sh
