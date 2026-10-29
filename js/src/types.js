// Converts between googlesql TypeProto messages and BigQuery type strings (INT64, ARRAY<STRING>, STRUCT<a INT64, b
//   DATE>, RANGE<DATE>, ...). BigQuery has one integer and one floating point type, so the other widths map onto them.
import { TypeKind } from '../gen/googlesql/public/type_pb.js';

const SIMPLE_TYPE_KINDS = {
	INT64: TypeKind.TYPE_INT64,
	INT: TypeKind.TYPE_INT64,
	INTEGER: TypeKind.TYPE_INT64,
	SMALLINT: TypeKind.TYPE_INT64,
	BIGINT: TypeKind.TYPE_INT64,
	TINYINT: TypeKind.TYPE_INT64,
	BYTEINT: TypeKind.TYPE_INT64,
	FLOAT64: TypeKind.TYPE_DOUBLE,
	FLOAT: TypeKind.TYPE_DOUBLE,
	BOOL: TypeKind.TYPE_BOOL,
	BOOLEAN: TypeKind.TYPE_BOOL,
	STRING: TypeKind.TYPE_STRING,
	BYTES: TypeKind.TYPE_BYTES,
	DATE: TypeKind.TYPE_DATE,
	DATETIME: TypeKind.TYPE_DATETIME,
	TIME: TypeKind.TYPE_TIME,
	TIMESTAMP: TypeKind.TYPE_TIMESTAMP,
	GEOGRAPHY: TypeKind.TYPE_GEOGRAPHY,
	NUMERIC: TypeKind.TYPE_NUMERIC,
	DECIMAL: TypeKind.TYPE_NUMERIC,
	BIGNUMERIC: TypeKind.TYPE_BIGNUMERIC,
	BIGDECIMAL: TypeKind.TYPE_BIGNUMERIC,
	JSON: TypeKind.TYPE_JSON,
	INTERVAL: TypeKind.TYPE_INTERVAL,
};

const SIMPLE_TYPE_NAMES = {
	[TypeKind.TYPE_INT32]: 'INT64',
	[TypeKind.TYPE_INT64]: 'INT64',
	[TypeKind.TYPE_UINT32]: 'INT64',
	[TypeKind.TYPE_UINT64]: 'INT64',
	[TypeKind.TYPE_FLOAT]: 'FLOAT64',
	[TypeKind.TYPE_DOUBLE]: 'FLOAT64',
	[TypeKind.TYPE_BOOL]: 'BOOL',
	[TypeKind.TYPE_STRING]: 'STRING',
	[TypeKind.TYPE_BYTES]: 'BYTES',
	[TypeKind.TYPE_DATE]: 'DATE',
	[TypeKind.TYPE_DATETIME]: 'DATETIME',
	[TypeKind.TYPE_TIME]: 'TIME',
	[TypeKind.TYPE_TIMESTAMP]: 'TIMESTAMP',
	[TypeKind.TYPE_GEOGRAPHY]: 'GEOGRAPHY',
	[TypeKind.TYPE_NUMERIC]: 'NUMERIC',
	[TypeKind.TYPE_BIGNUMERIC]: 'BIGNUMERIC',
	[TypeKind.TYPE_JSON]: 'JSON',
	[TypeKind.TYPE_INTERVAL]: 'INTERVAL',
};

// TypeProto (as a protobuf-es message or plain object) -> BigQuery type string
export function typeToString(type) {
	const { typeKind } = type;
	if (typeKind === TypeKind.TYPE_ARRAY) {
		return `ARRAY<${typeToString(type.arrayType.elementType)}>`;
	}
	if (typeKind === TypeKind.TYPE_STRUCT) {
		const fields = type.structType.field.map(
			(field) => `${quoteFieldName(field.fieldName)} ${typeToString(field.fieldType)}`,
		);
		return `STRUCT<${fields.join(', ')}>`;
	}
	if (typeKind === TypeKind.TYPE_RANGE) {
		return `RANGE<${typeToString(type.rangeType.elementType)}>`;
	}
	const name = SIMPLE_TYPE_NAMES[typeKind];
	if (!name) {
		throw new Error(`Unsupported type kind ${TypeKind[typeKind] ?? typeKind}`);
	}
	return name;
}

// BigQuery type string -> TypeProto, as a plain object accepted by protobuf-es's create()
export function typeFromString(typeString) {
	const parser = new TypeStringParser(typeString);
	const type = parser.parseType();
	parser.skipWhitespace();
	if (!parser.atEnd()) {
		throw parser.error('Unexpected text after the type');
	}
	return type;
}

function quoteFieldName(name) {
	return /^[A-Za-z_]\w*$/.test(name) ? name : `\`${name.replace(/[\\`]/g, '\\$&')}\``;
}

class TypeStringParser {
	#text;
	#index = 0;

	constructor(text) {
		this.#text = text;
	}

	parseType() {
		const name = this.#readWord().toUpperCase();
		if (name === 'ARRAY') {
			this.#expect('<');
			const elementType = this.parseType();
			this.#expect('>');
			return { typeKind: TypeKind.TYPE_ARRAY, arrayType: { elementType } };
		}
		if (name === 'RANGE') {
			this.#expect('<');
			const elementType = this.parseType();
			this.#expect('>');
			return { typeKind: TypeKind.TYPE_RANGE, rangeType: { elementType } };
		}
		if (name === 'STRUCT') {
			this.#expect('<');
			const field = [];
			while (true) {
				const fieldName = this.#readWord();
				const fieldType = this.parseType();
				field.push({ fieldName, fieldType });
				this.skipWhitespace();
				if (this.#peek() === ',') {
					this.#index++;
					continue;
				}
				break;
			}
			this.#expect('>');
			return { typeKind: TypeKind.TYPE_STRUCT, structType: { field } };
		}
		const typeKind = SIMPLE_TYPE_KINDS[name];
		if (typeKind === undefined) {
			throw this.error(`Unknown type ${name}`);
		}
		// Parameterized types, e.g. STRING(10) or NUMERIC(5, 2), have the same TypeProto as the unparameterized type
		this.skipWhitespace();
		if (this.#peek() === '(') {
			const close = this.#text.indexOf(')', this.#index);
			if (close === -1) {
				throw this.error('Unclosed type parameter list');
			}
			this.#index = close + 1;
		}
		return { typeKind };
	}

	skipWhitespace() {
		while (/\s/.test(this.#peek() ?? '')) {
			this.#index++;
		}
	}

	atEnd() {
		return this.#index >= this.#text.length;
	}

	error(message) {
		return new Error(`${message} in type "${this.#text}" at position ${this.#index + 1}`);
	}

	#peek() {
		return this.#text[this.#index];
	}

	#expect(character) {
		this.skipWhitespace();
		if (this.#peek() !== character) {
			throw this.error(`Expected "${character}"`);
		}
		this.#index++;
	}

	// An identifier or type name, optionally backtick-quoted
	#readWord() {
		this.skipWhitespace();
		if (this.#peek() === '`') {
			let word = '';
			for (this.#index++; this.#index < this.#text.length; this.#index++) {
				const character = this.#text[this.#index];
				if (character === '\\') {
					word += this.#text[++this.#index] ?? '';
				} else if (character === '`') {
					this.#index++;
					return word;
				} else {
					word += character;
				}
			}
			throw this.error('Unclosed quoted name');
		}
		const match = this.#text.slice(this.#index).match(/^[A-Za-z_]\w*/);
		if (!match) {
			throw this.error('Expected a name');
		}
		this.#index += match[0].length;
		return match[0];
	}
}
