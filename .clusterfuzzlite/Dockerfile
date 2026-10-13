# ClusterFuzzLite build image — OpenSSF Scorecard detects fuzzing via this file.
# Uses the OSS-Fuzz JavaScript base builder (Jazzer.js), which provides
# `compile_javascript_fuzzer`. See build.sh for the fuzz targets.
# Base pinned by digest (Scorecard Pinned-Dependencies). OSS-Fuzz rolls this
# image, so bump the digest periodically if the weekly fuzz build breaks.
FROM gcr.io/oss-fuzz-base/base-builder-javascript@sha256:fff2fe5f532ffcd3fcea7c54cc1db18951b364b64aa37c415348ce8ba17cde34
COPY . $SRC/dario
WORKDIR $SRC/dario
COPY .clusterfuzzlite/build.sh $SRC/build.sh
