// LevelDB `.ldb` SSTable reader (read-only): footer → index block → data blocks → internal
// key/value entries. Each block on disk is followed by a 1-byte compression type and a 4-byte CRC
// (not verified here; we only read). Internal keys are `user_key` + an 8-byte tag
// `(sequence << 8) | type`, type 1 = value, 0 = deletion.

import { type BlockEntry, decodeBlock } from './block.js'
import { snappyDecompress } from './snappy.js'
import { readVarint32, readVarint64 } from './varint.js'

/** LevelDB table magic (little-endian 0xdb4775248b80fb57), the last 8 bytes of every `.ldb`. */
const TABLE_MAGIC = Uint8Array.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb])
const FOOTER_SIZE = 48

export interface SsTableEntry {
	/** The user key (internal key with its 8-byte tag stripped). */
	userKey: Uint8Array
	value: Uint8Array
	sequence: number
	/** 1 = value (put), 0 = deletion. */
	type: number
}

interface BlockHandle {
	offset: number
	size: number
}

function readBlockHandle(buf: Uint8Array, pos: number): { handle: BlockHandle; next: number } {
	const offset = readVarint64(buf, pos)
	const size = readVarint64(buf, offset.next)
	return { handle: { offset: offset.value, size: size.value }, next: size.next }
}

/** Read and decompress a block at `handle`; the on-disk trailer is type(1) + crc(4) after `size`. */
function readBlock(file: Uint8Array, handle: BlockHandle): Uint8Array {
	const end = handle.offset + handle.size
	if (end + 5 > file.length) throw new RangeError('block handle overruns file')
	const body = file.subarray(handle.offset, end)
	const type = file[end] as number
	if (type === 0) return body
	if (type === 1) return snappyDecompress(body)
	throw new RangeError(`unsupported block compression type ${type}`)
}

/** All value/deletion entries in one `.ldb` file, in table order. */
export function readSsTable(file: Uint8Array): SsTableEntry[] {
	if (file.length < FOOTER_SIZE) throw new RangeError('file smaller than footer')
	const footer = file.subarray(file.length - FOOTER_SIZE)
	for (let i = 0; i < 8; i++) {
		if (footer[FOOTER_SIZE - 8 + i] !== TABLE_MAGIC[i]) throw new RangeError('bad table magic (not a leveldb .ldb)')
	}
	// Footer: metaindex handle, index handle, then padding to 40 bytes, then the 8-byte magic.
	const metaindex = readBlockHandle(footer, 0)
	const index = readBlockHandle(footer, metaindex.next)
	const indexEntries = decodeBlock(readBlock(file, index.handle))

	const entries: SsTableEntry[] = []
	for (const indexEntry of indexEntries) {
		const { handle } = readBlockHandle(indexEntry.value, 0)
		let dataBlock: BlockEntry[]
		try {
			dataBlock = decodeBlock(readBlock(file, handle))
		} catch {
			// A single unreadable data block must not sink the whole file; skip it.
			continue
		}
		for (const entry of dataBlock) {
			const parsed = parseInternalKey(entry.key)
			if (parsed) entries.push({ ...parsed, value: entry.value })
		}
	}
	return entries
}

/** Split an internal key into user key + sequence + type; null if it lacks the 8-byte tag. */
export function parseInternalKey(key: Uint8Array): { userKey: Uint8Array; sequence: number; type: number } | null {
	if (key.length < 8) return null
	const tagStart = key.length - 8
	const view = new DataView(key.buffer, key.byteOffset + tagStart, 8)
	const low = view.getUint32(0, true)
	const high = view.getUint32(4, true)
	const type = low & 0xff
	// sequence is the top 56 bits; it stays well within Number.MAX_SAFE_INTEGER in practice.
	const sequence = Math.floor(low / 256) + high * 0x1000000
	return { userKey: key.subarray(0, tagStart), sequence, type }
}

export { readVarint32 }
