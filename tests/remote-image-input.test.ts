import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { inspectJpeg, inspectJpegForProcessed, inspectPng } from '../src/remote/image-input-bytes.js'
import { remoteImageReferenceSchema } from '../src/remote/image-input-protocol.js'
import { remoteOperationSchema } from '../src/remote/protocol.js'
import { baselineJpeg, jpegSegment, pngChunk, progressiveJpeg, smallPng } from './fixtures/remote-image-input.js'
function markerOffset(marker: number, data = baselineJpeg): number {
	let offset = 2
	while (offset < data.length) {
		assert.equal(data[offset], 255)
		if (data[offset + 1] === marker) return offset
		if (data[offset + 1] === 0xda) break
		offset += 2 + data.readUInt16BE(offset + 2)
	}
	throw new Error('Fixture marker missing')
}
function mutate(offset: number, value: number, data = baselineJpeg): Buffer {
	const result = Buffer.from(data)
	result[offset] = value
	return result
}
const sof = markerOffset(0xc0)
const sos = markerOffset(0xda)
const frame = baselineJpeg.subarray(sof, sof + 2 + baselineJpeg.readUInt16BE(sof + 2))
const scanLength = baselineJpeg.readUInt16BE(sos + 2)
test('genuine baseline/progressive images validate, including legal component ID zero', () => {
	assert.deepEqual(inspectJpegForProcessed(baselineJpeg), { width: 192, height: 192 })
	assert.deepEqual(inspectJpeg(progressiveJpeg), { width: 1, height: 1 })
	const padded = Buffer.concat([Buffer.alloc(7), progressiveJpeg, Buffer.alloc(9)])
	assert.deepEqual(inspectJpeg(padded.subarray(7, -9)), { width: 1, height: 1 })
})
for (const [label, inspect] of [
	['source', inspectJpeg],
	['processed', inspectJpegForProcessed],
] as const) {
	test(`progressive AC cannot precede initial DC (${label})`, () => {
		const first = markerOffset(0xda, progressiveJpeg)
		const second = first + 2 + progressiveJpeg.readUInt16BE(first + 2) + 1
		const reordered = Buffer.concat([
			progressiveJpeg.subarray(0, first),
			progressiveJpeg.subarray(second, -2),
			progressiveJpeg.subarray(first, second),
			progressiveJpeg.subarray(-2),
		])
		assert.deepEqual(inspect(progressiveJpeg), { width: 1, height: 1 })
		assert.throws(() => inspect(reordered))
	})
}

const invalidJpegs: Array<[string, () => Buffer]> = [
	['unsupported SOF', () => mutate(sof + 1, 0xc3)],
	[
		'late unsupported SOF',
		() => Buffer.concat([baselineJpeg.subarray(0, -2), mutate(1, 0xc3, frame), baselineJpeg.subarray(-2)]),
	],
	[
		'duplicate late supported SOF',
		() => Buffer.concat([baselineJpeg.subarray(0, -2), frame, baselineJpeg.subarray(-2)]),
	],
	['no scan', () => Buffer.concat([baselineJpeg.subarray(0, sos), Buffer.from([255, 217])])],
	['missing introducer', () => Buffer.concat([baselineJpeg.subarray(0, sof), baselineJpeg.subarray(sof + 1)])],
	['nested SOI', () => Buffer.concat([baselineJpeg.subarray(0, 2), Buffer.from([255, 216]), baselineJpeg.subarray(2)])],
	[
		'restart outside scan',
		() => Buffer.concat([baselineJpeg.subarray(0, 2), Buffer.from([255, 208]), baselineJpeg.subarray(2)]),
	],
	['invalid sampling nibble', () => mutate(sof + 11, 0x51)],
	['invalid quantization selector', () => mutate(sof + 12, 4)],
	['invalid scan component', () => mutate(sos + 5, 250)],
	['invalid scan table selector', () => mutate(sos + 6, 0x40)],
	['invalid baseline spectral selection', () => mutate(sos + 2 + scanLength - 3, 1)],
	['invalid baseline approximation', () => mutate(sos + 2 + scanLength - 1, 0x10)],
	['trailing bytes', () => Buffer.concat([baselineJpeg, Buffer.from([0])])],
	['missing entropy', () => Buffer.concat([baselineJpeg.subarray(0, sos + 2 + scanLength), Buffer.from([255, 217])])],
	[
		'old false-green pseudo-JPEG',
		() =>
			Buffer.from([
				255, 216, 255, 192, 0, 11, 8, 0, 2, 0, 2, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 1, 0, 0, 1, 2, 3, 255, 217,
			]),
	],
]
for (const [label, fixture] of invalidJpegs)
	test(`JPEG rejects ${label}`, () => assert.throws(() => inspectJpeg(fixture())))
test('dimension proof must complete within256KiB, not merely start before it', () => {
	const offset = markerOffset(0xc2, progressiveJpeg)
	const desired = 256 * 1024 - 6
	const total = desired - offset
	const pieces: Buffer[] = []
	let remaining = total
	while (remaining > 65537) {
		pieces.push(jpegSegment(0xef, new Uint8Array(65533)))
		remaining -= 65537
	}
	pieces.push(jpegSegment(0xef, new Uint8Array(remaining - 4)))
	const late = Buffer.concat([progressiveJpeg.subarray(0, offset), ...pieces, progressiveJpeg.subarray(offset)])
	assert.throws(() => inspectJpeg(late))
	// File size itself may exceed256KiB when dimensions were already proved.
	const early = Buffer.concat([
		progressiveJpeg.subarray(0, offset + 13),
		...pieces,
		progressiveJpeg.subarray(offset + 13),
	])
	assert.ok(early.length > 256 * 1024)
	assert.deepEqual(inspectJpeg(early), { width: 1, height: 1 })
})
test('restart markers count toward the shared marker budget', () => {
	const pieces = [
		baselineJpeg.subarray(0, sos),
		jpegSegment(0xdd, new Uint8Array([0, 1])),
		baselineJpeg.subarray(sos, sos + 2 + scanLength),
	]
	for (let i = 0; i < 4096; i++) pieces.push(Buffer.from([0, 255, 0xd0 + (i % 8)]))
	pieces.push(Buffer.from([255, 217]))
	assert.throws(() => inspectJpeg(Buffer.concat(pieces)), /image_markers/)
})
for (const [depth, color, interlace] of [
	[1, 0, 0],
	[1, 3, 0],
	[8, 3, 0],
	[16, 0, 0],
	[16, 2, 0],
	[16, 4, 0],
	[16, 6, 0],
	[8, 0, 1],
])
	test(`PNG supports depth${depth}/color${color}/interlace${interlace}`, () =>
		assert.deepEqual(inspectPng(smallPng(depth, color, interlace)), { width: 1, height: 1 }))
test('PNG validator needs no Node Buffer global', () => {
	const png = new Uint8Array(readFileSync(new URL('../app/assets/remote/icon-192.png', import.meta.url)))
	const buffer = globalThis.Buffer
	let result: unknown
	try {
		Reflect.set(globalThis, 'Buffer', undefined)
		result = inspectPng(png)
	} finally {
		Reflect.set(globalThis, 'Buffer', buffer)
	}
	assert.deepEqual(result, { width: 192, height: 192 })
})
test('PNG enforces palettes, reserved chunk bit, order and nonempty payload', () => {
	const gray = smallPng()
	const indexed = smallPng(1, 3)
	const empty = pngChunk('IDAT', new Uint8Array())
	const beforeData = gray.subarray(0, 33)
	const dataAndEnd = gray.subarray(33)
	for (const bad of [
		smallPng(1, 3, 0, false),
		Buffer.concat([beforeData, pngChunk('PLTE', new Uint8Array(3)), dataAndEnd]),
		Buffer.concat([indexed.subarray(0, 33), pngChunk('PLTE', new Uint8Array(9)), indexed.subarray(48)]),
		Buffer.concat([beforeData, pngChunk('tesT', new Uint8Array()), dataAndEnd]),
		Buffer.concat([gray.subarray(0, -12), pngChunk('tEXt', new Uint8Array()), empty, gray.subarray(-12)]),
		Buffer.concat([beforeData, empty, gray.subarray(-12)]),
		Buffer.concat([gray.subarray(0, 8), pngChunk('tEXt', new Uint8Array(8)), gray.subarray(8)]),
		Buffer.concat([beforeData, pngChunk('acTL', new Uint8Array(8)), dataAndEnd]),
		Buffer.concat([beforeData, pngChunk('ZZZZ', new Uint8Array()), dataAndEnd]),
		Buffer.concat([gray, Buffer.from([0])]),
	])
		assert.throws(() => inspectPng(bad))
	// Empty chunks are legal INSIDE a nonempty consecutive IDAT run.
	assert.deepEqual(inspectPng(Buffer.concat([beforeData, empty, dataAndEnd])), { width: 1, height: 1 })
})
test('prompt normalization and reference validation are independent of caption presence', () => {
	const ref = {
		handle: '00000000-0000-0000-0000-000000000001',
		sha256: 'a'.repeat(64),
		mimeType: 'image/jpeg',
		bytes: 1,
		width: 1,
		height: 1,
	}
	const prompt = { kind: 'prompt', text: ` ${'a'.repeat(16384)} `, delivery: 'followUp' }
	assert.equal(remoteOperationSchema.safeParse(prompt).success, true)
	assert.equal(remoteOperationSchema.safeParse({ ...prompt, text: '  ' }).success, false)
	for (const text of ['', 'caption']) {
		assert.equal(remoteOperationSchema.safeParse({ ...prompt, text, images: [ref] }).success, true)
		assert.equal(remoteOperationSchema.safeParse({ ...prompt, text, images: [ref, ref] }).success, false)
		assert.equal(
			remoteOperationSchema.safeParse({ ...prompt, text, images: [{ ...ref, width: 2560, height: 2560 }] }).success,
			false,
		)
	}
	assert.equal(remoteImageReferenceSchema.safeParse({ ...ref, width: 2560, height: 2560 }).success, false)
})
