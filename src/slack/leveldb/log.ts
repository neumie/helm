// LevelDB write-ahead log (`.log`) reader (read-only): 32 KiB blocks of length-prefixed records
// (checksum + length + type), reassembled into WriteBatches. Each batch is a sequence number, a
// count, then put/delete records. Recent Local Storage writes live here before compaction, so the
// newest `localConfig_v2` value may be in the log rather than an `.ldb`.

import type { SsTableEntry } from './sstable.js'
import { readVarint32 } from './varint.js'

const BLOCK_SIZE = 32768
const HEADER_SIZE = 7
const FULL = 1
const FIRST = 2
const MIDDLE = 3
const LAST = 4

/** Reassemble the log's records into raw WriteBatch buffers (checksums are not verified). */
function readRecords(file: Uint8Array): Uint8Array[] {
	const batches: Uint8Array[] = []
	let pos = 0
	let fragments: Uint8Array[] = []
	while (pos + HEADER_SIZE <= file.length) {
		const remaining = BLOCK_SIZE - (pos % BLOCK_SIZE)
		if (remaining < HEADER_SIZE) {
			// Trailer padding at the end of a block; jump to the next block.
			pos += remaining
			continue
		}
		const view = new DataView(file.buffer, file.byteOffset + pos, HEADER_SIZE)
		const length = view.getUint16(4, true)
		const type = view.getUint8(6)
		const dataStart = pos + HEADER_SIZE
		if (type === 0 && length === 0) {
			pos += remaining
			continue
		}
		if (dataStart + length > file.length) break
		const data = file.subarray(dataStart, dataStart + length)
		pos = dataStart + length
		if (type === FULL) {
			batches.push(data)
		} else if (type === FIRST) {
			fragments = [data]
		} else if (type === MIDDLE) {
			if (fragments.length > 0) fragments.push(data)
		} else if (type === LAST) {
			if (fragments.length > 0) {
				fragments.push(data)
				batches.push(concat(fragments))
				fragments = []
			}
		}
	}
	return batches
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0)
	const out = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		out.set(part, offset)
		offset += part.length
	}
	return out
}

/** Decode one WriteBatch into user key/value entries, numbering sequences from the batch header. */
function decodeBatch(batch: Uint8Array): SsTableEntry[] {
	if (batch.length < 12) return []
	const view = new DataView(batch.buffer, batch.byteOffset, 12)
	const seqLow = view.getUint32(0, true)
	const seqHigh = view.getUint32(4, true)
	const baseSequence = seqLow + seqHigh * 0x100000000
	const count = view.getUint32(8, true)
	const entries: SsTableEntry[] = []
	let pos = 12
	for (let i = 0; i < count && pos < batch.length; i++) {
		const type = batch[pos++] as number
		if (type === 1) {
			const keyLen = readVarint32(batch, pos)
			const key = batch.subarray(keyLen.next, keyLen.next + keyLen.value)
			const valLen = readVarint32(batch, keyLen.next + keyLen.value)
			const value = batch.subarray(valLen.next, valLen.next + valLen.value)
			pos = valLen.next + valLen.value
			entries.push({ userKey: key, value, sequence: safeSequence(baseSequence, i), type: 1 })
		} else if (type === 0) {
			const keyLen = readVarint32(batch, pos)
			const key = batch.subarray(keyLen.next, keyLen.next + keyLen.value)
			pos = keyLen.next + keyLen.value
			entries.push({ userKey: key, value: new Uint8Array(0), sequence: safeSequence(baseSequence, i), type: 0 })
		} else {
			break
		}
	}
	return entries
}

function safeSequence(base: number, offset: number): number {
	const seq = base + offset
	return Number.isSafeInteger(seq) ? seq : base
}

/** All put/delete entries in one `.log` file, in write order. */
export function readLog(file: Uint8Array): SsTableEntry[] {
	const entries: SsTableEntry[] = []
	for (const batch of readRecords(file)) {
		try {
			entries.push(...decodeBatch(batch))
		} catch {
			// A corrupt tail batch (a write in progress) must not lose the earlier ones.
		}
	}
	return entries
}
