import { deflateSync } from 'node:zlib'

// Baseline: authoring-time sips conversion of app/assets/remote/icon-192.png.
// Progressive: complete 1x1 gray DCT stream (component ID 0), independently decoded
// to pixel128 by macOS sips during authoring; no native tool is needed to run tests.
export const baselineJpeg = Buffer.from(
	'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',
	'base64',
)
export const progressiveJpeg = Buffer.from(
	'/9j/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wgALCAABAAEBABEA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQAAAAAAf//aAAgBAAABPwB//9k=',
	'base64',
)

export function jpegSegment(marker: number, payload: Uint8Array): Buffer {
	const header = Buffer.from([255, marker, 0, 0])
	header.writeUInt16BE(payload.length + 2, 2)
	return Buffer.concat([header, payload])
}
export function largeJpeg(): Buffer {
	const padding = jpegSegment(0xef, new Uint8Array(60_000))
	return Buffer.concat([baselineJpeg.subarray(0, 2), padding, padding, baselineJpeg.subarray(2)])
}
export function pngChunk(type: string, data: Uint8Array): Buffer {
	const kind = Buffer.from(type)
	const body = Buffer.concat([kind, data])
	let crc = 0xffffffff
	for (const byte of body) {
		crc ^= byte
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
	}
	const head = Buffer.alloc(4)
	head.writeUInt32BE(data.length)
	const tail = Buffer.alloc(4)
	tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
	return Buffer.concat([head, body, tail])
}
export const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
/** Actual 1x1 black image, not just a dimension header. Adam7 has only its first pass. */
export function smallPng(depth = 8, color = 0, interlace = 0, palette = true): Buffer {
	const header = Buffer.alloc(13)
	header.writeUInt32BE(1, 0)
	header.writeUInt32BE(1, 4)
	header[8] = depth
	header[9] = color
	header[12] = interlace
	const channels = color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 1
	const raw = Buffer.alloc(1 + Math.ceil((channels * depth) / 8))
	const parts = [pngSignature, pngChunk('IHDR', header)]
	if (palette && color === 3) parts.push(pngChunk('PLTE', new Uint8Array([0, 0, 0])))
	parts.push(pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', new Uint8Array()))
	return Buffer.concat(parts)
}
