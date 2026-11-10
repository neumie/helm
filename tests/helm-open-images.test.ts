// S3 of docs/plans/helm-open/spec.md: pictures. The header reader on real files of every raster format and on
// synthetic headers (missing/contradictory dimensions, the 150 MP cap with the numbers), extension × magic
// admission in main (no decode), the PNG structure check behind copy-as-PNG, and HEIC through the real `sips`.
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import documentModule from '../app/src/document-review/document'
import heicModule from '../app/src/document-review/heic'
import copyModule from '../app/src/document-review/image-copy'
import viewerModule from '../app/src/document-review/viewer-file'
import protocolModule from '../app/src/document-review/viewer-protocol'
import {
	type ImageType,
	VIEWER_IMAGE_PIXELS,
	detectViewerFormat,
	pictureMismatch,
	pictureTypeOf,
} from '../src/document-review/formats.js'
import {
	ImageHeaderError,
	admitImageHeader,
	decodedAgrees,
	displayedSize,
	exifOrientation,
	inspectPngStructure,
	pixelLimitRefusal,
	readImageHeader,
} from '../src/document-review/image-header.js'

const { helmPrivatePaths, readViewerFile } = viewerModule
const { ReviewDocumentObservation } = documentModule
const { ViewerFileTokens, handleViewerRequest } = protocolModule
const { convertHeic, memoryViewerSource, sipsDimensions } = heicModule
const { copyPngToClipboard } = copyModule

const IMAGES = join(import.meta.dirname, '../app/src/renderer/viewer/fixtures/images')
const bytesOf = (name: string) => readFile(join(IMAGES, name))
const darwin = process.platform === 'darwin'

// ---- builders for synthetic headers ------------------------------------------------------------------------------

const be32 = (value: number) => Buffer.from([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])
const be16 = (value: number) => Buffer.from([value >>> 8, value & 255])
const le16 = (value: number) => Buffer.from([value & 255, value >>> 8])
const le32 = (value: number) => Buffer.from([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24])
const le24 = (value: number) => Buffer.from([value & 255, (value >>> 8) & 255, (value >>> 16) & 255])
function chunk(type: string, data: Buffer): Buffer {
	const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
	return Buffer.concat([be32(data.length), typed, be32(crc32(typed) >>> 0)])
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function png(width: number, height: number, extra: Buffer[] = []): Buffer {
	const ihdr = Buffer.concat([be32(width), be32(height), Buffer.from([8, 2, 0, 0, 0])])
	return Buffer.concat([
		PNG_SIG,
		chunk('IHDR', ihdr),
		...extra,
		chunk('IDAT', deflateSync(Buffer.alloc(4))),
		chunk('IEND', Buffer.alloc(0)),
	])
}
function jpeg(segments: Buffer[]): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])])
}
const sof = (width: number, height: number, marker = 0xc0) =>
	Buffer.concat([
		Buffer.from([0xff, marker]),
		be16(11),
		Buffer.from([8]),
		be16(height),
		be16(width),
		Buffer.from([1, 1, 0x11, 0]),
	])
function box(type: string, ...parts: Buffer[]): Buffer {
	const body = Buffer.concat(parts)
	return Buffer.concat([be32(body.length + 8), Buffer.from(type, 'latin1'), body])
}
const full = (type: string, ...parts: Buffer[]) => box(type, Buffer.from([0, 0, 0, 0]), ...parts)
const ispe = (width: number, height: number) => full('ispe', be32(width), be32(height))
function avif(properties: Buffer[], associations: number[] | null, primary = 1): Buffer {
	const ftyp = box('ftyp', Buffer.from('avif', 'latin1'), be32(0), Buffer.from('avifmif1', 'latin1'))
	const ipco = box('ipco', ...properties)
	const ipma = associations
		? full('ipma', be32(1), be16(primary), Buffer.from([associations.length, ...associations]))
		: Buffer.alloc(0)
	const pitm = full('pitm', be16(primary))
	return Buffer.concat([ftyp, full('meta', pitm, box('iprp', ipco, ipma))])
}
function webpVp8x(canvasWidth: number, canvasHeight: number, frame: Buffer, flags = 0): Buffer {
	const vp8x = Buffer.concat([
		Buffer.from('VP8X', 'latin1'),
		le32(10),
		Buffer.from([flags, 0, 0, 0]),
		le24(canvasWidth - 1),
		le24(canvasHeight - 1),
	])
	const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), vp8x, frame])
	return Buffer.concat([Buffer.from('RIFF', 'latin1'), le32(body.length), body])
}
function vp8l(width: number, height: number): Buffer {
	const bits = (width - 1) | ((height - 1) << 14)
	const data = Buffer.concat([Buffer.from([0x2f]), le32(bits >>> 0), Buffer.alloc(3)])
	return Buffer.concat([Buffer.from('VP8L', 'latin1'), le32(data.length), data])
}

// ---- header reader on real files ---------------------------------------------------------------------------------

test('every raster format: width and height come from the real file header', async () => {
	const expected: [string, ImageType, number, number, number][] = [
		['company-create-error@2x.png', 'png', 2400, 1520, 1],
		['app-icon.png', 'png', 96, 96, 1],
		['form-error.jpg', 'jpeg', 760, 520, 1],
		['phone-photo-rotated.jpg', 'jpeg', 760, 520, 6],
		['form-error.gif', 'gif', 760, 520, 1],
		['form-error.webp', 'webp', 760, 520, 1],
		['form-error-lossless.webp', 'webp', 760, 520, 1],
		['form-error.avif', 'avif', 760, 520, 1],
		['form-error.bmp', 'bmp', 120, 80, 1],
		['favicon.ico', 'ico', 48, 48, 1],
	]
	for (const [name, type, width, height, orientation] of expected) {
		const bytes = await bytesOf(name)
		assert.equal(pictureTypeOf(bytes), type, name)
		const header = readImageHeader(bytes, type)
		assert.deepEqual([header.width, header.height, header.orientation], [width, height, orientation], name)
	}
})

test('EXIF orientation 6 turns the displayed size a quarter; the decoded size may be either way round', async () => {
	const header = readImageHeader(await bytesOf('phone-photo-rotated.jpg'), 'jpeg')
	assert.deepEqual(displayedSize(header), { width: 520, height: 760 })
	assert.equal(decodedAgrees(header, 520, 760), true)
	assert.equal(decodedAgrees(header, 760, 520), true)
	assert.equal(decodedAgrees(header, 761, 520), false)
	// Little-endian TIFF and a missing tag.
	const tiff = Buffer.concat([
		Buffer.from('II*\0', 'latin1'),
		le32(8),
		le16(1),
		le16(0x0112),
		le16(3),
		le32(1),
		le16(8),
		le16(0),
		le32(0),
	])
	assert.equal(exifOrientation(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])), 8)
	assert.equal(exifOrientation(Buffer.from('Exif\0\0MM\0\x2a\0\0\0\x08\0\0', 'latin1')), 1)
	assert.equal(exifOrientation(Buffer.from('XMP stuff', 'latin1')), 1)
})

// ---- missing and contradictory dimensions ------------------------------------------------------------------------

test('missing or contradictory dimensions refuse with the numbers, per format', () => {
	const refused: [string, Buffer, ImageType, RegExp][] = [
		['png zero width', png(0, 10), 'png', /no width and height \(0 × 10\)/],
		[
			'png no IHDR',
			Buffer.concat([PNG_SIG, chunk('IDAT', Buffer.alloc(13)), Buffer.alloc(16)]),
			'png',
			/IHDR\) is missing/,
		],
		['png cut short', png(10, 10).subarray(0, 20), 'png', /cut short/],
		[
			'apng frame outside canvas',
			png(100, 100, [
				chunk('acTL', Buffer.alloc(8)),
				chunk('fcTL', Buffer.concat([be32(0), be32(200), be32(100), be32(0), be32(0), Buffer.alloc(6)])),
			]),
			'png',
			/first frame \(200 × 100\) does not fit its 100 × 100 canvas/,
		],
		['jpeg no SOF', jpeg([]), 'jpeg', /frame header \(SOF\) is missing/],
		[
			'jpeg two sizes',
			jpeg([sof(640, 480), sof(800, 600, 0xc2)]),
			'jpeg',
			/two JPEG frames of different sizes \(640 × 480 and 800 × 600\)/,
		],
		['jpeg DNL height', jpeg([sof(640, 0)]), 'jpeg', /DNL/],
		['jpeg zero width', jpeg([sof(0, 480)]), 'jpeg', /no width and height \(0 × 480\)/],
		[
			'gif frame outside screen',
			Buffer.concat([
				Buffer.from('GIF89a', 'latin1'),
				le16(10),
				le16(10),
				Buffer.from([0, 0, 0]),
				Buffer.from([0x2c]),
				le16(5),
				le16(5),
				le16(10),
				le16(10),
				Buffer.from([0, 2, 2, 0x4c, 1, 0, 0x3b]),
			]),
			'gif',
			/first frame \(10 × 10 at 5,5\) lies outside its 10 × 10 screen/,
		],
		[
			'gif zero screen',
			Buffer.concat([Buffer.from('GIF89a', 'latin1'), le16(0), le16(0), Buffer.from([0, 0, 0, 0x3b])]),
			'gif',
			/no width and height \(0 × 0\)/,
		],
		[
			'webp canvas vs image',
			webpVp8x(640, 480, vp8l(320, 240)),
			'webp',
			/canvas is 640 × 480 but its image is 320 × 240/,
		],
		[
			'webp no frame header',
			Buffer.concat([Buffer.from('RIFF', 'latin1'), le32(12), Buffer.from('WEBPJUNK', 'latin1'), le32(0)]),
			'webp',
			/VP8, VP8L or VP8X\) is missing/,
		],
		['avif no ispe', avif([], null), 'avif', /AVIF size \(ispe\) is missing/],
		[
			'avif sizes disagree without association',
			avif([ispe(640, 480), ispe(1280, 960)], null),
			'avif',
			/sizes disagree/,
		],
		[
			'avif primary has two sizes',
			avif([ispe(640, 480), ispe(1280, 960)], [1, 2]),
			'avif',
			/primary AVIF image has two sizes/,
		],
		[
			'bmp unknown header',
			Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(12), le32(7), Buffer.alloc(16)]),
			'bmp',
			/unknown size \(7 bytes\)/,
		],
		[
			'bmp zero height',
			Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(12), le32(40), le32(10), le32(0), Buffer.alloc(30)]),
			'bmp',
			/no width and height \(10 × 0\)/,
		],
		[
			'ico entry says 16 but holds 32',
			(() => {
				const inner = png(32, 32)
				return Buffer.concat([
					le16(0),
					le16(1),
					le16(1),
					Buffer.from([16, 16, 0, 0]),
					le16(1),
					le16(32),
					le32(inner.length),
					le32(22),
					inner,
				])
			})(),
			'ico',
			/ICO entry 1 says 16 × 16 but holds a 32 × 32 PNG/,
		],
		[
			'ico points outside',
			Buffer.concat([le16(0), le16(1), le16(1), Buffer.from([16, 16, 0, 0]), le16(1), le16(32), le32(1000), le32(22)]),
			'ico',
			/points outside the file/,
		],
	]
	for (const [label, bytes, type, reason] of refused) {
		assert.throws(
			() => readImageHeader(bytes, type),
			(error: unknown) => {
				assert.ok(error instanceof ImageHeaderError, label)
				assert.match(error.message, reason, label)
				return true
			},
		)
	}
	// The primary item picks one of two different ispe boxes.
	const primary = readImageHeader(avif([ispe(640, 480), ispe(1280, 960)], [2]), 'avif')
	assert.deepEqual([primary.width, primary.height], [1280, 960])
	// irot 90° on the primary turns it.
	const turned = readImageHeader(avif([ispe(640, 480), box('irot', Buffer.from([1]))], [1, 2]), 'avif')
	assert.equal(displayedSize(turned).width, 480)
	// A still VP8X whose image matches its canvas is fine; an animated one is not compared.
	assert.equal(readImageHeader(webpVp8x(320, 240, vp8l(320, 240)), 'webp').width, 320)
	assert.equal(readImageHeader(webpVp8x(640, 480, vp8l(320, 240), 0x02), 'webp').animated, true)
})

// Review findings: walks that lose sync with the decoder, or stop early, would let a large frame past the cap.
const tkhd = (width: number, height: number) =>
	box('trak', box('tkhd', Buffer.alloc(24), Buffer.alloc(52), be32(width * 65536), be32(height * 65536)))
function avis(still: [number, number], track: [number, number]): Buffer {
	const ftyp = box('ftyp', Buffer.from('avis', 'latin1'), be32(0), Buffer.from('avifmif1msf1', 'latin1'))
	const pitm = full('pitm', be16(1))
	const ipma = full('ipma', be32(1), be16(1), Buffer.from([1, 1]))
	return Buffer.concat([
		ftyp,
		full('meta', pitm, box('iprp', box('ipco', ispe(...still)), ipma)),
		box('moov', tkhd(...track)),
	])
}
test('the header walk never loses sync with the decoder: stuffed JPEG bytes, padded GIFs, AVIF tracks', async () => {
	const refuses = (label: string, bytes: Buffer, type: ImageType, reason: RegExp) =>
		assert.throws(
			() => readImageHeader(bytes, type),
			(error: unknown) => error instanceof ImageHeaderError && reason.test(error.message),
			label,
		)
	// FF 00 where a marker belongs: libjpeg rescans for the next FF, a length-reading walk would skip a real SOF.
	const real = await bytesOf('form-error.jpg')
	const hidden = Buffer.concat([
		Buffer.from([0xff, 0xd8, 0xff, 0x00]),
		be16(real.length),
		real.subarray(2),
		sof(16, 16),
	])
	refuses('jpeg stuffed byte', jpeg([Buffer.from([0xff, 0x00]), sof(16, 16)]), 'jpeg', /markers are out of place/)
	refuses(
		'jpeg hidden frame',
		Buffer.concat([hidden, Buffer.from([0xff, 0xda, 0, 2])]),
		'jpeg',
		/markers are out of place/,
	)
	refuses(
		'jpeg non-marker byte',
		jpeg([Buffer.from([0xff, 0x7f, 0, 2]), sof(16, 16)]),
		'jpeg',
		/markers are out of place/,
	)
	// GIF: the frame Chromium sizes its canvas by must have been checked.
	const screen = Buffer.concat([Buffer.from('GIF89a', 'latin1'), le16(1), le16(1), Buffer.from([0, 0, 0])])
	const bigFrame = Buffer.concat([
		Buffer.from([0x2c]),
		le16(0),
		le16(0),
		le16(20000),
		le16(20000),
		Buffer.from([0, 2, 2, 0x4c, 1, 0, 0x3b]),
	])
	refuses('gif frame outside', Buffer.concat([screen, bigFrame]), 'gif', /lies outside its 1 × 1 screen/)
	const padding = Buffer.alloc(3 * 100_000)
	for (let at = 0; at < padding.length; at += 3) padding.set([0x21, 0xfe, 0x00], at)
	refuses(
		'gif padded past the block limit',
		Buffer.concat([screen, padding, bigFrame]),
		'gif',
		/more blocks than Helm reads/,
	)
	const subBlocks = Buffer.alloc(2 * 100_000)
	for (let at = 0; at < subBlocks.length; at += 2) subBlocks.set([0x01, 0x00], at)
	refuses(
		'gif extension past the sub-block limit',
		Buffer.concat([screen, Buffer.from([0x21, 0xfe]), subBlocks, Buffer.from([0x3b]), bigFrame]),
		'gif',
		/more blocks than Helm reads/,
	)
	refuses('gif without a frame', Buffer.concat([screen, Buffer.from([0x3b])]), 'gif', /has no image/)
	// AVIF: the image sequence must match the still item; without one the largest track counts.
	refuses(
		'avis still vs track',
		avis([100, 100], [16000, 16000]),
		'avif',
		/still image \(100 × 100\) and image sequence \(16,000 × 16,000\)/,
	)
	assert.equal(readImageHeader(avis([640, 480], [640, 480]), 'avif').animated, true)
	const sequence = Buffer.concat([
		box('ftyp', Buffer.from('avis', 'latin1'), be32(0), Buffer.from('avis', 'latin1')),
		box('moov', tkhd(320, 240), tkhd(16000, 16000)),
	])
	assert.throws(() => admitImageHeader('seq.avif', sequence, 'avif'), /16,000 × 16,000 pixels \(256.0 MP\)/)
	const crowded = Buffer.concat([avif([ispe(640, 480)], [1]), ...Array.from({ length: 300 }, () => box('free'))])
	refuses('avif past the box limit', crowded, 'avif', /more boxes than Helm reads/)
})

test('151 MP refuses with the numbers before any decode; exactly 150 MP is shown', async () => {
	const big = await bytesOf('panorama-151mp.png')
	assert.throws(
		() => admitImageHeader('panorama-151mp.png', big, 'png'),
		/panorama-151mp\.png is 15,100 × 10,000 pixels \(151\.0 MP\); Helm shows images up to 150 MP\./,
	)
	assert.equal(pixelLimitRefusal('a.png', 15_000, 10_000), null)
	assert.equal(15_000 * 10_000, VIEWER_IMAGE_PIXELS)
	assert.match(pixelLimitRefusal('a.png', 15_001, 10_000) ?? '', /15,001 × 10,000 pixels \(150\.0 MP\)/)
	assert.equal(admitImageHeader('ok.png', png(15_000, 10_000), 'png').width, 15_000)
	assert.throws(
		() => admitImageHeader('x.jpg', jpeg([]), 'jpeg'),
		/^ImageHeaderError: x\.jpg can't be shown: its JPEG frame header/,
	)
	// Every format's cap, through its own header.
	assert.throws(
		() => admitImageHeader('w.webp', webpVp8x(16_384, 10_000, vp8l(1, 1), 0x02), 'webp'),
		/16,384 × 10,000 pixels \(163\.8 MP\)/,
	)
	assert.throws(
		() => admitImageHeader('a.avif', avif([ispe(20_000, 8_000)], [1]), 'avif'),
		/20,000 × 8,000 pixels \(160\.0 MP\)/,
	)
})

// ---- registry: extension × magic ---------------------------------------------------------------------------------

test('pictures are shown now; extension and magic must agree, refusals say what the bytes are', async () => {
	const shown: Record<string, [string, string]> = {
		'shot.PNG': ['image', 'png'],
		'photo.jpeg': ['image', 'jpeg'],
		'icon.ico': ['image', 'ico'],
		'logo.svg': ['svg', 'svg'],
		'IMG_0001.HEIC': ['heic', 'heic'],
		'clip.avif': ['image', 'avif'],
	}
	for (const [name, [format, language]] of Object.entries(shown)) {
		const detected = detectViewerFormat(name)
		assert.ok(detected.ok, name)
		assert.deepEqual([detected.entry.format, detected.language], [format, language], name)
	}
	const jpg = await bytesOf('form-error.jpg')
	assert.equal(
		pictureMismatch('invoice.png', 'png', jpg),
		'invoice.png is not a PNG image (it starts like a JPEG image).',
	)
	assert.equal(
		pictureMismatch('clip.avif', 'avif', await bytesOf('form-error.heic')),
		'clip.avif is not an AVIF image (it starts like a HEIC image).',
	)
	assert.equal(
		pictureMismatch('IMG.heic', 'heic', await bytesOf('form-error.avif')),
		'IMG.heic is not a HEIC image (it starts like an AVIF image).',
	)
	assert.equal(pictureMismatch('a.gif', 'gif', Buffer.from('hello')), 'a.gif is not a GIF image.')
	assert.equal(pictureMismatch('a.png', 'png', await bytesOf('app-icon.png')), null)
})

// ---- main-process admission: no decode -------------------------------------------------------------------------

async function fixture() {
	const base = await realpath(await mkdtemp('/tmp/hoi-'))
	const home = join(base, 'home')
	const docs = join(base, 'docs')
	for (const dir of [join(home, '.helm'), join(home, 'userData'), join(base, 'daemon'), join(base, 'tmp'), docs])
		await mkdir(dir, { recursive: true })
	const paths = await helmPrivatePaths({
		home,
		userData: join(home, 'userData'),
		daemonRoots: [join(base, 'daemon')],
		authFile: join(home, '.helm', 'local-api-token'),
		uid: process.getuid?.() ?? 501,
		tmp: join(base, 'tmp'),
	})
	return { base, docs, paths, close: () => rm(base, { recursive: true, force: true }) }
}

test('plain admission reads only the signature of a picture; mismatches, empty files and non-SVG text refuse', async () => {
	const f = await fixture()
	try {
		await writeFile(join(f.docs, 'shot.png'), await bytesOf('company-create-error@2x.png'))
		const read = await readViewerFile(join(f.docs, 'shot.png'), f.paths)
		assert.deepEqual([read.format, read.language, read.text, read.size], ['image', 'png', '', 96852])
		await writeFile(join(f.docs, 'invoice.png'), await bytesOf('form-error.jpg'))
		await assert.rejects(
			readViewerFile(join(f.docs, 'invoice.png'), f.paths),
			/invoice\.png is not a PNG image \(it starts like a JPEG image\)/,
		)
		await writeFile(join(f.docs, 'empty.gif'), '')
		await assert.rejects(readViewerFile(join(f.docs, 'empty.gif'), f.paths), /empty\.gif is (empty|not a GIF image)/)
		await writeFile(join(f.docs, 'logo.svg'), await bytesOf('release-badge.svg'))
		const svg = await readViewerFile(join(f.docs, 'logo.svg'), f.paths)
		assert.deepEqual([svg.format, svg.language], ['svg', 'svg'])
		await writeFile(join(f.docs, 'page.svg'), '<html><body>not svg</body></html>')
		await assert.rejects(
			readViewerFile(join(f.docs, 'page.svg'), f.paths),
			/page\.svg is not an SVG image \(it has no <svg> element\)/,
		)
		// A namespace-prefixed root is still an SVG.
		await writeFile(
			join(f.docs, 'prefixed.svg'),
			'<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="4" height="4"><svg:rect width="4" height="4"/></svg:svg>',
		)
		assert.equal((await readViewerFile(join(f.docs, 'prefixed.svg'), f.paths)).format, 'svg')
		await writeFile(join(f.docs, 'zipped.svg'), Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]))
		await assert.rejects(readViewerFile(join(f.docs, 'zipped.svg'), f.paths), /not a text file|not valid UTF-8/)
		// The pixel cap is the header worker's: main admits the 151 MP header untouched (no decode in main).
		await writeFile(join(f.docs, 'pano.png'), await bytesOf('panorama-151mp.png'))
		assert.equal((await readViewerFile(join(f.docs, 'pano.png'), f.paths)).format, 'image')
	} finally {
		await f.close()
	}
})

test('a picture window serves the file bytes by token with its declared type; a change replaces the token', async () => {
	const f = await fixture()
	const file = join(f.docs, 'icon.png')
	await writeFile(file, await bytesOf('app-icon.png'))
	const tokens = new ViewerFileTokens()
	const observation = new ReviewDocumentObservation(f.docs, file, () => {}, {
		paths: f.paths,
		displayPath: file,
		tokens,
	})
	try {
		await observation.start()
		const doc = observation.current()
		assert.equal(doc.format, 'image')
		assert.equal(doc.viewer, undefined)
		const picture = doc.picture
		assert.ok(picture)
		const icon = await bytesOf('app-icon.png')
		assert.deepEqual(
			[picture.type, picture.mime, picture.size, picture.fileSize],
			['png', 'image/png', icon.length, icon.length],
		)
		const ask = (url: string) => handleViewerRequest(new Request(url), { tokens, readAsset: async () => null })
		const response = await ask(picture.url)
		assert.equal(response.status, 200)
		assert.equal(response.headers.get('content-type'), 'application/octet-stream')
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), await bytesOf('app-icon.png'))
		await writeFile(file, await bytesOf('company-create-error@2x.png'))
		await observation.refresh()
		const next = observation.current().picture
		assert.ok(next && next.url !== picture.url)
		assert.equal(next.size, 96852)
		assert.equal((await ask(picture.url)).status, 404)
		// SVG: served as its own bytes, typed image/svg+xml for the <img>.
		const svgFile = join(f.docs, 'badge.svg')
		await writeFile(svgFile, await bytesOf('release-badge.svg'))
		const svg = new ReviewDocumentObservation(f.docs, svgFile, () => {}, {
			paths: f.paths,
			displayPath: svgFile,
			tokens,
		})
		await svg.start()
		assert.deepEqual([svg.current().picture?.type, svg.current().picture?.mime], ['svg', 'image/svg+xml'])
		await svg.dispose()
	} finally {
		await observation.dispose()
		await f.close()
	}
})

// ---- HEIC through sips -------------------------------------------------------------------------------------------

test('sips output parsing', () => {
	assert.deepEqual(sipsDimensions('/x/a.heic\n  pixelWidth: 4032\n  pixelHeight: 3024\n'), {
		width: 4032,
		height: 3024,
	})
	assert.equal(sipsDimensions('/x/a.heic\n  pixelWidth: <nil>\n'), null)
	assert.equal(sipsDimensions(''), null)
})

test('a real HEIC converts to PNG through /usr/bin/sips and is served as image/png', { skip: !darwin }, async () => {
	const f = await fixture()
	const file = join(f.docs, 'IMG_0412.HEIC')
	await writeFile(file, await bytesOf('form-error.heic'))
	const tokens = new ViewerFileTokens()
	const observation = new ReviewDocumentObservation(f.docs, file, () => {}, {
		paths: f.paths,
		displayPath: file,
		tokens,
	})
	try {
		await observation.start()
		const picture = observation.current().picture
		assert.ok(picture, observation.current().error ?? 'no picture')
		assert.deepEqual([picture.type, picture.mime, picture.pixels], ['heic', 'image/png', { width: 760, height: 520 }])
		assert.equal(picture.fileSize, 7442)
		const response = await handleViewerRequest(new Request(picture.url), { tokens, readAsset: async () => null })
		const png = new Uint8Array(await response.arrayBuffer())
		assert.equal(png.length, picture.size)
		assert.deepEqual(
			inspectPngStructure(png, 64 * 1024 * 1024, data => crc32(data)),
			{ width: 760, height: 520 },
		)
		// Nothing changed: a refresh converts nothing and keeps the token.
		await observation.refresh()
		assert.equal(observation.current().picture?.url, picture.url)
	} finally {
		await observation.dispose()
		await f.close()
	}
})

async function fakeSips(dir: string, script: string): Promise<string> {
	const path = join(dir, 'sips')
	await writeFile(path, `#!/bin/sh\n${script}\n`)
	await chmod(path, 0o755)
	return path
}

test('HEIC refusals: empty conversion, the 150 MP cap with numbers, an unreadable file, a stuck child', async () => {
	const f = await fixture()
	try {
		const source = memoryViewerSource(await bytesOf('form-error.heic'))
		const probe = 'if [ "$1" = "-g" ]; then echo "$5"; echo "  pixelWidth: 760"; echo "  pixelHeight: 520"; exit 0; fi'
		const empty = await fakeSips(f.base, `${probe}\nfor a; do out="$a"; done; : > "$out"`)
		await assert.rejects(
			convertHeic('IMG.heic', source, { sips: empty }),
			/IMG\.heic can't be shown: the conversion produced nothing\./,
		)
		const huge = await fakeSips(
			join(await mkdtemp(join(f.base, 'h-'))),
			'echo x; echo "  pixelWidth: 15100"; echo "  pixelHeight: 10000"',
		)
		await assert.rejects(
			convertHeic('IMG.heic', source, { sips: huge }),
			/IMG\.heic is 15,100 × 10,000 pixels \(151\.0 MP\); Helm shows images up to 150 MP\./,
		)
		const broken = await fakeSips(join(await mkdtemp(join(f.base, 'b-'))), 'exit 13')
		await assert.rejects(convertHeic('IMG.heic', source, { sips: broken }), /macOS could not read it as a HEIC image/)
		const stuck = await fakeSips(join(await mkdtemp(join(f.base, 's-'))), `${probe}\nsleep 5`)
		await assert.rejects(
			convertHeic('IMG.heic', source, { sips: stuck, convertMs: 200 }),
			/macOS could not convert it to PNG/,
		)
		// helm open's batch budget: an aborted signal kills the child and refuses by name, never "unreadable".
		const budget = new AbortController()
		const converting = convertHeic('IMG.heic', source, { sips: stuck, signal: budget.signal })
		setTimeout(() => budget.abort(), 100)
		await assert.rejects(converting, /IMG\.heic was not opened: converting it from HEIC did not finish in time\./)
		await assert.rejects(
			convertHeic('IMG.heic', source, { sips: stuck, signal: AbortSignal.abort() }),
			/did not finish in time/,
		)
		const garbage = await fakeSips(
			join(await mkdtemp(join(f.base, 'g-'))),
			`${probe}\nfor a; do out="$a"; done; echo "not a png" > "$out"`,
		)
		await assert.rejects(convertHeic('IMG.heic', source, { sips: garbage }), /the conversion is not a valid PNG/)
		if (darwin) {
			const real = await convertHeic('IMG.heic', source)
			assert.deepEqual([real.width, real.height], [760, 520])
		}
	} finally {
		await f.close()
	}
})

test(
	'a HEIC whose sips refusal comes back stops the window from opening with the reason',
	{ skip: !darwin },
	async () => {
		const f = await fixture()
		const file = join(f.docs, 'not-really.heic')
		// HEIF brand but no image inside: sips cannot read it.
		await writeFile(
			file,
			Buffer.concat([be32(24), Buffer.from('ftypheic', 'latin1'), be32(0), Buffer.from('mif1heic', 'latin1')]),
		)
		const observation = new ReviewDocumentObservation(f.docs, file, () => {}, {
			paths: f.paths,
			displayPath: file,
			tokens: new ViewerFileTokens(),
		})
		try {
			await observation.start()
			assert.ok(observation.current().error)
			assert.match(
				String((observation.failure as Error).message),
				/not-really\.heic can't be shown: macOS (could not read|reports no width)/,
			)
		} finally {
			await observation.dispose()
			await f.close()
		}
	},
)

// ---- copy as PNG: structure only ---------------------------------------------------------------------------------

test('copy as PNG: main walks chunks and CRCs, never decodes; anything else is refused before the pasteboard', async () => {
	const good = await bytesOf('app-icon.png')
	const written: Buffer[] = []
	assert.deepEqual(
		copyPngToClipboard(new Uint8Array(good), bytes => written.push(bytes)),
		{ width: 96, height: 96 },
	)
	assert.equal(written.length, 1)
	assert.deepEqual(written[0], good)
	const refuse = (raw: unknown) =>
		assert.throws(() => copyPngToClipboard(raw, (bytes: Buffer) => written.push(bytes)), /not a valid PNG|too large/)
	refuse('not bytes')
	refuse(new Uint8Array(await bytesOf('form-error.jpg')))
	refuse(new Uint8Array(good.subarray(0, good.length - 1)))
	refuse(new Uint8Array(Buffer.concat([good, Buffer.from([0])])))
	const badCrc = Buffer.from(good)
	badCrc[40] = (badCrc[40] ?? 0) ^ 0xff
	refuse(new Uint8Array(badCrc))
	const noData = Buffer.concat([
		PNG_SIG,
		chunk('IHDR', Buffer.concat([be32(1), be32(1), Buffer.from([8, 2, 0, 0, 0])])),
		chunk('IEND', Buffer.alloc(0)),
	])
	refuse(new Uint8Array(noData))
	assert.equal(written.length, 1)
	assert.throws(() => inspectPngStructure(good, 100), /too large/)
})
