// Runs against the module at $GOOGLESQL_WASM, or googlesql.wasm in the package, or the repository's build output
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { before, describe, it } from 'node:test';

import { GoogleSqlError, applyEdits, loadEngine, typeFromString, typeToString } from '../src/index.js';
import { TypeKind } from '../gen/googlesql/public/type_pb.js';

const wasmPath = [process.env.GOOGLESQL_WASM, new URL('../googlesql.wasm', import.meta.url), new URL('../../out/googlesql.wasm', import.meta.url)]
	.filter(Boolean)
	.find((candidate) => fs.existsSync(candidate));

// assert.throws doesn't return the error, so this captures it
function catchError(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	assert.fail('Expected an error');
}

let engine;
before(async () => {
	assert.ok(wasmPath, 'googlesql.wasm found');
	engine = await loadEngine(fs.readFileSync(wasmPath));
});

describe('loadEngine', () => {
	it('reports the googlesql version', () => {
		assert.match(engine.version, /^\d{4}\.\d{2}\.\d+$/);
	});

	it('loads from a compiled module', async () => {
		const other = await loadEngine(await WebAssembly.compile(fs.readFileSync(wasmPath)));
		assert.equal(other.version, engine.version);
	});
});

describe('parse', () => {
	it('finds tables, aliases, CTEs, parameters and column paths with ranges', () => {
		const sql =
			'WITH c AS (SELECT 1 AS id)\nSELECT a.id, b.name FROM `user.dataset:v1.table` a JOIN other.table_b AS b ON a.id = b.id, c\nWHERE a.x IN UNNEST(@`p.q`) AND b.y = @r';
		const { statements } = engine.parse(sql);
		assert.equal(statements.length, 1);
		const [statement] = statements;
		assert.equal(statement.kind, 'queryStatement');
		assert.deepEqual(
			statement.tables.map(({ path, alias, isQuoted }) => ({ path, alias, isQuoted })),
			[
				{ path: ['user.dataset:v1.table'], alias: 'a', isQuoted: true },
				{ path: ['other', 'table_b'], alias: 'b', isQuoted: false },
				{ path: ['c'], alias: null, isQuoted: false },
			],
		);
		for (const table of statement.tables) {
			const text = sql.slice(...table.range);
			assert.equal(text.replace(/`/g, ''), table.path.join('.'), `range of ${table.path}`);
		}
		assert.equal(sql.slice(...statement.tables[0].aliasRange), 'a');
		assert.deepEqual(
			statement.ctes.map(({ name }) => name),
			['c'],
		);
		assert.equal(statement.hasRecursiveCte, false);
		assert.deepEqual(
			statement.parameters.map(({ name }) => name),
			['p.q', 'r'],
		);
		assert.equal(sql.slice(...statement.parameters[0].range), '@`p.q`');
		assert.ok(statement.paths.some(({ names }) => names.join('.') === 'a.id'));
		assert.ok(!statement.paths.some(({ names }) => names.join('.') === 'other.table_b'), 'table paths are not column paths');
	});

	it('reports identifiers outside table paths and parameters', () => {
		const sql = 'SELECT t.a AS `x y`, LOWER(b) FROM p.d.t AS t WHERE c = @p';
		const [statement] = engine.parse(sql).statements;
		const identifiers = statement.identifiers.map(({ name }) => name).sort();
		assert.deepEqual(identifiers, ['LOWER', 'a', 'b', 'c', 't', 't', 'x y']);
		const quoted = statement.identifiers.find(({ name }) => name === 'x y');
		assert.equal(sql.slice(...quoted.range), '`x y`');
		assert.equal(quoted.isQuoted, true);
	});

	it('reports aliases of subqueries and UNNEST as range variables', () => {
		const { statements } = engine.parse('SELECT * FROM (SELECT 1 AS x) s, UNNEST([1, 2]) AS u, s.items');
		assert.deepEqual(
			statements[0].rangeVariables.map(({ name }) => name),
			['s', 'u'],
		);
		assert.deepEqual(
			statements[0].tables.map(({ path }) => path),
			[['s', 'items']],
		);
	});

	it('parses BigQuery features', () => {
		for (const sql of [
			'SELECT * FROM t QUALIFY ROW_NUMBER() OVER (ORDER BY x) = 1',
			'SELECT * FROM t WHERE x LIKE ANY UNNEST(@p)',
			'SELECT * FROM t PIVOT (SUM(x) FOR y IN (1, 2)) p',
			'FROM t |> WHERE x > 1 |> AGGREGATE COUNT(*) GROUP BY y',
			'SELECT * FROM t FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP()',
		]) {
			assert.doesNotThrow(() => engine.parse(sql), sql);
		}
	});

	it('maps byte offsets to character offsets', () => {
		const sql = "SELECT 'héllo 😀' AS s FROM `tâble` t WHERE t.x = @p";
		const [statement] = engine.parse(sql).statements;
		assert.equal(sql.slice(...statement.tables[0].range), '`tâble`');
		assert.equal(sql.slice(...statement.parameters[0].range), '@p');
	});

	it('parses scripts into statements', () => {
		const sql = 'CREATE TEMP FUNCTION f(x INT64) AS (x + 1);\nSELECT f(1) FROM t;';
		const { statements } = engine.parse(sql, { allowScript: true });
		assert.deepEqual(
			statements.map(({ kind }) => kind),
			['createFunctionStatement', 'queryStatement'],
		);
		assert.equal(sql.slice(...statements[1].range), 'SELECT f(1) FROM t');
		assert.throws(() => engine.parse(sql), GoogleSqlError);
	});

	it('throws a positioned error for invalid SQL', () => {
		const error = catchError(() => engine.parse('SELECT\nFROM t'));
		assert.ok(error instanceof GoogleSqlError);
		assert.match(error.message, /Syntax error: .* \[at 2:1\]$/);
		assert.equal(error.line, 2);
		assert.equal(error.column, 1);
		assert.ok(!error.detail.includes('[at'));
	});

	it('recognizes non-query statements', () => {
		assert.equal(engine.parse('INSERT INTO t SELECT 1').statements[0].kind, 'insertStatement');
		assert.equal(engine.parse('DELETE FROM t WHERE TRUE').statements[0].kind, 'deleteStatement');
		assert.equal(engine.parse('CREATE TABLE t (x INT64)').statements[0].kind, 'createTableStatement');
	});
});

describe('analyze', () => {
	const tables = [
		{ name: 'p.d.t', columns: [{ name: 'id', type: 'INT64' }, { name: 'name', type: 'STRING' }, { name: 'tags', type: 'ARRAY<STRING>' }] },
		{ name: ['p', 'd', 'u'], columns: [{ name: 'id', type: 'INT64' }, { name: 'when', type: 'TIMESTAMP' }] },
	];

	it('returns typed output columns with lineage', () => {
		const result = engine.analyze(
			'SELECT t.id, UPPER(name) AS upper_name, ARRAY_LENGTH(tags) AS n, u.when, STRUCT(1 AS a, "b" AS b) AS s FROM `p.d.t` t JOIN p.d.u u USING (id)',
			{ tables },
		);
		assert.equal(result.kind, 'queryStmt');
		assert.deepEqual(result.outputColumns, [
			{ name: 'id', type: 'INT64', sourceTable: 'p.d.t', sourceColumn: 'id' },
			{ name: 'upper_name', type: 'STRING', sourceTable: null, sourceColumn: null },
			{ name: 'n', type: 'INT64', sourceTable: null, sourceColumn: null },
			{ name: 'when', type: 'TIMESTAMP', sourceTable: 'u', sourceColumn: 'when' },
			{ name: 's', type: 'STRUCT<a INT64, b STRING>', sourceTable: null, sourceColumn: null },
		]);
	});

	it('types parameters', () => {
		const result = engine.analyze('SELECT id FROM `p.d.t` WHERE id IN UNNEST(@ids) AND name = @name', {
			tables,
			parameters: [
				{ name: 'ids', type: 'ARRAY<INT64>' },
				{ name: 'name', type: 'STRING' },
			],
		});
		assert.equal(result.outputColumns.length, 1);
		const error = catchError(() =>
			engine.analyze('SELECT id FROM `p.d.t` WHERE name = @name', { tables, parameters: [{ name: 'name', type: 'INT64' }] }),
		);
		assert.match(error.message, /No matching signature for operator =/);
	});

	it('reports unknown tables and columns with positions', () => {
		let error = catchError(() => engine.analyze('SELECT * FROM `p.d.missing`', { tables }));
		assert.ok(error instanceof GoogleSqlError);
		assert.match(error.message, /Table not found: `p.d.missing` \[at 1:15\]$/);
		error = catchError(() => engine.analyze('SELECT nope FROM `p.d.t`', { tables }));
		assert.match(error.message, /^Unrecognized name: nope.* \[at 1:8\]$/);
	});

	it('analyzes scripts with CREATE TEMP FUNCTION', () => {
		const result = engine.analyze(
			'CREATE TEMP FUNCTION double(x INT64) AS (x * 2);\nCREATE TEMP FUNCTION greet(s STRING) RETURNS STRING LANGUAGE js AS """return "hi " + s""";\nSELECT double(id) AS d, greet(name) AS g FROM `p.d.t`',
			{ tables, allowScript: true },
		);
		assert.equal(result.kind, 'queryStmt');
		assert.deepEqual(
			result.outputColumns.map(({ name, type }) => `${name}:${type}`),
			['d:INT64', 'g:STRING'],
		);
		const error = catchError(() =>
			engine.analyze('CREATE TEMP FUNCTION f(x INT64) AS (x + 1);\nSELECT f("a") FROM `p.d.t`', { tables, allowScript: true }),
		);
		assert.match(error.message, /^No matching signature for function f\n[\s\S]* \[at 2:8\]$/);
		assert.match(
			catchError(() => engine.analyze('SELECT 1; SELECT 2', { tables })).message,
			/Syntax error/,
		);
	});

	it('only accepts queries', () => {
		const error = catchError(() => engine.analyze('CREATE TEMP FUNCTION f(x INT64) AS (x + 1)'));
		assert.match(error.message, /Statement not supported: CreateFunctionStatement/);
		assert.match(catchError(() => engine.analyze('INSERT INTO `p.d.t` (id) VALUES (1)', { tables })).message, /Statement not supported/);
	});
});

describe('format', () => {
	it('formats SQL, keeping comments', () => {
		const formatted = engine.format('-- leading\nselect a, /* inline */ b from t where a>1 # trailing');
		assert.match(formatted, /^-- leading\nSELECT/);
		assert.match(formatted, /\/\* inline \*\//);
		assert.match(formatted, /# trailing/);
		assert.match(formatted, /FROM\s+t/);
	});

	it('takes formatter options', () => {
		const formatted = engine.format('select a from t where a > 1 and b > 2', {
			capitalizeKeywords: false,
			indentationSpaces: 4,
			lineLengthLimit: 20,
		});
		assert.match(formatted, /^select/);
		assert.match(formatted, /\nwhere\n {4}a > 1/);
	});

	it('formats only the given ranges', () => {
		const sql = 'select 1;\nselect   2;';
		const formatted = engine.format(sql, { ranges: [[10, sql.length]] });
		assert.match(formatted, /^select 1;\n/);
		assert.match(formatted, /SELECT\s+2/);
	});

	it('formats SQL that does not parse', () => {
		assert.match(engine.format('select from where'), /^SELECT/);
	});
});

describe('types', () => {
	it('round-trips type strings', () => {
		for (const type of ['INT64', 'FLOAT64', 'BOOL', 'STRING', 'BYTES', 'DATE', 'DATETIME', 'TIME', 'TIMESTAMP', 'GEOGRAPHY', 'NUMERIC', 'BIGNUMERIC', 'JSON', 'INTERVAL', 'ARRAY<STRING>', 'STRUCT<a INT64, `b c` ARRAY<STRUCT<d DATE>>>', 'RANGE<DATE>']) {
			assert.equal(typeToString(typeFromString(type)), type);
		}
	});

	it('normalizes aliases and parameters', () => {
		assert.equal(typeFromString('integer').typeKind, TypeKind.TYPE_INT64);
		assert.equal(typeFromString('boolean').typeKind, TypeKind.TYPE_BOOL);
		assert.equal(typeToString(typeFromString('array<decimal(5, 2)>')), 'ARRAY<NUMERIC>');
		assert.throws(() => typeFromString('ARRAY<STRING'), /Expected ">"/);
		assert.throws(() => typeFromString('WIDGET'), /Unknown type WIDGET/);
	});
});

describe('applyEdits', () => {
	it('replaces ranges', () => {
		const sql = 'SELECT * FROM a JOIN b';
		assert.equal(
			applyEdits(sql, [
				{ range: [14, 15], text: '`p.d.a`' },
				{ range: [21, 22], text: '`p.d.b`' },
			]),
			'SELECT * FROM `p.d.a` JOIN `p.d.b`',
		);
		assert.throws(() => applyEdits(sql, [{ range: [0, 10], text: '' }, { range: [5, 12], text: '' }]), /Overlapping/);
	});
});
