#!/bin/bash
# Builds googlesql.wasm in Docker, writing googlesql.wasm and schemas/ to ./out. The Bazel cache lives in a named Docker
#   volume, so a rebuild after a change to bridge.cc or the patches is incremental. The first build compiles googlesql
#   and its dependencies (protobuf, abseil, ICU, RE2, ...) twice over, once for the host and once for wasm, and takes
#   hours, especially under amd64 emulation on an Apple Silicon machine.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=googlesql-wasm-builder
CACHE_VOLUME=googlesql-wasm-bazel-cache

mkdir -p out
docker build --platform=linux/amd64 -t "$IMAGE" .
docker run --rm --platform=linux/amd64 \
	-v "$CACHE_VOLUME:/home/builder/.cache/bazel" \
	-v "$PWD/out:/out" \
	"$IMAGE"
