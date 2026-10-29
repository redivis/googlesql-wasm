// An error from the parser, analyzer or formatter. googlesql reports the location at the end of the message as
//   "[at line:column]" (1-based) when it knows it; `line` and `column` are parsed out of it, and `detail` is the message
//   without the location.
const LOCATION_REGEX = /\s*\[at (\d+):(\d+)\]$/;

export default class GoogleSqlError extends Error {
	constructor(message) {
		super(message);
		this.name = 'GoogleSqlError';
		const match = message.match(LOCATION_REGEX);
		this.line = match ? Number(match[1]) : null;
		this.column = match ? Number(match[2]) : null;
		this.detail = match ? message.slice(0, match.index) : message;
	}
}
