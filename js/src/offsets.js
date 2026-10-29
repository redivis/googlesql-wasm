// googlesql reports locations as UTF-8 byte offsets; JavaScript strings are indexed by UTF-16 code unit. This maps the
//   former to the latter, with a fast path for ASCII-only text (where they coincide).
export default function createByteToCharIndex(text) {
	let isAscii = true;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 0x7f) {
			isAscii = false;
			break;
		}
	}
	if (isAscii) {
		return (byteOffset) => byteOffset;
	}

	// charAtByte[b] is the index of the character whose encoding contains byte b (a byte inside a multi-byte character
	//   maps to that character's start, so a range end that falls there still covers the character)
	const encodedLength = new TextEncoder().encode(text).length;
	const charAtByte = new Uint32Array(encodedLength + 1);
	let byteOffset = 0;
	for (let i = 0; i < text.length; i++) {
		const codePoint = text.codePointAt(i);
		const byteLength = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
		for (let k = 0; k < byteLength; k++) {
			charAtByte[byteOffset + k] = i;
		}
		byteOffset += byteLength;
		if (codePoint > 0xffff) {
			i++; // The low surrogate
		}
	}
	charAtByte[encodedLength] = text.length;
	return (byte) => charAtByte[Math.min(byte, encodedLength)];
}
