# googlesql-wasm

[googlesql](https://github.com/google/googlesql)'s parser and analyzer (the GoogleSQL dialect BigQuery speaks), built as a standalone WebAssembly module. It runs in Node and in the browser, synchronously, with no child process or server, so one SQL parser can validate queries on a backend and in an editor.

## Getting the module

Each [release](../../releases) has:

- `googlesql.wasm`: the module (~24 MB; ~5 MB compressed over the wire).
- `schemas.tar.gz`: the `.proto` files that define its requests and responses, including the ones googlesql generates (`parse_tree.proto`, `resolved_ast.proto`).
- `SHA256SUMS`

## Using it

The `.wasm` imports only WASI (`wasi_snapshot_preview1`) functions and two Emscripten stubs, so it loads with `node:wasi` or a small WASI shim in a browser. Exports:

- `googlesql_init()`: call once, first.
- `googlesql_version()`: the googlesql release, as a C string.
- `googlesql_parse(ptr, size)`: a serialized `googlesql.local_service.ParseRequest` → `ParseResponse`. Set `allow_script` to parse several statements.
- `googlesql_analyze(ptr, size)`: a serialized `AnalyzeRequest` → `AnalyzeResponse`. Declare tables (with typed columns) in `simple_catalog` and parameters in `options.query_parameters`; the resolved statement's `output_column_list` has the result schema.
- `malloc`, `free`, `googlesql_free`.

Responses are a buffer of `uint32 size | uint8 status | payload`: status 0 is the response proto, 1 is a UTF-8 error message, with the location as `[at line:col]` where known. When a request leaves the language options unset, BigQuery's dialect is used (every released language feature, external product mode).

These are the protos of googlesql's gRPC `local_service`, so a client written against this module can also talk to that service. `test/smoke.mjs` shows the calling convention with hand-encoded requests.

One googlesql proto (`googlesql/public/proto/vector_encoding_id.proto`) uses protobuf edition 2024; generate client code with a protobuf implementation that supports editions.

## Building

```bash
./build.sh
```

This builds the Docker image and runs the Bazel + Emscripten build in it, writing `out/`. The Bazel cache is kept in the `googlesql-wasm-bazel-cache` Docker volume, so rebuilds are incremental; a cold build takes about half an hour on an x86-64 machine (longer under emulation on Apple Silicon). The same steps run on Linux directly with `scripts/bazel-build.sh out`, which is what [the workflow](.github/workflows/build.yml) does.

To move to a new googlesql release, update the commit in `MODULE.bazel` and the version in `googlesql_version.bzl`, and check that the patches still apply. Then tag `vX.Y.Z` to publish a release.

## Patches

The build applies three one-line patches to googlesql:

- `icu_disable_tools.patch`: ICU's data tools can't be run when cross-compiling, so ICU is built without them and with a stub data library. Parsing and analysis don't use the data; only executing collation or normalization functions would, and the module doesn't execute queries.
- `analyzer_options_utc.patch`: the analyzer's default time zone is looked up at construction, which needs tzdata; UTC doesn't.
- `internal_utils_int64_shift.patch`: `RoundUpToNextPowerOfTwo` shifts a `long` by 62, which is 32 bits on wasm32, so every capacity computation logged "Out of range" and returned garbage.

## License

MIT. googlesql itself is Apache 2.0.
