import assert from 'node:assert/strict'
import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import test from 'node:test'
import { SlackCookieError, decryptChromiumCookie, readSlackCookie } from '../src/slack/cookies.js'
import type { KeychainAccess } from '../src/slack/keychain.js'
import { decodeBlock } from '../src/slack/leveldb/block.js'
import { readLog } from '../src/slack/leveldb/log.js'
import { decodeLocalStorageValue, localStorageKeyMatcher, readNewestValue } from '../src/slack/leveldb/reader.js'
import { SnappyError, snappyDecompress } from '../src/slack/leveldb/snappy.js'
import { readSsTable } from '../src/slack/leveldb/sstable.js'
import { SlackSessionStore, parseTeamsFromLocalConfig } from '../src/slack/session.js'

// ---------- snappy ----------

test('snappy: literal-only stream', () => {
	// preamble len=5, literal tag (4<<2)=0x10, "hello"
	const input = Uint8Array.from([0x05, 0x10, 0x68, 0x65, 0x6c, 0x6c, 0x6f])
	assert.equal(Buffer.from(snappyDecompress(input)).toString(), 'hello')
})

test('snappy: literal then copy', () => {
	// "abcdabcd": len=8, literal "abcd" (3<<2=0x0c), copy1 offset=4 len=4 (tag 0x01, low 0x04)
	const input = Uint8Array.from([0x08, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x01, 0x04])
	assert.equal(Buffer.from(snappyDecompress(input)).toString(), 'abcdabcd')
})

test('snappy: truncated input throws', () => {
	assert.throws(() => snappyDecompress(Uint8Array.from([0x05, 0x10, 0x68])), SnappyError)
})

// ---------- block ----------

function buildBlock(entries: { key: string; value: string }[]): Uint8Array {
	const parts: number[] = []
	let prev = ''
	for (const { key, value } of entries) {
		let shared = 0
		while (shared < prev.length && shared < key.length && prev[shared] === key[shared]) shared++
		const nonShared = key.length - shared
		parts.push(shared, nonShared, value.length)
		for (let i = shared; i < key.length; i++) parts.push(key.charCodeAt(i))
		for (let i = 0; i < value.length; i++) parts.push(value.charCodeAt(i))
		prev = key
	}
	// one restart point at 0, num_restarts=1
	parts.push(0, 0, 0, 0, 1, 0, 0, 0)
	return Uint8Array.from(parts)
}

test('block: decodes prefix-compressed entries', () => {
	const block = buildBlock([
		{ key: 'apple', value: '1' },
		{ key: 'apply', value: '2' },
	])
	const entries = decodeBlock(block)
	assert.equal(entries.length, 2)
	assert.equal(Buffer.from(entries[0].key).toString(), 'apple')
	assert.equal(Buffer.from(entries[1].key).toString(), 'apply')
	assert.equal(Buffer.from(entries[1].value).toString(), '2')
})

// ---------- log ----------

function internalLog(key: string, value: string, sequence: number): Uint8Array {
	// WriteBatch: seq(8) count(4) then [type=1, keyLen, key, valLen, value]
	const batch: number[] = []
	for (let i = 0; i < 8; i++) batch.push(i < 4 ? (sequence >>> (i * 8)) & 0xff : 0)
	batch.push(1, 0, 0, 0) // count = 1
	batch.push(1) // kTypeValue
	batch.push(key.length)
	for (const c of key) batch.push(c.charCodeAt(0))
	batch.push(value.length)
	for (const c of value) batch.push(c.charCodeAt(0))
	const data = Uint8Array.from(batch)
	// log record: checksum(4) length(2) type(1=FULL) data
	const rec: number[] = [0, 0, 0, 0, data.length & 0xff, (data.length >> 8) & 0xff, 1]
	return Uint8Array.from([...rec, ...data])
}

test('log: decodes a FULL write-batch record', () => {
	const entries = readLog(internalLog('k', 'v', 42))
	assert.equal(entries.length, 1)
	assert.equal(Buffer.from(entries[0].userKey).toString(), 'k')
	assert.equal(Buffer.from(entries[0].value).toString(), 'v')
	assert.equal(entries[0].sequence, 42)
	assert.equal(entries[0].type, 1)
})

// ---------- reader (newest sequence wins; Local Storage key + value encoding) ----------

test('reader: highest sequence wins across files', () => {
	const files: Record<string, Uint8Array> = {
		'000001.log': internalLog('_https://app.slack.com\u0000\u0001localConfig_v2', '\u0001old', 5),
		'000002.log': internalLog('_https://app.slack.com\u0000\u0001localConfig_v2', '\u0001new', 9),
	}
	const value = readNewestValue('dir', localStorageKeyMatcher('localConfig_v2'), {
		listFiles: () => Object.keys(files),
		readFile: path => files[path.split('/').at(-1) ?? ''] ?? new Uint8Array(),
	})
	assert.ok(value)
	assert.ok(value)
	assert.equal(decodeLocalStorageValue(value), 'new')
})

test('reader: utf16 value prefix', () => {
	const utf16 = Buffer.concat([Buffer.from([0]), Buffer.from('hi', 'utf16le')])
	assert.equal(decodeLocalStorageValue(new Uint8Array(utf16)), 'hi')
})

// ---------- sstable (minimal crafted table) ----------

function buildSsTable(entries: { key: string; value: string }[]): Uint8Array {
	const withTrailer = (body: Uint8Array): Uint8Array => Uint8Array.from([...body, 0, 0, 0, 0, 0]) // type=0 + crc
	// internal keys need an 8-byte tag (seq<<8 | type=1)
	const dataEntries = entries.map((e, i) => ({
		key: `${e.key}${String.fromCharCode(1, 0, 0, 0, 0, 0, 0, i + 1)}`.slice(0, e.key.length) + tag(i + 1),
		value: e.value,
	}))
	const data = withTrailer(buildBlock(dataEntries))
	// index: one entry whose value is the data block handle (offset 0, size = data body length)
	const bodyLen = data.length - 5
	const handle = [0, bodyLen] // varints (both < 128)
	const indexBody = buildBlockRaw([{ key: 'z'.repeat(10), value: String.fromCharCode(...handle) }])
	const index = withTrailer(indexBody)
	const metaBody = buildBlockRaw([])
	const meta = withTrailer(metaBody)
	const metaOffset = data.length
	const indexOffset = data.length + meta.length
	const footer = buildFooter(metaOffset, meta.length - 5, indexOffset, index.length - 5)
	return Uint8Array.from([...data, ...meta, ...index, ...footer])
}

function tag(seq: number): string {
	// 8-byte little-endian (seq<<8 | 1)
	let s = String.fromCharCode(1)
	let v = seq
	for (let i = 1; i < 8; i++) {
		s += String.fromCharCode(v & 0xff)
		v = Math.floor(v / 256)
	}
	return s
}

function buildBlockRaw(entries: { key: string; value: string }[]): Uint8Array {
	const parts: number[] = []
	let prev = ''
	for (const { key, value } of entries) {
		let shared = 0
		while (shared < prev.length && shared < key.length && prev[shared] === key[shared]) shared++
		parts.push(shared, key.length - shared, value.length)
		for (let i = shared; i < key.length; i++) parts.push(key.charCodeAt(i))
		for (let i = 0; i < value.length; i++) parts.push(value.charCodeAt(i))
		prev = key
	}
	parts.push(0, 0, 0, 0, 1, 0, 0, 0)
	return Uint8Array.from(parts)
}

function buildFooter(metaOff: number, metaSize: number, indexOff: number, indexSize: number): Uint8Array {
	const bytes: number[] = []
	const varint = (value: number) => {
		let n = value
		while (n >= 128) {
			bytes.push((n & 0x7f) | 0x80)
			n >>= 7
		}
		bytes.push(n)
	}
	varint(metaOff)
	varint(metaSize)
	varint(indexOff)
	varint(indexSize)
	while (bytes.length < 40) bytes.push(0)
	bytes.push(0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb)
	return Uint8Array.from(bytes)
}

test('sstable: reads a crafted uncompressed table', () => {
	const file = buildSsTable([{ key: 'name', value: 'Contember' }])
	const entries = readSsTable(file)
	const found = entries.find(e => Buffer.from(e.userKey).toString() === 'name')
	assert.ok(found, 'entry present')
	assert.equal(Buffer.from(found.value).toString(), 'Contember')
	assert.equal(found.type, 1)
})

// ---------- cookie decrypt ----------

function encryptV10(value: Buffer, password: string): Buffer {
	const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
	const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
	cipher.setAutoPadding(true)
	return Buffer.concat([Buffer.from('v10'), cipher.update(value), cipher.final()])
}

test('cookie: round-trips a v10 value', () => {
	const blob = encryptV10(Buffer.from('xoxd-abc123'), 'pw')
	assert.equal(decryptChromiumCookie(blob, 'pw', 'xoxd-'), 'xoxd-abc123')
})

test('cookie: strips the 32-byte domain-hash prefix', () => {
	const prefixed = Buffer.concat([Buffer.alloc(32, 7), Buffer.from('xoxd-withhash')])
	const blob = encryptV10(prefixed, 'pw')
	assert.equal(decryptChromiumCookie(blob, 'pw', 'xoxd-'), 'xoxd-withhash')
})

test('cookie: wrong key throws rather than returning garbage', () => {
	const blob = encryptV10(Buffer.from('xoxd-abc'), 'right')
	assert.throws(() => decryptChromiumCookie(blob, 'wrong', 'xoxd-'), SlackCookieError)
})

test('cookie: readSlackCookie picks the shortest slack host and decrypts', () => {
	const blob = encryptV10(Buffer.from('xoxd-pick'), 'pw')
	const value = readSlackCookie('ignored', 'pw', {
		queryRows: () => [
			{ host_key: 'files.slack.com', encrypted_value: Buffer.from('v10garbage') },
			{ host_key: '.slack.com', encrypted_value: blob },
		],
	})
	assert.equal(value, 'xoxd-pick')
})

// ---------- team parsing ----------

test('parseTeamsFromLocalConfig: keeps only xoxc tokens', () => {
	const text = JSON.stringify({
		teams: {
			T1: { id: 'T1', name: 'Contember', domain: 'cntmbr', token: 'xoxc-1', user_id: 'U1' },
			T2: { id: 'T2', name: 'NoToken', domain: 'x', user_id: 'U2' },
		},
	})
	const teams = parseTeamsFromLocalConfig(text)
	assert.equal(teams.length, 1)
	assert.equal(teams[0].teamId, 'T1')
	assert.equal(teams[0].name, 'Contember')
	assert.equal(teams[0].userId, 'U1')
})

// ---------- Helm session store (fake keychain) ----------

function fakeKeychain(): KeychainAccess {
	const store = new Map<string, string>()
	const k = (s: string, a: string) => `${s}\u0000${a}`
	return {
		read: async (s, a) => store.get(k(s, a)) ?? null,
		write: async (s, a, v) => void store.set(k(s, a), v),
		remove: async (s, a) => void store.delete(k(s, a)),
	}
}

test('SlackSessionStore: save, list, get, remove', async () => {
	const store = new SlackSessionStore(fakeKeychain())
	await store.save([
		{ teamId: 'T1', token: 'xoxc-1', cookie: 'xoxd-1', name: 'Contember', domain: 'cntmbr', userId: 'U1' },
	])
	assert.deepEqual(await store.list(), ['T1'])
	const got = await store.get('T1')
	assert.equal(got?.token, 'xoxc-1')
	assert.equal(got?.cookie, 'xoxd-1')
	await store.remove('T1')
	assert.deepEqual(await store.list(), [])
	assert.equal(await store.get('T1'), null)
})

test('snappy: an over-cap declared length throws instead of allocating', () => {
	// Preamble 0xffffffff0f = ~4 GiB declared length; must be refused, not allocated.
	assert.throws(() => snappyDecompress(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x0f, 0x00])), SnappyError)
})
