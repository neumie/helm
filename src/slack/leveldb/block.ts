// LevelDB on-disk block decoding: a data/index block is prefix-compressed key/value entries
// followed by a restart-point array (and, in the file, a 1-byte compression type + 4-byte CRC
// trailer handled by the caller). Keys are delta-encoded against the previous key.

import { readVarint32 } from './varint.js'

export interface BlockEntry {
	key: Uint8Array
	value: Uint8Array
}

/** Iterate the entries of one already-decompressed block body (without its type/CRC trailer). */
export function decodeBlock(block: Uint8Array): BlockEntry[] {
	if (block.length < 4) throw new RangeError('block too small')
	const view = new DataView(block.buffer, block.byteOffset, block.byteLength)
	const numRestarts = view.getUint32(block.length - 4, true)
	const restartsBytes = (numRestarts + 1) * 4
	if (restartsBytes > block.length) throw new RangeError('block restart array overruns block')
	const entriesEnd = block.length - restartsBytes

	const entries: BlockEntry[] = []
	let pos = 0
	let prevKey = new Uint8Array(0)
	while (pos < entriesEnd) {
		const shared = readVarint32(block, pos)
		const nonShared = readVarint32(block, shared.next)
		const valueLen = readVarint32(block, nonShared.next)
		let p = valueLen.next
		if (shared.value > prevKey.length) throw new RangeError('shared key prefix exceeds previous key')
		if (p + nonShared.value + valueLen.value > entriesEnd) throw new RangeError('block entry overruns entries region')
		const key = new Uint8Array(shared.value + nonShared.value)
		key.set(prevKey.subarray(0, shared.value), 0)
		key.set(block.subarray(p, p + nonShared.value), shared.value)
		p += nonShared.value
		const value = block.subarray(p, p + valueLen.value)
		p += valueLen.value
		entries.push({ key, value })
		prevKey = key
		pos = p
	}
	return entries
}
