import {
	IMAGE_PROCESSED_MAX_BYTES,
	IMAGE_PROCESSED_MAX_PIXELS,
	IMAGE_PROCESSED_MAX_SIDE,
	IMAGE_SOURCE_MAX_BYTES,
	IMAGE_SOURCE_MAX_PIXELS,
	IMAGE_SOURCE_MAX_SIDE,
} from './image-input-protocol.js'
export interface ImageDimensions {
	width: number
	height: number
}
const SOF = new Set([0xc0, 0xc1, 0xc2])
function dimensions(width: number, height: number, source: boolean): ImageDimensions {
	const side = source ? IMAGE_SOURCE_MAX_SIDE : IMAGE_PROCESSED_MAX_SIDE
	const pixels = source ? IMAGE_SOURCE_MAX_PIXELS : IMAGE_PROCESSED_MAX_PIXELS
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 1 ||
		height < 1 ||
		width > side ||
		height > side ||
		width * height > pixels
	)
		throw new Error('image_dimensions')
	return { width, height }
}
function u16(b: Uint8Array, p: number) {
	return ((b[p] as number) << 8) | (b[p + 1] as number)
}
function critical(type: string) {
	return type.length === 4 && type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90
}
export function inspectPng(bytes: Uint8Array, source = true): ImageDimensions {
	const max = source ? IMAGE_SOURCE_MAX_BYTES : IMAGE_PROCESSED_MAX_BYTES
	if (
		bytes.length < 45 ||
		bytes.length > max ||
		bytes[0] !== 137 ||
		bytes[1] !== 80 ||
		bytes[2] !== 78 ||
		bytes[3] !== 71 ||
		bytes[4] !== 13 ||
		bytes[5] !== 10 ||
		bytes[6] !== 26 ||
		bytes[7] !== 10
	)
		throw new Error('image_magic')
	let p = 8
	let chunks = 0
	let dims: ImageDimensions | undefined
	let seenIhdr = false
	let seenPlte = false
	let color = -1
	let depth = 0
	let idatBytes = 0
	let idat = false
	let ended = false
	let lastIdat = false
	while (p < bytes.length && chunks++ < 4096) {
		if (p + 12 > bytes.length) throw new Error('image_chunk')
		const len = new DataView(bytes.buffer, bytes.byteOffset + p, 4).getUint32(0)
		if (len > bytes.length - p - 12) throw new Error('image_chunk')
		const type = String.fromCharCode(
			bytes[p + 4] as number,
			bytes[p + 5] as number,
			bytes[p + 6] as number,
			bytes[p + 7] as number,
		)
		const data = p + 8
		if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) || (!seenIhdr && type !== 'IHDR')) throw new Error('image_chunk')
		if (type === 'IHDR') {
			if (seenIhdr || p !== 8 || len !== 13) throw new Error('image_header')
			seenIhdr = true
			const v = new DataView(bytes.buffer, bytes.byteOffset + data, 13)
			const w = v.getUint32(0)
			const h = v.getUint32(4)
			depth = v.getUint8(8)
			color = v.getUint8(9)
			const legal =
				(color === 0 && [1, 2, 4, 8, 16].includes(depth)) ||
				(color === 2 && [8, 16].includes(depth)) ||
				(color === 3 && [1, 2, 4, 8].includes(depth)) ||
				((color === 4 || color === 6) && [8, 16].includes(depth))
			if (!legal || v.getUint8(10) !== 0 || v.getUint8(11) !== 0 || ![0, 1].includes(v.getUint8(12)))
				throw new Error('image_encoding')
			dims = dimensions(w, h, source)
		} else if (type === 'PLTE') {
			if (
				!seenIhdr ||
				seenPlte ||
				idat ||
				color === 0 ||
				color === 4 ||
				len === 0 ||
				len % 3 !== 0 ||
				len > 768 ||
				(color === 3 && len / 3 > 2 ** depth)
			)
				throw new Error('image_chunk')
			seenPlte = true
		} else if (type === 'IDAT') {
			if (!seenIhdr || (color === 3 && !seenPlte) || (!lastIdat && idat)) throw new Error('image_chunk')
			idatBytes += len
			idat = true
			lastIdat = true
		} else if (type === 'IEND') {
			if (len !== 0 || !seenIhdr || !idat || idatBytes === 0 || ended || p + 12 !== bytes.length)
				throw new Error('image_end')
			ended = true
			break
		} else if (
			type === 'acTL' ||
			type === 'fcTL' ||
			type === 'fdAT' ||
			(critical(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type))
		)
			throw new Error('image_chunk')
		else lastIdat = false
		p += 12 + len
	}
	if (!ended || !dims) throw new Error('image_structure')
	return dims
}
interface JpegComponent {
	quantization: number
	coefficients: Uint8Array
}
interface JpegFrame {
	dims: ImageDimensions
	mode: number
	components: Map<number, JpegComponent>
}
function jpegFrame(bytes: Uint8Array, p: number, n: number, mode: number, source: boolean): JpegFrame {
	if (n < 8 || bytes[p + 2] !== 8 || (source && p + n > 256 * 1024)) throw new Error('image_header')
	const count = bytes[p + 7]
	if ((count !== 1 && count !== 3) || n !== 8 + 3 * count) throw new Error('image_header')
	const components = new Map<number, JpegComponent>()
	let blocks = 0
	for (let i = 0; i < count; i++) {
		const at = p + 8 + 3 * i
		const id = bytes[at] as number
		const sampling = bytes[at + 1] as number
		const quantization = bytes[at + 2] as number
		const horizontal = sampling >> 4
		const vertical = sampling & 15
		if (components.has(id) || horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4 || quantization > 3)
			throw new Error('image_header')
		blocks += horizontal * vertical
		components.set(id, { quantization, coefficients: new Uint8Array(64).fill(255) })
	}
	if (count > 1 && blocks > 10) throw new Error('image_header')
	return { dims: dimensions(u16(bytes, p + 5), u16(bytes, p + 3), source), mode, components }
}
function jpegQuantization(bytes: Uint8Array, p: number, n: number, tables: Map<number, number>): void {
	if (n < 67) throw new Error('image_table')
	let at = p + 2
	while (at < p + n) {
		const selector = bytes[at++] as number
		const precision = selector >> 4
		const id = selector & 15
		if (precision > 1 || id > 3) throw new Error('image_table')
		at += 64 * (precision + 1)
		if (at > p + n) throw new Error('image_table')
		tables.set(id, precision)
	}
}
function jpegHuffman(bytes: Uint8Array, p: number, n: number, tables: Set<number>): void {
	if (n < 20) throw new Error('image_table')
	let at = p + 2
	while (at < p + n) {
		const selector = bytes[at++] as number
		if (selector >> 4 > 1 || (selector & 15) > 3 || at + 16 > p + n) throw new Error('image_table')
		let symbols = 0
		let slots = 1
		for (let i = 0; i < 16; i++) {
			const count = bytes[at++] as number
			symbols += count
			slots = slots * 2 - count
			if (slots < 0) throw new Error('image_table')
		}
		if (symbols < 1 || symbols > 256 || at + symbols > p + n) throw new Error('image_table')
		at += symbols
		tables.add(selector)
	}
}
function jpegScan(
	bytes: Uint8Array,
	p: number,
	n: number,
	frame: JpegFrame,
	quantization: Map<number, number>,
	huffman: Set<number>,
): void {
	if (n < 8) throw new Error('image_scan')
	const count = bytes[p + 2] as number
	const ss = bytes[p + n - 3] as number
	const se = bytes[p + n - 2] as number
	const approximation = bytes[p + n - 1] as number
	const ah = approximation >> 4
	const al = approximation & 15
	const progressive = frame.mode === 0xc2
	if (
		count < 1 ||
		count > frame.components.size ||
		n !== 6 + 2 * count ||
		ss > se ||
		se > 63 ||
		ah > 13 ||
		al > 13 ||
		(progressive
			? (ss === 0 && se !== 0) || (ss > 0 && count !== 1) || (ah !== 0 && ah !== al + 1)
			: ss !== 0 || se !== 63 || ah !== 0 || al !== 0)
	)
		throw new Error('image_scan')
	const seen = new Set<number>()
	for (let i = 0; i < count; i++) {
		const id = bytes[p + 3 + 2 * i] as number
		const selector = bytes[p + 4 + 2 * i] as number
		const dc = selector >> 4
		const ac = selector & 15
		const component = frame.components.get(id)
		if (
			!component ||
			seen.has(id) ||
			dc > 3 ||
			ac > 3 ||
			!quantization.has(component.quantization) ||
			(frame.mode === 0xc0 && quantization.get(component.quantization) !== 0)
		)
			throw new Error('image_scan')
		seen.add(id)
		if (progressive) {
			if (
				(ss === 0 && ac !== 0) ||
				(ss > 0 && (dc !== 0 || component.coefficients[0] === 255)) ||
				(ss === 0 && ah === 0 && !huffman.has(dc)) ||
				(ss > 0 && !huffman.has(0x10 | ac))
			)
				throw new Error('image_scan')
		} else if (!huffman.has(dc) || !huffman.has(0x10 | ac)) throw new Error('image_scan')
		for (let coefficient = ss; coefficient <= se; coefficient++) {
			if (component.coefficients[coefficient] !== (ah === 0 ? 255 : ah)) throw new Error('image_scan')
			component.coefficients[coefficient] = al
		}
	}
}
/** Container/header validation only. Entropy decoding remains the browser/Pi codec's responsibility. */
export function inspectJpeg(bytes: Uint8Array, source = true): ImageDimensions {
	const max = source ? IMAGE_SOURCE_MAX_BYTES : IMAGE_PROCESSED_MAX_BYTES
	if (bytes.length < 4 || bytes.length > max || bytes[0] !== 255 || bytes[1] !== 216) throw new Error('image_magic')
	let p = 2
	let markers = 0
	let scans = 0
	let restartInterval = 0
	let frame: JpegFrame | undefined
	const quantization = new Map<number, number>()
	const huffman = new Set<number>()
	const countMarker = () => {
		if (++markers > 4096) throw new Error('image_markers')
	}
	while (p < bytes.length) {
		if (bytes[p++] !== 255) throw new Error('image_marker')
		while (p < bytes.length && bytes[p] === 255) p++
		if (p >= bytes.length) throw new Error('image_marker')
		const marker = bytes[p++] as number
		countMarker()
		if (marker === 0xd9) {
			if (
				!frame ||
				scans === 0 ||
				p !== bytes.length ||
				[...frame.components.values()].some(component => component.coefficients[0] === 255)
			)
				throw new Error('image_end')
			return frame.dims
		}
		// Only supported frame/table/scan markers and inert APP/COM metadata are permitted.
		if (!SOF.has(marker) && ![0xc4, 0xdb, 0xdd, 0xda, 0xfe].includes(marker) && !(marker >= 0xe0 && marker <= 0xef))
			throw new Error('image_marker')
		if (p + 2 > bytes.length) throw new Error('image_marker')
		const n = u16(bytes, p)
		if (n < 2 || p + n > bytes.length) throw new Error('image_marker')
		if (SOF.has(marker)) {
			if (frame) throw new Error('image_header')
			frame = jpegFrame(bytes, p, n, marker, source)
		} else if (marker === 0xdb) jpegQuantization(bytes, p, n, quantization)
		else if (marker === 0xc4) jpegHuffman(bytes, p, n, huffman)
		else if (marker === 0xdd) {
			if (n !== 4) throw new Error('image_restart')
			restartInterval = u16(bytes, p + 2)
		} else if (marker === 0xda) {
			if (!frame) throw new Error('image_scan')
			jpegScan(bytes, p, n, frame, quantization, huffman)
		}
		p += n
		if (marker !== 0xda) continue
		scans++
		let entropyBytes = 0
		let nextRestart = 0
		while (p < bytes.length) {
			if (bytes[p] !== 255) {
				p++
				entropyBytes++
				continue
			}
			let q = p + 1
			while (q < bytes.length && bytes[q] === 255) q++
			if (q >= bytes.length) throw new Error('image_end')
			if (bytes[q] === 0) {
				if (q !== p + 1) throw new Error('image_scan')
				entropyBytes++
				p = q + 1
				continue
			}
			if ((bytes[q] as number) >= 0xd0 && (bytes[q] as number) <= 0xd7) {
				countMarker()
				if (restartInterval === 0 || bytes[q] !== 0xd0 + nextRestart) throw new Error('image_restart')
				nextRestart = (nextRestart + 1) % 8
				p = q + 1
				continue
			}
			break // Preserve the full introducer/fill run for the outer marker walk.
		}
		if (entropyBytes === 0) throw new Error('image_scan')
	}
	throw new Error('image_structure')
}
export function inspectJpegForProcessed(bytes: Uint8Array) {
	return inspectJpeg(bytes, false)
}
