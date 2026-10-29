// Loads googlesql.wasm and wraps its C ABI (see bridge.cc in the repository root): each call takes a serialized
//   googlesql.local_service request and returns `uint32 size | uint8 status | payload`, where status 0 is the response
//   proto and 1 a UTF-8 error message.
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';

import {
	AnalyzeRequestSchema,
	AnalyzeResponseSchema,
	FormatSqlRequestSchema,
	FormatSqlResponseSchema,
	ParseRequestSchema,
	ParseResponseSchema,
} from '../gen/googlesql/local_service/local_service_pb.js';

import GoogleSqlError from './GoogleSqlError.js';
import createByteToCharIndex from './offsets.js';
import summarizeStatement, { kindOf, unwrap } from './parseTree.js';
import { typeFromString, typeToString } from './types.js';
import createImports from './wasi.js';

const decoder = new TextDecoder();

// source: a WebAssembly.Module, the module's bytes (ArrayBuffer or typed array), or a fetch() Response (or a promise of
//   one), which is instantiated as it streams. onStderr receives anything the module logs (it shouldn't log anything).
export async function loadEngine(source, { onStderr = (text) => console.error(text) } = {}) {
	let memory;
	const imports = createImports({
		getMemory: () => memory,
		onWrite: (fd, text) => {
			if (fd === 2) {
				onStderr(text);
			}
		},
	});

	let instance;
	const resolvedSource = await source;
	if (resolvedSource instanceof WebAssembly.Module) {
		instance = await WebAssembly.instantiate(resolvedSource, imports);
	} else if (typeof Response !== 'undefined' && resolvedSource instanceof Response) {
		if (typeof WebAssembly.instantiateStreaming === 'function') {
			try {
				({ instance } = await WebAssembly.instantiateStreaming(resolvedSource.clone(), imports));
			} catch {
				// Served without an application/wasm content type
			}
		}
		if (!instance) {
			({ instance } = await WebAssembly.instantiate(await resolvedSource.arrayBuffer(), imports));
		}
	} else {
		({ instance } = await WebAssembly.instantiate(resolvedSource, imports));
	}
	memory = instance.exports.memory;
	return new Engine(instance);
}

export class Engine {
	#exports;

	constructor(instance) {
		this.#exports = instance.exports;
		this.#exports.googlesql_init();
	}

	// The googlesql release the module was built from, e.g. "2026.10.3"
	get version() {
		const heap = new Uint8Array(this.#exports.memory.buffer);
		const start = this.#exports.googlesql_version();
		let end = start;
		while (heap[end] !== 0) {
			end++;
		}
		return decoder.decode(heap.subarray(start, end));
	}

	// Parses sql as one statement, or as a script of statements when allowScript is set (googlesql only parses the
	//   first statement otherwise, and errors if anything follows it). Returns { statements: [summary] } (see
	//   parseTree.js for a summary's shape), or throws a GoogleSqlError.
	parse(sql, { allowScript = false } = {}) {
		const response = this.parseRaw(sql, { allowScript });
		const byteToCharIndex = createByteToCharIndex(sql);
		const statements =
			response.result.case === 'parsedScript'
				? response.result.value.statementListNode?.statementList ?? []
				: response.result.case === 'parsedStatement'
					? [response.result.value]
					: [];
		return { statements: statements.map((statement) => summarizeStatement(statement, byteToCharIndex)) };
	}

	// The decoded ParseResponse, for callers that need the whole tree
	parseRaw(sql, { allowScript = false } = {}) {
		const request = create(ParseRequestSchema, { target: { case: 'sqlStatement', value: sql }, allowScript });
		return fromBinary(
			ParseResponseSchema,
			this.#call(this.#exports.googlesql_parse, toBinary(ParseRequestSchema, request)),
		);
	}

	// Resolves a query against the given tables and parameters, in BigQuery's dialect. Only queries are accepted (the
	//   analyzer's default); anything else is an error, "Statement not supported: ...".
	//   tables: [{ name: 'a.b.c' | ['a', 'b', 'c'], columns: [{ name, type }] }], where a string name is one identifier
	//     (what `a.b.c` in backticks refers to) and an array is a path through nested catalogs (what a.b.c refers to);
	//     type is a BigQuery type string
	//   parameters: [{ name, type }]
	// Returns { kind: 'queryStmt', outputColumns: [{ name, type, sourceTable, sourceColumn }] }: the output columns,
	//   with the table and column a pass-through column comes from. Throws a GoogleSqlError.
	analyze(sql, { tables = [], parameters = [] } = {}) {
		const response = this.analyzeRaw(sql, { tables, parameters });
		const statement = response.result.case === 'resolvedStatement' ? unwrap(response.result.value) : null;
		const outputColumnList = statement?.outputColumnList ?? null;
		return {
			kind: response.result.case === 'resolvedStatement' ? kindOf(response.result.value, 'Resolved') : null,
			outputColumns:
				outputColumnList?.map(({ name, column }) => ({
					name,
					type: typeToString(column.type),
					sourceTable: column.tableName?.startsWith('$') ? null : (column.tableName ?? null),
					sourceColumn: column.tableName?.startsWith('$') ? null : (column.name ?? null),
				})) ?? null,
		};
	}

	// The decoded AnalyzeResponse, for callers that need the resolved tree
	analyzeRaw(sql, { tables = [], parameters = [] } = {}) {
		const request = create(AnalyzeRequestSchema, {
			target: { case: 'sqlStatement', value: sql },
			options: {
				queryParameters: parameters.map(({ name, type }) => ({ name, type: typeFromString(type) })),
			},
			simpleCatalog: buildCatalog(tables),
		});
		return fromBinary(
			AnalyzeResponseSchema,
			this.#call(this.#exports.googlesql_analyze, toBinary(AnalyzeRequestSchema, request)),
		);
	}

	// Reformats sql with googlesql's lenient formatter, which keeps comments and copes with SQL that doesn't fully parse.
	//   options are the fields of googlesql.FormatterOptionsProto: lineLengthLimit (80), indentationSpaces (2),
	//   newLineType, capitalizeKeywords (true), capitalizeFunctions, preserveLineBreaks, enforceSingleQuotes,
	//   formatStructuredStrings, formatComments, allowInvalidTokens, expandFormatRanges. ranges limits formatting to
	//   those [start, end) character ranges of sql. Throws a GoogleSqlError when the text can't be formatted.
	format(sql, { ranges, ...options } = {}) {
		const request = create(FormatSqlRequestSchema, {
			sql,
			options,
			byteRanges: ranges?.map(([start, end]) => ({ start: byteOffset(sql, start), end: byteOffset(sql, end) })) ?? [],
		});
		const response = fromBinary(
			FormatSqlResponseSchema,
			this.#call(this.#exports.googlesql_format, toBinary(FormatSqlRequestSchema, request)),
		);
		return response.sql;
	}

	#call(fn, requestBytes) {
		const { memory, malloc, free, googlesql_free } = this.#exports;
		const inPtr = malloc(requestBytes.length);
		new Uint8Array(memory.buffer, inPtr, requestBytes.length).set(requestBytes);
		let outPtr;
		try {
			outPtr = fn(inPtr, requestBytes.length);
		} finally {
			free(inPtr);
		}
		// Read after the call: memory may have grown, detaching the earlier buffer
		const size = new DataView(memory.buffer).getUint32(outPtr, true);
		const status = new Uint8Array(memory.buffer)[outPtr + 4];
		const payload = new Uint8Array(memory.buffer, outPtr + 5, size - 1).slice();
		googlesql_free(outPtr);
		if (status !== 0) {
			throw new GoogleSqlError(decoder.decode(payload));
		}
		return payload;
	}
}

const encoder = new TextEncoder();
function byteOffset(text, charIndex) {
	return encoder.encode(text.slice(0, charIndex)).length;
}

// A SimpleCatalogProto with each table under its name, or under nested catalogs for a path
function buildCatalog(tables) {
	const root = { table: [], catalog: [] };
	const catalogsByName = new Map();
	for (const { name, columns } of tables) {
		const path = Array.isArray(name) ? name : [name];
		let catalog = root;
		let key = '';
		for (const part of path.slice(0, -1)) {
			key = `${key}\0${part}`;
			if (!catalogsByName.has(key)) {
				const child = { name: part, table: [], catalog: [] };
				catalog.catalog.push(child);
				catalogsByName.set(key, child);
			}
			catalog = catalogsByName.get(key);
		}
		catalog.table.push({
			name: path.at(-1),
			column: columns.map((column) => ({ name: column.name, type: typeFromString(column.type) })),
		});
	}
	return root;
}
