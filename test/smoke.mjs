// Checks a built googlesql.wasm without any dependencies: it loads under WASI, reports the expected googlesql version,
//   parses and analyzes a statement, and reports a syntax error. The requests are protobuf-encoded by hand (a string
//   field is tag, length, bytes), so this doesn't need the schemas.
// Usage: node test/smoke.mjs <output directory>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WASI } from 'node:wasi';

const outDir = process.argv[2] ?? 'out';
const expectedVersion = fs
	.readFileSync(new URL('../googlesql_version.bzl', import.meta.url), 'utf8')
	.match(/GOOGLESQL_VERSION = "([^"]+)"/)[1];

const bytes = fs.readFileSync(path.join(outDir, 'googlesql.wasm'));
const module = await WebAssembly.compile(bytes);
const imports = WebAssembly.Module.imports(module);
const importModules = new Set(imports.map(({ module: moduleName }) => moduleName));
assert.deepEqual([...importModules].sort(), ['env', 'wasi_snapshot_preview1'], 'imports only WASI and Emscripten stubs');

const wasi = new WASI({ version: 'preview1', args: [], env: {} });
const env = Object.fromEntries(imports.filter(({ module: moduleName }) => moduleName === 'env').map(({ name }) => [name, () => 0]));
const instance = await WebAssembly.instantiate(module, { ...wasi.getImportObject(), env });
wasi.initialize(instance);
const {
	memory,
	googlesql_init,
	googlesql_version,
	googlesql_parse,
	googlesql_analyze,
	googlesql_format,
	googlesql_free,
	malloc,
	free,
} = instance.exports;
for (const [name, value] of Object.entries({
	googlesql_init,
	googlesql_version,
	googlesql_parse,
	googlesql_analyze,
	googlesql_format,
	googlesql_free,
	malloc,
	free,
})) {
	assert.equal(typeof value, 'function', `exports ${name}`);
}
googlesql_init();

const decoder = new TextDecoder();
const encoder = new TextEncoder();
function readCString(ptr) {
	const heap = new Uint8Array(memory.buffer);
	let end = ptr;
	while (heap[end] !== 0) end++;
	return decoder.decode(heap.subarray(ptr, end));
}
// A length-delimited field (strings are under 128 bytes here, so the length is one varint byte)
function stringField(fieldNumber, value) {
	const encoded = encoder.encode(value);
	assert.ok(encoded.length < 128);
	return [(fieldNumber << 3) | 2, encoded.length, ...encoded];
}
function call(fn, requestBytes) {
	const request = Uint8Array.from(requestBytes);
	const inPtr = malloc(request.length);
	new Uint8Array(memory.buffer, inPtr, request.length).set(request);
	const outPtr = fn(inPtr, request.length);
	free(inPtr);
	const size = new DataView(memory.buffer).getUint32(outPtr, true);
	const status = new Uint8Array(memory.buffer)[outPtr + 4];
	const payload = new Uint8Array(memory.buffer, outPtr + 5, size - 1).slice();
	googlesql_free(outPtr);
	return { status, payload };
}

assert.equal(readCString(googlesql_version()), expectedVersion, 'googlesql version');

// ParseRequest.sql_statement is field 1; AnalyzeRequest.sql_statement is field 5
const parsed = call(googlesql_parse, stringField(1, 'SELECT 1 AS x FROM t QUALIFY ROW_NUMBER() OVER (ORDER BY x) = 1'));
assert.equal(parsed.status, 0, `parse succeeds: ${decoder.decode(parsed.payload)}`);
assert.ok(parsed.payload.length > 0, 'parse returns a ParseResponse');

const syntaxError = call(googlesql_parse, stringField(1, 'SELECT FROM'));
assert.equal(syntaxError.status, 1, 'a syntax error is reported');
const message = decoder.decode(syntaxError.payload);
assert.match(message, /Syntax error: .* \[at 1:8\]/, `error message has the location: ${message}`);

const analyzed = call(googlesql_analyze, stringField(5, 'SELECT 1 AS x, "a" || "b" AS y, [1, 2] AS z'));
assert.equal(analyzed.status, 0, `analyze succeeds: ${decoder.decode(analyzed.payload)}`);
assert.ok(analyzed.payload.length > 0, 'analyze returns an AnalyzeResponse');

const unresolved = call(googlesql_analyze, stringField(5, 'SELECT * FROM missing_table'));
assert.equal(unresolved.status, 1, 'an unknown table is reported');
assert.match(decoder.decode(unresolved.payload), /Table not found: missing_table/);

// FormatSqlRequest.sql is field 1; FormatSqlResponse.sql is field 1
const formatted = call(googlesql_format, stringField(1, '-- note\nselect a,b from t where a>1'));
assert.equal(formatted.status, 0, `format succeeds: ${decoder.decode(formatted.payload)}`);
assert.equal(formatted.payload[0], (1 << 3) | 2, 'format returns a FormatSqlResponse');
assert.match(decoder.decode(formatted.payload.subarray(2)), /^-- note\nSELECT/, 'formatted SQL keeps comments and upper-cases keywords');

console.log(`ok: googlesql ${expectedVersion}, ${(bytes.length / 1048576).toFixed(1)}MB, memory ${memory.buffer.byteLength / 1048576}MB`);
