#!/bin/bash
# Builds googlesql.wasm with Bazel and collects the release files into the given directory:
#   googlesql.wasm, schemas/ (the .proto files a client needs), schemas.tar.gz and SHA256SUMS.
# Runs on Linux x86-64 (in the Docker image, or a CI runner); Bazel's caches are configured by the caller.
set -euo pipefail

out=${1:?usage: bazel-build.sh <output directory>}
cd "$(dirname "$0")/.."
mkdir -p "$out"
out=$(cd "$out" && pwd)

echo "Building googlesql.wasm..."
bazel build //:googlesql_wasm

BAZEL_BIN=$(bazel info bazel-bin)
OUTPUT_BASE=$(bazel info output_base)

# Bazel's outputs are read-only, so replace rather than overwrite
rm -f "$out/googlesql.wasm"
cp "$BAZEL_BIN/googlesql_wasm/googlesql_bridge.wasm" "$out/googlesql.wasm"
chmod 644 "$out/googlesql.wasm"

# The request/response protos, and everything they import, from googlesql's source and the ones it generates
#   (parse_tree.proto, resolved_ast.proto, ...). The generated ones are under the wasm transition's own output
#   directory (bazel-out/wasm-*/bin), so look in every configuration. protobufjs supplies google/protobuf/*.proto.
rm -rf "$out/schemas"
mkdir -p "$out/schemas"
for root in "$OUTPUT_BASE"/external/googlesql+ "$OUTPUT_BASE"/execroot/_main/bazel-out/*/bin/external/googlesql+; do
	if [ -d "$root/googlesql" ]; then
		(cd "$root" && find googlesql -name '*.proto' -type f -exec cp --parents {} "$out/schemas/" \;)
	fi
done
chmod -R u+w "$out/schemas"

tar -czf "$out/schemas.tar.gz" -C "$out" schemas
(cd "$out" && sha256sum googlesql.wasm schemas.tar.gz > SHA256SUMS)

echo
echo "Built:"
ls -l "$out/googlesql.wasm" "$out/schemas.tar.gz"
echo "$(find "$out/schemas" -name '*.proto' | wc -l) proto files"
