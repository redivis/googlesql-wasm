# @redivis/googlesql

[googlesql](https://github.com/google/googlesql)'s parser, analyzer and formatter (the GoogleSQL dialect BigQuery speaks) as a WebAssembly module, with a JavaScript API that works the same way in Node and in browsers. Once loaded, every call is synchronous.

## Installing

The package is attached to each [release](https://github.com/redivis/googlesql-wasm/releases) as an npm tarball, so depend on that URL:

```json
"@redivis/googlesql": "https://github.com/redivis/googlesql-wasm/releases/download/v0.2.0/redivis-googlesql-0.2.0.tgz"
```

It includes `googlesql.wasm` (~24 MB; ~5 MB compressed over the wire), the generated protobuf code (`gen/`) and the loader (`src/`). Its one dependency is `@bufbuild/protobuf`.

## Loading

```js
import { loadEngine } from '@redivis/googlesql';

// Node
import fs from 'node:fs';
const engine = await loadEngine(fs.readFileSync(new URL(import.meta.resolve('@redivis/googlesql/googlesql.wasm'))));

// Browser: serve googlesql.wasm as a static asset (ideally with Content-Type: application/wasm, so it compiles as it
//   streams) and pass the fetch
const engine = await loadEngine(fetch(wasmUrl));
```

`loadEngine` takes a `WebAssembly.Module`, the module's bytes, or a `Response` (or a promise of one). It takes about 30 ms, and the instance holds 64 MB of memory initially (it grows as needed). Load once and share the engine.

## API

Everything throws a `GoogleSqlError` for invalid SQL. Its `message` ends with the location, `[at line:column]` (1-based), when googlesql knows it; `line`, `column` and `detail` (the message without the location) are also set.

### `engine.parse(sql, { allowScript })`

Parses `sql` as one statement, or as a script when `allowScript` is set (otherwise a second statement is a syntax error). Returns `{ statements }`, each a summary of what a SQL tool needs from the tree, with ranges as `[start, end)` character offsets into `sql`:

```js
{
  kind: 'queryStatement',                        // the AST class, lower-camel-cased: createFunctionStatement, insertStatement, ...
  range: [0, 83],
  tables: [{ path: ['p', 'd', 't'], isQuoted: false, range: [14, 19], alias: 't', aliasRange: [23, 24] }],
  rangeVariables: [{ name: 's', range }],         // aliases of subqueries and UNNESTs (a path off one isn't a table)
  ctes: [{ name: 'recent', range }],
  hasRecursiveCte: false,
  parameters: [{ name: 'start', position: null, range }],
  paths: [{ names: ['t', 'id'], range }],         // every other path expression, e.g. column references
}
```

A table whose path's first part is a CTE name, a table alias or a range variable is a reference to that, not to a table. `engine.parseRaw(sql, options)` returns the decoded `ParseResponse` for callers that need the whole tree.

### `engine.analyze(sql, { tables, parameters })`

Resolves a query against a catalog and returns its output columns, typed, with the source table and column of each pass-through column:

```js
engine.analyze('SELECT t.id, UPPER(name) AS upper_name FROM `p.d.t` t WHERE id IN UNNEST(@ids)', {
  tables: [{ name: 'p.d.t', columns: [{ name: 'id', type: 'INT64' }, { name: 'name', type: 'STRING' }] }],
  parameters: [{ name: 'ids', type: 'ARRAY<INT64>' }],
});
// { kind: 'queryStmt', outputColumns: [
//   { name: 'id', type: 'INT64', sourceTable: 'p.d.t', sourceColumn: 'id' },
//   { name: 'upper_name', type: 'STRING', sourceTable: null, sourceColumn: null } ] }
```

A table's `name` is one identifier (what `` `p.d.t` `` refers to) or an array for a path through nested catalogs (what `p.d.t` refers to). Types are BigQuery type strings, including `ARRAY<...>`, `STRUCT<...>` and `RANGE<...>`; `typeFromString` and `typeToString` convert them to and from `TypeProto`. Only queries are accepted, so a DML or DDL statement fails with `Statement not supported: ...`. The language is BigQuery's: every released GoogleSQL feature, in external product mode. `engine.analyzeRaw` returns the decoded `AnalyzeResponse`.

### `engine.format(sql, options)`

Reformats `sql` with googlesql's lenient formatter, which keeps comments and copes with SQL that doesn't fully parse (so it formats code as someone types it). `options` are the fields of `googlesql.FormatterOptionsProto`, camel-cased: `lineLengthLimit` (80), `indentationSpaces` (2), `capitalizeKeywords` (true), `capitalizeFunctions` (false), `preserveLineBreaks` (false), `newLineType`, `enforceSingleQuotes`, `formatStructuredStrings`, `formatComments` and `allowInvalidTokens`. `ranges: [[start, end], ...]` formats only those character ranges.

### `applyEdits(sql, [{ range, text }])`

Replaces ranges from a parse with other text, e.g. to qualify table references, without overlapping.

## Versions

The package version matches the repository's release tag. `engine.version` is the googlesql release the module was built from.
