// Image headers for `helm open` (docs/plans/helm-open/spec.md, Formats: images). Pure and bounded: no node:, no
// DOM, no decode. The viewer's image worker reads width × height (and JPEG EXIF orientation) from the header
// before Chromium decodes anything; missing or contradictory dimensions, or more than 150 MP, refuse with the
// numbers. Main uses only `inspectPngStructure` (copy as PNG), which walks chunks and never inflates pixels.
import { type ImageType, PICTURE_WORDS, VIEWER_IMAGE_PIXELS, countText } from './formats.js'

export interface ImageHeader {
	type: ImageType
	/** Stored width and height, before EXIF orientation. */
	width: number
	height: number
	/** EXIF/HEIF orientation 1–8; 5–8 swap the displayed width and height. */
	orientation: number
	/** Several frames (APNG, animated GIF/WebP, AVIF sequence): Chromium shows the animation. */
	animated: boolean
}

/** A refusal with a reason meant for the window; never bytes or a stack. */
export class ImageHeaderError extends Error {
	override readonly name = 'ImageHeaderError'
}

const fail = (message: string): never => {
	throw new ImageHeaderError(message)
}
const u8 = (bytes: Uint8Array, at: number) => bytes[at] ?? 0
const be16 = (bytes: Uint8Array, at: number) => (u8(bytes, at) << 8) | u8(bytes, at + 1)
const le16 = (bytes: Uint8Array, at: number) => u8(bytes, at) | (u8(bytes, at + 1) << 8)
const be32 = (bytes: Uint8Array, at: number) => be16(bytes, at) * 0x10000 + be16(bytes, at + 2)
const le32 = (bytes: Uint8Array, at: number) => le16(bytes, at) + le16(bytes, at + 2) * 0x10000
const le24 = (bytes: Uint8Array, at: number) => u8(bytes, at) | (u8(bytes, at + 1) << 8) | (u8(bytes, at + 2) << 16)
const fourcc = (bytes: Uint8Array, at: number) =>
	String.fromCharCode(u8(bytes, at), u8(bytes, at + 1), u8(bytes, at + 2), u8(bytes, at + 3))
const need = (bytes: Uint8Array, end: number, what: string) => {
	if (end > bytes.length) fail(`The ${what} header is cut short.`)
}

/** Displayed size: orientations 5–8 turn the picture a quarter. */
export function displayedSize(header: Pick<ImageHeader, 'width' | 'height' | 'orientation'>) {
	return header.orientation >= 5
		? { width: header.height, height: header.width }
		: { width: header.width, height: header.height }
}

export const megapixels = (width: number, height: number) => (width * height) / 1_000_000

/** Width × height and the cap, as words for a refusal. */
export function pixelsText(width: number, height: number): string {
	const mp = megapixels(width, height)
	return `${countText(width)} × ${countText(height)} pixels (${mp >= 10 ? mp.toFixed(1) : mp.toFixed(2)} MP)`
}

/** The 150 MP cap, or null when the size is shown. */
export function pixelLimitRefusal(name: string, width: number, height: number): string | null {
	if (width * height <= VIEWER_IMAGE_PIXELS) return null
	return `${name} is ${pixelsText(width, height)}; Helm shows images up to ${VIEWER_IMAGE_PIXELS / 1_000_000} MP.`
}

/**
 * Width/height (and orientation) from the header of a raster the registry already typed. Throws `ImageHeaderError`
 * when the dimensions are missing, zero, or contradict each other within the file. Does not apply the pixel cap;
 * `admitImageHeader` does.
 */
export function readImageHeader(bytes: Uint8Array, type: ImageType): ImageHeader {
	switch (type) {
		case 'png':
			return png(bytes)
		case 'jpeg':
			return jpeg(bytes)
		case 'gif':
			return gif(bytes)
		case 'webp':
			return webp(bytes)
		case 'avif':
			return avif(bytes)
		case 'bmp':
			return bmp(bytes)
		case 'ico':
			return ico(bytes)
	}
	return fail('its type is unknown.')
}

/** Header check plus the pixel cap; the refusal names the file and the numbers. */
export function admitImageHeader(name: string, bytes: Uint8Array, type: ImageType): ImageHeader {
	let header: ImageHeader
	try {
		header = readImageHeader(bytes, type)
	} catch (error) {
		if (error instanceof ImageHeaderError) throw new ImageHeaderError(`${name} can't be shown: ${error.message}`)
		throw new ImageHeaderError(`${name} can't be shown: its ${PICTURE_WORDS[type]} header could not be read.`)
	}
	const refused = pixelLimitRefusal(name, header.width, header.height)
	if (refused) throw new ImageHeaderError(refused)
	return header
}

/**
 * Whether Chromium's decoded size agrees with the header: the same, or turned a quarter (orientation the browser
 * applies, which can come from metadata Helm does not read). GIF, ICO and AVIF pick a frame/entry/crop of their
 * own, so only a larger decode than the header allowed is a contradiction there.
 */
export function decodedAgrees(header: ImageHeader, width: number, height: number): boolean {
	const same = (w: number, h: number) => (w === width && h === height) || (w === height && h === width)
	if (header.type === 'gif' || header.type === 'ico' || header.type === 'avif')
		return width * height <= header.width * header.height && width > 0 && height > 0
	return same(header.width, header.height)
}

function sides(width: number, height: number, what: string): void {
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
		fail(`its ${what} header has no width and height (${width} × ${height}).`)
}

// PNG: IHDR is the first chunk. APNG adds acTL and fcTL; the first frame must fit the canvas.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
function png(bytes: Uint8Array): ImageHeader {
	need(bytes, 33, 'PNG')
	if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) fail('its PNG signature is missing.')
	if (be32(bytes, 8) !== 13 || fourcc(bytes, 12) !== 'IHDR') fail('its PNG header (IHDR) is missing.')
	const width = be32(bytes, 16)
	const height = be32(bytes, 20)
	sides(width, height, 'PNG')
	if (width > 0x7fffffff || height > 0x7fffffff) fail('its PNG header has an invalid size.')
	let animated = false
	let offset = 33
	for (let chunks = 0; chunks < 4096 && offset + 12 <= bytes.length; chunks++) {
		const length = be32(bytes, offset)
		const type = fourcc(bytes, offset + 4)
		if (length > bytes.length - offset - 12) break
		if (type === 'IDAT' || type === 'IEND') break
		if (type === 'IHDR') fail('it has two PNG headers.')
		if (type === 'acTL') animated = true
		if (type === 'fcTL' && length >= 26) {
			const frameWidth = be32(bytes, offset + 12)
			const frameHeight = be32(bytes, offset + 16)
			const x = be32(bytes, offset + 20)
			const y = be32(bytes, offset + 24)
			if (frameWidth < 1 || frameHeight < 1 || x + frameWidth > width || y + frameHeight > height)
				fail(
					`its first frame (${countText(frameWidth)} × ${countText(frameHeight)}) does not fit its ${countText(width)} × ${countText(height)} canvas.`,
				)
		}
		offset += 12 + length
	}
	return { type: 'png', width, height, orientation: 1, animated }
}

// JPEG: walk the marker segments to the first SOFn (C0–CF except C4 DHT, C8 JPG, CC DAC); APP1 Exif carries the
// orientation. Stops at SOS (scan data follows).
function jpeg(bytes: Uint8Array): ImageHeader {
	need(bytes, 4, 'JPEG')
	if (u8(bytes, 0) !== 0xff || u8(bytes, 1) !== 0xd8) fail('its JPEG start marker is missing.')
	let offset = 2
	let orientation = 1
	let frame: { width: number; height: number } | null = null
	for (let segments = 0; segments < 1024 && offset < bytes.length; segments++) {
		if (u8(bytes, offset) !== 0xff) fail('its JPEG markers are out of place.')
		while (u8(bytes, offset) === 0xff && offset < bytes.length) offset++
		const marker = u8(bytes, offset++)
		// A stuffed FF 00 or a byte that is no marker would make libjpeg rescan for the next FF while this walk
		// read a length: the two could reach different frames. Refuse instead of guessing.
		if (marker !== 0x01 && marker < 0xc0) fail('its JPEG markers are out of place.')
		if (marker === 0xd9 || marker === 0xda) break
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
		need(bytes, offset + 2, 'JPEG')
		const length = be16(bytes, offset)
		if (length < 2) fail('a JPEG segment has an invalid length.')
		need(bytes, offset + length, 'JPEG')
		const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
		if (isFrame) {
			if (length < 8) fail('its JPEG frame header is cut short.')
			const height = be16(bytes, offset + 3)
			const width = be16(bytes, offset + 5)
			if (frame && (frame.width !== width || frame.height !== height))
				fail(
					`it has two JPEG frames of different sizes (${countText(frame.width)} × ${countText(frame.height)} and ${countText(width)} × ${countText(height)}).`,
				)
			if (height === 0) fail('its height is given only after the image data (DNL), which Helm does not read.')
			frame = { width, height }
		} else if (marker === 0xe1 && orientation === 1) {
			orientation = exifOrientation(bytes.subarray(offset + 2, offset + length))
		}
		offset += length
	}
	if (!frame) fail('its JPEG frame header (SOF) is missing.')
	const { width, height } = frame as { width: number; height: number }
	sides(width, height, 'JPEG')
	return { type: 'jpeg', width, height, orientation, animated: false }
}

/** Orientation tag (0x0112) of IFD0 in an APP1 `Exif\0\0` payload; 1 when absent or unreadable. */
export function exifOrientation(payload: Uint8Array): number {
	if (fourcc(payload, 0) !== 'Exif' || u8(payload, 4) !== 0 || u8(payload, 5) !== 0) return 1
	const tiff = payload.subarray(6)
	const order = fourcc(tiff, 0).slice(0, 2)
	const little = order === 'II'
	if (!little && order !== 'MM') return 1
	const r16 = (at: number) => (little ? le16(tiff, at) : be16(tiff, at))
	const r32 = (at: number) => (little ? le32(tiff, at) : be32(tiff, at))
	if (r16(2) !== 42) return 1
	const ifd = r32(4)
	if (ifd < 8 || ifd + 2 > tiff.length) return 1
	const count = Math.min(r16(ifd), 512)
	for (let index = 0; index < count; index++) {
		const entry = ifd + 2 + index * 12
		if (entry + 12 > tiff.length) return 1
		if (r16(entry) !== 0x0112) continue
		const value = r16(entry + 8)
		return value >= 1 && value <= 8 ? value : 1
	}
	return 1
}

// GIF: the logical screen descriptor, and the first image descriptor, which may not lie outside it.
function gif(bytes: Uint8Array): ImageHeader {
	need(bytes, 13, 'GIF')
	const signature = fourcc(bytes, 0) + String.fromCharCode(u8(bytes, 4), u8(bytes, 5))
	if (signature !== 'GIF87a' && signature !== 'GIF89a') fail('its GIF signature is missing.')
	const width = le16(bytes, 6)
	const height = le16(bytes, 8)
	sides(width, height, 'GIF')
	const flags = u8(bytes, 10)
	let offset = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0)
	let frames = 0
	// Every limit refuses: a walk that stops early has not seen the first frame Chromium sizes its canvas by.
	const subBlocks = (limit: number) => {
		for (let sub = 0; sub < limit; sub++) {
			if (offset >= bytes.length) return
			const size = u8(bytes, offset)
			offset += 1 + size
			if (size === 0) return
		}
		fail('its GIF has more blocks than Helm reads.')
	}
	let blocks = 0
	while (offset < bytes.length && frames < 2) {
		if (++blocks > 100_000) fail('its GIF has more blocks than Helm reads.')
		const kind = u8(bytes, offset)
		if (kind === 0x3b) break
		if (kind === 0x21) {
			offset += 2
			subBlocks(100_000)
			continue
		}
		if (kind !== 0x2c) break
		need(bytes, offset + 10, 'GIF')
		frames++
		if (frames === 1) {
			const left = le16(bytes, offset + 1)
			const top = le16(bytes, offset + 3)
			const frameWidth = le16(bytes, offset + 5)
			const frameHeight = le16(bytes, offset + 7)
			if (left + frameWidth > width || top + frameHeight > height)
				fail(
					`its first frame (${countText(frameWidth)} × ${countText(frameHeight)} at ${left},${top}) lies outside its ${countText(width)} × ${countText(height)} screen.`,
				)
		}
		const local = u8(bytes, offset + 9)
		offset += 10 + (local & 0x80 ? 3 * 2 ** ((local & 7) + 1) : 0) + 1
		subBlocks(1_000_000)
	}
	if (frames === 0) fail('its GIF has no image.')
	return { type: 'gif', width, height, orientation: 1, animated: frames > 1 }
}

// WebP: RIFF/WEBP, then VP8 (lossy), VP8L (lossless) or VP8X (extended: canvas size, then the first frame).
function webp(bytes: Uint8Array): ImageHeader {
	need(bytes, 20, 'WebP')
	if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') fail('its WebP signature is missing.')
	const frame = (at: number): { width: number; height: number } | null => {
		const kind = fourcc(bytes, at)
		const data = at + 8
		if (kind === 'VP8 ') {
			need(bytes, data + 10, 'WebP')
			if (u8(bytes, data + 3) !== 0x9d || u8(bytes, data + 4) !== 0x01 || u8(bytes, data + 5) !== 0x2a)
				fail('its WebP (VP8) frame header is invalid.')
			return { width: le16(bytes, data + 6) & 0x3fff, height: le16(bytes, data + 8) & 0x3fff }
		}
		if (kind === 'VP8L') {
			need(bytes, data + 5, 'WebP')
			if (u8(bytes, data) !== 0x2f) fail('its WebP (VP8L) signature is invalid.')
			const bits = le32(bytes, data + 1)
			return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
		}
		return null
	}
	const first = fourcc(bytes, 12)
	if (first === 'VP8 ' || first === 'VP8L') {
		const size = frame(12) as { width: number; height: number }
		sides(size.width, size.height, 'WebP')
		return { type: 'webp', ...size, orientation: 1, animated: false }
	}
	if (first !== 'VP8X') fail('its WebP header (VP8, VP8L or VP8X) is missing.')
	need(bytes, 30, 'WebP')
	const flags = u8(bytes, 20)
	const animated = (flags & 0x02) !== 0
	const width = le24(bytes, 24) + 1
	const height = le24(bytes, 27) + 1
	sides(width, height, 'WebP')
	// A still extended WebP: its one frame must be the canvas size.
	if (!animated) {
		let offset = 12 + 8 + 10
		for (let chunks = 0; chunks < 64 && offset + 8 <= bytes.length; chunks++) {
			const size = frame(offset)
			if (size) {
				if (size.width !== width || size.height !== height)
					fail(
						`its canvas is ${countText(width)} × ${countText(height)} but its image is ${countText(size.width)} × ${countText(size.height)}.`,
					)
				break
			}
			const length = le32(bytes, offset + 4)
			offset += 8 + length + (length & 1)
		}
	}
	return { type: 'webp', width, height, orientation: 1, animated }
}

// AVIF (ISO-BMFF): the primary item's `ispe` property (pitm + ipma), turned by `irot`; an image sequence without
// still metadata falls back to the first track's `tkhd` size.
interface Box {
	type: string
	start: number
	body: number
	end: number
}
function boxes(bytes: Uint8Array, start: number, end: number, limit = 256): Box[] {
	const found: Box[] = []
	let offset = start
	while (offset + 8 <= end) {
		// A box past the limit could be the one libavif sizes the image by: refuse rather than stop reading.
		if (found.length >= limit) fail('its AVIF has more boxes than Helm reads.')
		let size = be32(bytes, offset)
		const type = fourcc(bytes, offset + 4)
		let body = offset + 8
		if (size === 1) {
			if (offset + 16 > end) break
			if (be32(bytes, offset + 8) !== 0) fail('an AVIF box is larger than Helm reads.')
			size = be32(bytes, offset + 12)
			body = offset + 16
		} else if (size === 0) size = end - offset
		if (size < body - offset || offset + size > end) {
			// A truncated box at the end of what was read: stop here.
			break
		}
		found.push({ type, start: offset, body, end: offset + size })
		offset += size
	}
	return found
}
function avif(bytes: Uint8Array): ImageHeader {
	const top = boxes(bytes, 0, bytes.length)
	if (top[0]?.type !== 'ftyp') fail('its AVIF file type box is missing.')
	// libavif may decode the image sequence instead of the still item (brand `avis`, or tracks it prefers), so every
	// track's tkhd size is read as well: it must match the still image, and without one the largest track counts.
	const moov = top.find(box => box.type === 'moov')
	const tracks = (moov ? boxes(bytes, moov.body, moov.end, 1024) : [])
		.filter(box => box.type === 'trak')
		.map(trak => boxes(bytes, trak.body, trak.end).find(box => box.type === 'tkhd'))
		.filter((box): box is Box => box !== undefined)
		.map(tkhd => {
			const version = u8(bytes, tkhd.body)
			const at = tkhd.body + (version === 1 ? 4 + 8 + 8 + 4 + 4 + 8 : 4 + 4 + 4 + 4 + 4 + 4) + 8 + 2 + 2 + 2 + 2 + 36
			need(bytes, at + 8, 'AVIF')
			const width = Math.floor(be32(bytes, at) / 65536)
			const height = Math.floor(be32(bytes, at + 4) / 65536)
			sides(width, height, 'AVIF')
			return { width, height }
		})
	const meta = top.find(box => box.type === 'meta')
	if (meta) {
		const inner = boxes(bytes, meta.body + 4, meta.end)
		const pitm = inner.find(box => box.type === 'pitm')
		const primary = pitm ? (u8(bytes, pitm.body) === 0 ? be16(bytes, pitm.body + 4) : be32(bytes, pitm.body + 4)) : null
		const iprp = inner.find(box => box.type === 'iprp')
		const ipco = iprp ? boxes(bytes, iprp.body, iprp.end).find(box => box.type === 'ipco') : undefined
		const properties = ipco ? boxes(bytes, ipco.body, ipco.end, 1024) : []
		const ipma = iprp ? boxes(bytes, iprp.body, iprp.end).find(box => box.type === 'ipma') : undefined
		let associated: number[] | null = null
		if (ipma && primary !== null) associated = ipmaFor(bytes, ipma, primary)
		const sizes = properties
			.map((box, index) => ({ box, index: index + 1 }))
			.filter(({ box }) => box.type === 'ispe' && box.body + 12 <= box.end)
		const pick = associated
			? sizes.filter(({ index }) => (associated as number[]).includes(index))
			: sizes.length > 0 &&
					sizes.every(
						({ box }) =>
							be32(bytes, box.body + 4) === be32(bytes, (sizes[0] as { box: Box }).box.body + 4) &&
							be32(bytes, box.body + 8) === be32(bytes, (sizes[0] as { box: Box }).box.body + 8),
					)
				? [sizes[0] as { box: Box; index: number }]
				: []
		if (pick.length > 1) fail('its primary AVIF image has two sizes.')
		const chosen = pick[0]
		if (!chosen && sizes.length > 0) fail('its AVIF sizes disagree and none is marked as the primary image.')
		if (chosen) {
			const width = be32(bytes, chosen.box.body + 4)
			const height = be32(bytes, chosen.box.body + 8)
			sides(width, height, 'AVIF')
			const irot = properties.findIndex(
				(box, index) => box.type === 'irot' && (!associated || associated.includes(index + 1)),
			)
			const angle = irot >= 0 ? u8(bytes, (properties[irot] as Box).body) & 3 : 0
			for (const track of tracks)
				if (!(track.width === width && track.height === height) && !(track.width === height && track.height === width))
					fail(
						`its AVIF still image (${countText(width)} × ${countText(height)}) and image sequence (${countText(track.width)} × ${countText(track.height)}) have different sizes.`,
					)
			return {
				type: 'avif',
				width,
				height,
				orientation: angle === 1 || angle === 3 ? 6 : 1,
				animated: tracks.length > 0,
			}
		}
	}
	const largest = tracks.reduce<{ width: number; height: number } | null>(
		(best, track) => (!best || track.width * track.height > best.width * best.height ? track : best),
		null,
	)
	if (largest) return { type: 'avif', width: largest.width, height: largest.height, orientation: 1, animated: true }
	return fail('its AVIF size (ispe) is missing.')
}
/** Property indices (1-based) associated with one item in an `ipma` box. */
function ipmaFor(bytes: Uint8Array, ipma: Box, item: number): number[] | null {
	const version = u8(bytes, ipma.body)
	const large = (u8(bytes, ipma.body + 3) & 1) === 1
	let offset = ipma.body + 4
	const count = be32(bytes, offset)
	offset += 4
	for (let entry = 0; entry < Math.min(count, 65536) && offset < ipma.end; entry++) {
		const id = version < 1 ? be16(bytes, offset) : be32(bytes, offset)
		offset += version < 1 ? 2 : 4
		const associations = u8(bytes, offset++)
		const indices: number[] = []
		for (let index = 0; index < associations; index++) {
			indices.push(large ? be16(bytes, offset) & 0x7fff : u8(bytes, offset) & 0x7f)
			offset += large ? 2 : 1
		}
		if (offset > ipma.end) return null
		if (id === item) return indices
	}
	return null
}

// BMP: BITMAPCOREHEADER (16-bit sizes) or a BITMAPINFOHEADER family (signed 32-bit; a negative height is top-down).
function bmp(bytes: Uint8Array): ImageHeader {
	need(bytes, 26, 'BMP')
	if (u8(bytes, 0) !== 0x42 || u8(bytes, 1) !== 0x4d) fail('its BMP signature is missing.')
	const headerSize = le32(bytes, 14)
	let width: number
	let height: number
	if (headerSize === 12) {
		width = le16(bytes, 18)
		height = le16(bytes, 20)
	} else if (headerSize >= 40 && headerSize <= 124) {
		need(bytes, 26, 'BMP')
		width = le32(bytes, 18) | 0
		height = Math.abs(le32(bytes, 22) | 0)
		if (width < 0) fail(`its BMP width is negative (${width}).`)
	} else return fail(`its BMP header has an unknown size (${headerSize} bytes).`)
	sides(width, height, 'BMP')
	return { type: 'bmp', width, height, orientation: 1, animated: false }
}

// ICO: the directory's largest entry; a width/height byte of 0 means 256, and an embedded PNG's IHDR (which may be
// larger) must agree with its directory entry.
function ico(bytes: Uint8Array): ImageHeader {
	need(bytes, 6, 'ICO')
	if (le16(bytes, 0) !== 0 || le16(bytes, 2) !== 1) fail('its ICO signature is missing.')
	const count = le16(bytes, 4)
	if (count < 1 || count > 256) fail(`its ICO directory has ${count} entries.`)
	need(bytes, 6 + count * 16, 'ICO')
	let width = 0
	let height = 0
	for (let index = 0; index < count; index++) {
		const entry = 6 + index * 16
		let entryWidth = u8(bytes, entry) || 256
		let entryHeight = u8(bytes, entry + 1) || 256
		const size = le32(bytes, entry + 8)
		const offset = le32(bytes, entry + 12)
		if (offset + size > bytes.length || size < 8) fail(`ICO entry ${index + 1} points outside the file.`)
		const image = bytes.subarray(offset, offset + Math.min(size, 64))
		if (PNG_SIGNATURE.every((byte, at) => image[at] === byte)) {
			const inner = png(bytes.subarray(offset, offset + size))
			const ok =
				(inner.width === entryWidth || (entryWidth === 256 && inner.width >= 256)) &&
				(inner.height === entryHeight || (entryHeight === 256 && inner.height >= 256))
			if (!ok)
				fail(
					`ICO entry ${index + 1} says ${entryWidth} × ${entryHeight} but holds a ${countText(inner.width)} × ${countText(inner.height)} PNG.`,
				)
			entryWidth = inner.width
			entryHeight = inner.height
		}
		if (entryWidth * entryHeight > width * height) {
			width = entryWidth
			height = entryHeight
		}
	}
	sides(width, height, 'ICO')
	return { type: 'ico', width, height, orientation: 1, animated: false }
}

/**
 * PNG structure without decoding (copy as PNG): signature, IHDR first with valid fields, every chunk inside the
 * bytes with a letters-only type (and a matching CRC when a CRC function is given), at least one IDAT, IEND last
 * at the exact end. Returns the size; throws `ImageHeaderError` otherwise.
 */
export function inspectPngStructure(
	bytes: Uint8Array,
	maxBytes: number,
	crc32?: (data: Uint8Array) => number,
): { width: number; height: number } {
	if (bytes.length < 57 || bytes.length > maxBytes) fail('The image is empty or too large to copy.')
	const header = png(bytes)
	const depth = u8(bytes, 24)
	const color = u8(bytes, 25)
	if (![1, 2, 4, 8, 16].includes(depth) || ![0, 2, 3, 4, 6].includes(color) || u8(bytes, 26) !== 0)
		fail('The image is not a valid PNG.')
	let offset = 8
	let data = false
	for (let chunks = 0; offset + 12 <= bytes.length && chunks < 1_000_000; chunks++) {
		const length = be32(bytes, offset)
		if (length > bytes.length - offset - 12) fail('The image is not a valid PNG.')
		const type = fourcc(bytes, offset + 4)
		if (!/^[A-Za-z]{4}$/.test(type)) fail('The image is not a valid PNG.')
		if (crc32 && crc32(bytes.subarray(offset + 4, offset + 8 + length)) >>> 0 !== be32(bytes, offset + 8 + length))
			fail('The image is not a valid PNG.')
		if (type === 'IDAT') data = true
		offset += 12 + length
		if (type === 'IEND') {
			if (offset !== bytes.length || !data) fail('The image is not a valid PNG.')
			return { width: header.width, height: header.height }
		}
	}
	return fail('The image is not a valid PNG.')
}
