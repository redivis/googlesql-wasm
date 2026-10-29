#!/bin/bash
# Builds the @redivis/googlesql npm package from a build's output directory: generates the protobuf code, copies the
#   wasm in, runs the tests, and packs the tarball into the output directory (as redivis-googlesql-<version>.tgz).
# Usage: scripts/package.sh <output directory>   (after scripts/bazel-build.sh <output directory>)
set -euo pipefail

out=${1:?usage: package.sh <output directory>}
cd "$(dirname "$0")/.."
out=$(cd "$out" && pwd)

cd js
npm ci --no-audit --no-fund
rm -rf gen
npm run generate
cp "$out/googlesql.wasm" googlesql.wasm
GOOGLESQL_WASM=googlesql.wasm npm test
rm -f ./*.tgz
npm pack --pack-destination "$out"

echo
echo "Packed:"
ls -l "$out"/redivis-googlesql-*.tgz
