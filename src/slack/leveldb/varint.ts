// LevelDB varints: little-endian base-128, as used in block entries, block handles and write
// batches. 32-bit reads cap at 5 bytes; 64-bit reads (sequence numbers) use a safe-integer accumulator.

export interface Varint {
	value: number
	next: number
}

/** Read a varint32 at `pos`; returns the value and the offset after it. */
export function readVarint32(buf: Uint8Array, pos: number): Varint {
	let value = 0
	let shift = 0
	let i = pos
	for (let b = 0; b < 5; b++) {
		if (i >= buf.length) throw new RangeError('truncated varint32')
		const byte = buf[i++] as number
		value |= (byte & 0x7f) << shift
		if ((byte & 0x80) === 0) return { value: value >>> 0, next: i }
		shift += 7
	}
	throw new RangeError('varint32 too long')
}

/** Read a varint up to 64 bits as a safe integer (sequence numbers stay well under 2^53). */
export function readVarint64(buf: Uint8Array, pos: number): Varint {
	let value = 0
	let mul = 1
	let i = pos
	for (let b = 0; b < 10; b++) {
		if (i >= buf.length) throw new RangeError('truncated varint64')
		const byte = buf[i++] as number
		value += (byte & 0x7f) * mul
		if ((byte & 0x80) === 0) {
			if (!Number.isSafeInteger(value)) throw new RangeError('varint64 exceeds safe integer')
			return { value, next: i }
		}
		mul *= 128
	}
	throw new RangeError('varint64 too long')
}
