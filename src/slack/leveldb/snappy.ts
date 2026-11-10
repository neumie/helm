// Pure Snappy block decompressor (decompress only), for LevelDB `.ldb` data blocks whose trailer
// marks them Snappy-compressed. The format is small and fully specified:
// https://github.com/google/snappy/blob/main/format_description.txt
// A preamble varint gives the uncompressed length, then a stream of elements, each a tagged byte:
// literals (tag & 3 === 0) and back-references (copies, tags 1/2/3). No external dependency.

/** Thrown when the input is not valid Snappy (truncated, bad offset, wrong length). */
export class SnappyError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'SnappyError'
	}
}

export function snappyDecompress(input: Uint8Array): Uint8Array {
	let pos = 0
	// Preamble: the uncompressed length as a varint (little-endian base-128).
	let length = 0
	let shift = 0
	for (;;) {
		if (pos >= input.length) throw new SnappyError('truncated length preamble')
		const byte = input[pos++] as number
		length |= (byte & 0x7f) << shift
		if ((byte & 0x80) === 0) break
		shift += 7
		if (shift > 32) throw new SnappyError('length preamble too long')
	}
	length >>>= 0
	const out = new Uint8Array(length)
	let outPos = 0

	const copy = (offset: number, len: number): void => {
		if (offset === 0 || offset > outPos) throw new SnappyError('bad copy offset')
		if (outPos + len > length) throw new SnappyError('copy past end')
		let from = outPos - offset
		// Overlapping copies are byte-by-byte by definition (run-length semantics).
		for (let i = 0; i < len; i++) out[outPos++] = out[from++] as number
	}

	while (pos < input.length) {
		const tag = input[pos++] as number
		const type = tag & 0x03
		if (type === 0) {
			// Literal: the upper 6 bits are (length - 1), or a 1–4 byte little-endian length.
			let litLen = tag >> 2
			if (litLen >= 60) {
				const extra = litLen - 59
				if (pos + extra > input.length) throw new SnappyError('truncated literal length')
				let value = 0
				for (let i = 0; i < extra; i++) value |= (input[pos + i] as number) << (8 * i)
				pos += extra
				litLen = value >>> 0
			}
			litLen += 1
			if (pos + litLen > input.length) throw new SnappyError('truncated literal')
			if (outPos + litLen > length) throw new SnappyError('literal past end')
			out.set(input.subarray(pos, pos + litLen), outPos)
			outPos += litLen
			pos += litLen
		} else if (type === 1) {
			// Copy with 1-byte offset: length 4..11, offset 11 bits.
			const len = ((tag >> 2) & 0x07) + 4
			if (pos >= input.length) throw new SnappyError('truncated copy1')
			const offset = ((tag >> 5) << 8) | (input[pos++] as number)
			copy(offset, len)
		} else if (type === 2) {
			// Copy with 2-byte offset.
			const len = (tag >> 2) + 1
			if (pos + 2 > input.length) throw new SnappyError('truncated copy2')
			const offset = (input[pos] as number) | ((input[pos + 1] as number) << 8)
			pos += 2
			copy(offset, len)
		} else {
			// Copy with 4-byte offset.
			const len = (tag >> 2) + 1
			if (pos + 4 > input.length) throw new SnappyError('truncated copy4')
			const offset =
				((input[pos] as number) |
					((input[pos + 1] as number) << 8) |
					((input[pos + 2] as number) << 16) |
					((input[pos + 3] as number) << 24)) >>>
				0
			pos += 4
			copy(offset, len)
		}
	}
	if (outPos !== length) throw new SnappyError(`decompressed ${outPos}, expected ${length}`)
	return out
}
