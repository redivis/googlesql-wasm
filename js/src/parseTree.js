// Summarizes a parsed statement (an AnyASTStatementProto decoded by protobuf-es) as the references a SQL tool needs:
//   table paths, their aliases, every other alias a FROM item introduces, CTE names, parameters, and the other path
//   expressions (column references). Each comes with its range in the SQL as [start, end) character offsets.
//
// The serialized parse tree is flattened: every AST class has a `parent` field holding its base class's fields (down
//   to ASTNodeProto, which has the location), and a polymorphic child is an Any*Proto wrapper with a oneof `node`.

// Any*Proto wrappers nest for abstract classes (a CREATE FUNCTION statement is AnyASTStatementProto >
//   AnyASTDdlStatementProto > AnyASTCreateStatementProto > ...); this descends to the concrete node
export function unwrap(node) {
	while (node?.node?.case) {
		node = node.node.value;
	}
	return node;
}

// The concrete node's class, lower-camel-cased: 'queryStatement', 'createFunctionStatement', 'insertStatement', ...
export function kindOf(node, prefix) {
	const typeName = unwrap(node)?.$typeName;
	if (!typeName) {
		return null;
	}
	const name = typeName.replace(/^googlesql\./, '').replace(new RegExp(`^${prefix}`), '').replace(/Proto$/, '');
	return name.charAt(0).toLowerCase() + name.slice(1);
}

export default function summarizeStatement(anyStatement, byteToCharIndex) {
	const statement = unwrap(anyStatement);
	const summary = {
		kind: kindOf(anyStatement, 'AST'),
		range: range(statement, byteToCharIndex),
		tables: [],
		// Aliases of FROM items that aren't tables (subqueries, UNNEST), so that a path off of one isn't taken for a table
		rangeVariables: [],
		ctes: [],
		hasRecursiveCte: false,
		parameters: [],
		paths: [],
	};
	if (!statement) {
		return summary;
	}

	// Path expressions that name a table, so that the walk doesn't also report them as column paths
	const tablePathExpressions = new Set();

	walk(statement, (node) => {
		switch (node.$typeName) {
			case 'googlesql.ASTTablePathExpressionProto': {
				const alias = node.alias?.identifier;
				if (node.pathExpr) {
					tablePathExpressions.add(node.pathExpr);
					summary.tables.push({
						path: node.pathExpr.names.map((name) => name.idString),
						isQuoted: node.pathExpr.names.some((name) => name.isQuoted),
						range: range(node.pathExpr, byteToCharIndex),
						alias: alias?.idString ?? null,
						aliasRange: alias ? range(alias, byteToCharIndex) : null,
					});
				} else if (alias) {
					// UNNEST(...) AS alias
					summary.rangeVariables.push({ name: alias.idString, range: range(alias, byteToCharIndex) });
				}
				break;
			}
			case 'googlesql.ASTTableSubqueryProto': {
				const alias = node.alias?.identifier;
				if (alias) {
					summary.rangeVariables.push({ name: alias.idString, range: range(alias, byteToCharIndex) });
				}
				break;
			}
			case 'googlesql.ASTWithClauseProto':
				if (node.recursive) {
					summary.hasRecursiveCte = true;
				}
				break;
			case 'googlesql.ASTAliasedQueryProto':
				if (node.alias) {
					summary.ctes.push({ name: node.alias.idString, range: range(node.alias, byteToCharIndex) });
				}
				break;
			case 'googlesql.ASTParameterExprProto':
				summary.parameters.push({
					name: node.name?.idString ?? null,
					position: node.name ? null : Number(node.position),
					range: range(node, byteToCharIndex),
				});
				break;
			case 'googlesql.ASTPathExpressionProto':
				if (!tablePathExpressions.has(node)) {
					summary.paths.push({
						names: node.names.map((name) => name.idString),
						range: range(node, byteToCharIndex),
					});
				}
				break;
			default:
				break;
		}
	});
	return summary;
}

// Visits every message in the tree, parents before children
function walk(node, visit) {
	if (node === null || typeof node !== 'object') {
		return;
	}
	if (Array.isArray(node)) {
		for (const item of node) {
			walk(item, visit);
		}
		return;
	}
	if (node.$typeName) {
		visit(node);
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === '$typeName' || key === '$unknown' || value === null || typeof value !== 'object') {
			continue;
		}
		// A oneof is { case, value }
		if ('case' in value && 'value' in value && !value.$typeName) {
			walk(value.value, visit);
		} else {
			walk(value, visit);
		}
	}
}

function range(node, byteToCharIndex) {
	let base = node;
	while (base?.parent) {
		base = base.parent;
	}
	const location = base?.parseLocationRange;
	if (!location) {
		return null;
	}
	return [byteToCharIndex(Number(location.start)), byteToCharIndex(Number(location.end))];
}
