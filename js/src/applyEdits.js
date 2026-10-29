// Replaces ranges of text, e.g. the table and parameter references a parse found, with other text. Each edit is
//   { range: [start, end), text }; the ranges must not overlap. Returns the new text.
export default function applyEdits(text, edits) {
	const sorted = [...edits].sort((a, b) => b.range[0] - a.range[0]);
	let result = text;
	let previousStart = Infinity;
	for (const { range, text: replacement } of sorted) {
		const [start, end] = range;
		if (end > previousStart) {
			throw new Error(`Overlapping edits at ${start}-${end} and ${previousStart}`);
		}
		result = `${result.slice(0, start)}${replacement}${result.slice(end)}`;
		previousStart = start;
	}
	return result;
}
