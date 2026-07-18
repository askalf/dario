# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Base pinned by digest (Scorecard Pinned-Dependencies). OSS-Fuzz rolls this
# image, so bump the digest periodically if the weekly fuzz build breaks.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:717f88cd72ee85ab295debf1272eed85590621d6ba9d70d6c59133a61f3f3acf
COPY . $SRC/dario
WORKDIR $SRC/dario
COPY .clusterfuzzlite/build.sh $SRC/build.sh
