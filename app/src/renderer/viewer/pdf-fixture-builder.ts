// Story/test-only PDF builder for the plain viewer's S4 fixtures that are easier to make than to check in: a 500-page
// ledger (lazy range reads), a 5,001-page file (the page limit), CJK text in non-embedded fonts (bundled CMaps), a
// JBIG2 scan (the bundled jbig2.wasm), a file full of active content (scripts, launch and remote links that must do
// nothing) and a broken file. Pure: bytes in, bytes out, so `node --test` can check it too. Never import this from
// production renderer code.

type Part = string | Uint8Array

const latin1 = (text: string) => {
	const bytes = new Uint8Array(text.length)
	for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff
	return bytes
}

/** A PDF literal string: `(…)` with the three special characters escaped. */
const literal = (text: string) => `(${text.replace(/[\\()]/g, match => `\\${match}`)})`
/** UTF-16BE hex string, for text shown through a UCS-2 CMap. */
const utf16Hex = (text: string) =>
	`<${Array.from(text, char => (char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')).join('')}>`

class PdfWriter {
	private readonly objects: (Part[] | null)[] = []
	/** Reserve an object number (1-based). */
	reserve(): number {
		this.objects.push(null)
		return this.objects.length
	}
	set(id: number, body: string) {
		this.objects[id - 1] = [body]
	}
	add(body: string): number {
		const id = this.reserve()
		this.set(id, body)
		return id
	}
	/** A stream object; `dictionary` without `/Length`. */
	stream(dictionary: string, data: Part, id = this.reserve()): number {
		const bytes = typeof data === 'string' ? latin1(data) : data
		this.objects[id - 1] = [`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`, bytes, '\nendstream']
		return id
	}
	finish(root: number, extraTrailer = ''): Uint8Array {
		const parts: Uint8Array[] = []
		let offset = 0
		const push = (part: Part) => {
			const bytes = typeof part === 'string' ? latin1(part) : part
			parts.push(bytes)
			offset += bytes.length
		}
		push('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
		const offsets: number[] = []
		this.objects.forEach((body, index) => {
			if (!body) throw new Error(`PDF object ${index + 1} was reserved but never written.`)
			offsets.push(offset)
			push(`${index + 1} 0 obj\n`)
			for (const part of body) push(part)
			push('\nendobj\n')
		})
		const xref = offset
		push(`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`)
		for (const at of offsets) push(`${String(at).padStart(10, '0')} 00000 n \n`)
		push(
			`trailer\n<< /Size ${this.objects.length + 1} /Root ${root} 0 R ${extraTrailer}>>\nstartxref\n${xref}\n%%EOF\n`,
		)
		const out = new Uint8Array(offset)
		let at = 0
		for (const part of parts) {
			out.set(part, at)
			at += part.length
		}
		return out
	}
}

const A4 = '[0 0 595.28 841.89]'

/**
 * Writes a balanced page tree under `root` over the reserved `pages` (fan-out 10, like Acrobat and Chromium) and
 * returns each page's parent. pdf.js walks a flat /Kids array kid by kid, fetching every page object before the one
 * it wants (and checks the last page on open), so a flat tree would make a long file read nearly everything.
 */
function pageTree(pdf: PdfWriter, root: number, pages: readonly number[]): number[] {
	const parents: number[] = []
	const build = (id: number, parent: number | null, first: number, size: number) => {
		let kids: number[]
		if (size <= 10) {
			kids = pages.slice(first, first + size)
			for (let index = 0; index < size; index++) parents[first + index] = id
		} else {
			const step = 10 ** Math.ceil(Math.log10(size) - 1)
			kids = []
			for (let start = 0; start < size; start += step) {
				const child = pdf.reserve()
				kids.push(child)
				build(child, id, first + start, Math.min(step, size - start))
			}
		}
		pdf.set(
			id,
			`<< /Type /Pages ${parent ? `/Parent ${parent} 0 R ` : ''}/Count ${size} /Kids [${kids.map(kid => `${kid} 0 R`).join(' ')}] >>`,
		)
	}
	build(root, null, 0, pages.length)
	return parents
}
const CUSTOMERS = [
	'Northwind Analytics',
	'Kancelářské potřeby Brno',
	'Lakeside Dental',
	'Vltava Logistics',
	'Orchard Bakery',
	'Moravia Print',
	'Harbor Physio',
	'Brno Coworking',
]
// Helvetica's standard encoding has no Czech letters; the ledger is ASCII on purpose (the font is not embedded).
const ascii = (text: string) => text.normalize('NFD').replace(/[^\x20-\x7e]/g, '')

/** One ledger page: a heading and 44 invoice rows in non-embedded Helvetica (pdf.js fetches its standard font data). */
function ledgerPage(page: number, pages: number): string {
	const lines = [
		`BT /F2 15 Tf 56 790 Td ${literal(`Invoice ledger 2026, page ${page} of ${pages}`)} Tj ET`,
		`BT /F1 8.5 Tf 56 772 Td ${literal('ClientCare a.s. - accounts receivable - generated for the plain viewer proof')} Tj ET`,
		'0.6 w 56 760 m 539 760 l S',
	]
	for (let row = 0; row < 44; row++) {
		const index = (page - 1) * 44 + row
		const invoice = `INV-2026-${String(10000 + index).padStart(5, '0')}`
		const day = String(1 + (index % 28)).padStart(2, '0')
		const month = String(1 + (Math.floor(index / 28) % 12)).padStart(2, '0')
		const customer = ascii(CUSTOMERS[index % CUSTOMERS.length] ?? '')
		const amount = (((index * 7919) % 900000) / 100 + 120).toFixed(2)
		const y = 742 - row * 15.5
		lines.push(
			`BT /F1 9 Tf 56 ${y} Td ${literal(`2026-${month}-${day}`)} Tj 70 0 Td ${literal(invoice)} Tj 96 0 Td ${literal(customer)} Tj ET`,
			`BT /F1 9 Tf 470 ${y} Td ${literal(`EUR ${amount}`)} Tj ET`,
		)
	}
	lines.push(`BT /F1 8 Tf 280 40 Td ${literal(`${page}`)} Tj ET`)
	return lines.join('\n')
}

/** A text ledger of `pages` A4 pages with a flat page tree and an outline every 50 pages. */
export function buildLedgerPdf(pages = 500): Uint8Array {
	const pdf = new PdfWriter()
	const catalog = pdf.reserve()
	const tree = pdf.reserve()
	const outlines = pdf.reserve()
	const regular = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
	const bold = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
	const kids = Array.from({ length: pages }, () => pdf.reserve())
	const parents = pageTree(pdf, tree, kids)
	kids.forEach((id, index) => {
		const content = pdf.stream('', ledgerPage(index + 1, pages))
		pdf.set(
			id,
			`<< /Type /Page /Parent ${parents[index]} 0 R /MediaBox ${A4} /Contents ${content} 0 R /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> >>`,
		)
	})
	const marks = kids.filter((_, index) => index % 50 === 0)
	const items = marks.map(() => pdf.reserve())
	items.forEach((id, index) => {
		const page = index * 50 + 1
		const links = [
			index > 0 ? `/Prev ${items[index - 1]} 0 R` : '',
			index < items.length - 1 ? `/Next ${items[index + 1]} 0 R` : '',
		].join(' ')
		pdf.set(
			id,
			`<< /Title ${literal(`Pages ${page}-${Math.min(page + 49, pages)}`)} /Parent ${outlines} 0 R ${links} /Dest [${marks[index]} 0 R /XYZ null null null] >>`,
		)
	})
	pdf.set(
		outlines,
		`<< /Type /Outlines /Count ${items.length} /First ${items[0]} 0 R /Last ${items[items.length - 1]} 0 R >>`,
	)
	pdf.set(catalog, `<< /Type /Catalog /Pages ${tree} 0 R /Outlines ${outlines} 0 R >>`)
	return pdf.finish(catalog)
}

/** `pages` blank A4 pages sharing one content stream: just over the viewer's page limit. */
export function buildManyPagesPdf(pages = 5001): Uint8Array {
	const pdf = new PdfWriter()
	const catalog = pdf.reserve()
	const tree = pdf.reserve()
	const content = pdf.stream('', '0.9 g 56 56 483 730 re f')
	const kids = Array.from({ length: pages }, () => pdf.reserve())
	const parents = pageTree(pdf, tree, kids)
	kids.forEach((id, index) =>
		pdf.set(id, `<< /Type /Page /Parent ${parents[index]} 0 R /MediaBox ${A4} /Contents ${content} 0 R >>`),
	)
	pdf.set(catalog, `<< /Type /Catalog /Pages ${tree} 0 R >>`)
	return pdf.finish(catalog)
}

/** Three lines in non-embedded CID fonts: pdf.js needs the bundled UCS-2 CMaps to draw and to extract them. */
export const CJK_LINES = [
	{
		ordering: 'Japan1',
		supplement: 6,
		cmap: 'UniJIS-UCS2-H',
		font: 'KozMinPr6N-Regular',
		text: '請求書 番号 2026-118 東京',
	},
	{ ordering: 'GB1', supplement: 5, cmap: 'UniGB-UCS2-H', font: 'AdobeSongStd-Light', text: '发票 编号 2026-118 上海' },
	{
		ordering: 'Korea1',
		supplement: 2,
		cmap: 'UniKS-UCS2-H',
		font: 'AdobeMyungjoStd-Medium',
		text: '송장 번호 2026-118 서울',
	},
] as const

export function buildCjkPdf(): Uint8Array {
	const pdf = new PdfWriter()
	const catalog = pdf.reserve()
	const tree = pdf.reserve()
	const latin = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
	const fonts = CJK_LINES.map(line => {
		const descriptor = pdf.add(
			`<< /Type /FontDescriptor /FontName /${line.font} /Flags 6 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>`,
		)
		const cid = pdf.add(
			`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${line.font} /CIDSystemInfo << /Registry (Adobe) /Ordering (${line.ordering}) /Supplement ${line.supplement} >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W [1 [${Array(95).fill(500).join(' ')}]] >>`,
		)
		return pdf.add(
			`<< /Type /Font /Subtype /Type0 /BaseFont /${line.font}-${line.cmap} /Encoding /${line.cmap} /DescendantFonts [${cid} 0 R] >>`,
		)
	})
	const content = [
		`BT /L 16 Tf 56 780 Td ${literal('Invoices from the Asia offices')} Tj ET`,
		...CJK_LINES.map((line, index) => `BT /C${index} 22 Tf 56 ${720 - index * 60} Td ${utf16Hex(line.text)} Tj ET`),
	].join('\n')
	const stream = pdf.stream('', content)
	const page = pdf.add(
		`<< /Type /Page /Parent ${tree} 0 R /MediaBox ${A4} /Contents ${stream} 0 R /Resources << /Font << /L ${latin} 0 R ${fonts.map((id, index) => `/C${index} ${id} 0 R`).join(' ')} >> >> >>`,
	)
	pdf.set(tree, `<< /Type /Pages /Count 1 /Kids [${page} 0 R] >>`)
	pdf.set(catalog, `<< /Type /Catalog /Pages ${tree} 0 R >>`)
	return pdf.finish(catalog)
}

// JBIG2 generic region, MQ arithmetic coded (ITU-T T.88 Annex E), template 0 with the default adaptive pixels, no
// typical prediction. Contexts only have to be distinct per neighbourhood: the decoder keeps one state per
// neighbourhood whatever number it gives it.
const QE: readonly (readonly [number, number, number, number])[] = [
	[0x5601, 1, 1, 1],
	[0x3401, 2, 6, 0],
	[0x1801, 3, 9, 0],
	[0x0ac1, 4, 12, 0],
	[0x0521, 5, 29, 0],
	[0x0221, 38, 33, 0],
	[0x5601, 7, 6, 1],
	[0x5401, 8, 14, 0],
	[0x4801, 9, 14, 0],
	[0x3801, 10, 14, 0],
	[0x3001, 11, 17, 0],
	[0x2401, 12, 18, 0],
	[0x1c01, 13, 20, 0],
	[0x1601, 29, 21, 0],
	[0x5601, 15, 14, 1],
	[0x5401, 16, 14, 0],
	[0x5101, 17, 15, 0],
	[0x4801, 18, 16, 0],
	[0x3801, 19, 17, 0],
	[0x3401, 20, 18, 0],
	[0x3001, 21, 19, 0],
	[0x2801, 22, 19, 0],
	[0x2401, 23, 20, 0],
	[0x2201, 24, 21, 0],
	[0x1c01, 25, 22, 0],
	[0x1801, 26, 23, 0],
	[0x1601, 27, 24, 0],
	[0x1401, 28, 25, 0],
	[0x1201, 29, 26, 0],
	[0x1101, 30, 27, 0],
	[0x0ac1, 31, 28, 0],
	[0x09c1, 32, 29, 0],
	[0x08a1, 33, 30, 0],
	[0x0521, 34, 31, 0],
	[0x0441, 35, 32, 0],
	[0x02a1, 36, 33, 0],
	[0x0221, 37, 34, 0],
	[0x0141, 38, 35, 0],
	[0x0111, 39, 36, 0],
	[0x0085, 40, 37, 0],
	[0x0049, 41, 38, 0],
	[0x0025, 42, 39, 0],
	[0x0015, 43, 40, 0],
	[0x0009, 44, 41, 0],
	[0x0005, 45, 42, 0],
	[0x0001, 45, 43, 0],
	[0x5601, 46, 46, 0],
]

class MqEncoder {
	private a = 0x8000
	private c = 0
	private ct = 12
	/** bytes[0] is the byte before the start, never output. */
	private readonly bytes: number[] = [0]
	private bp = 0
	private readonly index = new Uint8Array(1 << 16)
	private readonly mps = new Uint8Array(1 << 16)

	encode(context: number, bit: number) {
		const state = QE[this.index[context] ?? 0] as readonly [number, number, number, number]
		const [qe, nmps, nlps, swap] = state
		this.a -= qe
		if (bit === this.mps[context]) {
			if ((this.a & 0x8000) === 0) {
				if (this.a < qe) this.a = qe
				else this.c += qe
				this.index[context] = nmps
				this.renorm()
			} else this.c += qe
		} else {
			if (this.a < qe) this.c += qe
			else this.a = qe
			if (swap) this.mps[context] = 1 - (this.mps[context] ?? 0)
			this.index[context] = nlps
			this.renorm()
		}
	}
	private renorm() {
		do {
			this.a = (this.a << 1) & 0xffff
			this.c = (this.c << 1) >>> 0
			this.ct--
			if (this.ct === 0) this.byteOut()
		} while ((this.a & 0x8000) === 0)
	}
	private put(value: number) {
		this.bp++
		this.bytes[this.bp] = value & 0xff
	}
	private byteOut() {
		if (this.bytes[this.bp] === 0xff) {
			this.put(this.c >>> 20)
			this.c &= 0xfffff
			this.ct = 7
		} else if (this.c < 0x8000000) {
			this.put(this.c >>> 19)
			this.c &= 0x7ffff
			this.ct = 8
		} else {
			this.bytes[this.bp] = ((this.bytes[this.bp] ?? 0) + 1) & 0xff
			if (this.bytes[this.bp] === 0xff) {
				this.c &= 0x7ffffff
				this.put(this.c >>> 20)
				this.c &= 0xfffff
				this.ct = 7
			} else {
				this.put(this.c >>> 19)
				this.c &= 0x7ffff
				this.ct = 8
			}
		}
	}
	finish(): Uint8Array {
		const temp = this.c + this.a
		this.c = (this.c | 0xffff) >>> 0
		if (this.c >= temp) this.c -= 0x8000
		this.c = (this.c << this.ct) >>> 0
		this.byteOut()
		this.c = (this.c << this.ct) >>> 0
		this.byteOut()
		if (this.bytes[this.bp] !== 0xff) this.put(0xff)
		this.put(0xac)
		return Uint8Array.from(this.bytes.slice(1))
	}
}

const TEMPLATE_0: readonly (readonly [number, number])[] = [
	[-1, -2],
	[0, -2],
	[1, -2],
	[-2, -1],
	[-1, -1],
	[0, -1],
	[1, -1],
	[2, -1],
	[-4, 0],
	[-3, 0],
	[-2, 0],
	[-1, 0],
	// Default adaptive pixels A1–A4.
	[3, -1],
	[-3, -1],
	[2, -2],
	[-2, -2],
]

/** A bilevel bitmap, 1 = black, rows top to bottom. */
export interface Bitmap {
	width: number
	height: number
	pixels: Uint8Array
}

export function encodeGenericRegion({ width, height, pixels }: Bitmap): Uint8Array {
	const encoder = new MqEncoder()
	const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width ? 0 : (pixels[y * width + x] ?? 0))
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			let context = 0
			for (const [dx, dy] of TEMPLATE_0) context = (context << 1) | at(x + dx, y + dy)
			encoder.encode(context, pixels[y * width + x] ?? 0)
		}
	return encoder.finish()
}

const u32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]

/** An embedded (PDF) JBIG2 stream: a page information segment and one immediate lossless generic region. */
export function jbig2Stream(bitmap: Bitmap): Uint8Array {
	const header = (number: number, type: number, length: number) => [...u32(number), type, 0x00, 0x01, ...u32(length)]
	const pageInfo = [...u32(bitmap.width), ...u32(bitmap.height), ...u32(0), ...u32(0), 0x00, 0x00, 0x00]
	const coded = encodeGenericRegion(bitmap)
	const region = [
		...u32(bitmap.width),
		...u32(bitmap.height),
		...u32(0),
		...u32(0),
		0x00, // external combination: OR
		0x00, // MMR off, template 0, no typical prediction
		3,
		0xff, // A1 (3, −1)
		0xfd,
		0xff, // A2 (−3, −1)
		2,
		0xfe, // A3 (2, −2)
		0xfe,
		0xfe, // A4 (−2, −2)
	]
	return Uint8Array.from([
		...header(0, 48, pageInfo.length),
		...pageInfo,
		...header(1, 39, region.length + coded.length),
		...region,
		...coded,
	])
}

/** A page wrapping one bilevel scan in a JBIG2Decode image, drawn over the whole A4 page. */
export function buildJbig2Pdf(bitmap: Bitmap): Uint8Array {
	const pdf = new PdfWriter()
	const catalog = pdf.reserve()
	const tree = pdf.reserve()
	const image = pdf.stream(
		`/Type /XObject /Subtype /Image /Width ${bitmap.width} /Height ${bitmap.height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode`,
		jbig2Stream(bitmap),
	)
	const content = pdf.stream('', 'q 595.28 0 0 841.89 0 0 cm /Scan Do Q')
	const page = pdf.add(
		`<< /Type /Page /Parent ${tree} 0 R /MediaBox ${A4} /Contents ${content} 0 R /Resources << /XObject << /Scan ${image} 0 R >> >> >>`,
	)
	pdf.set(tree, `<< /Type /Pages /Count 1 /Kids [${page} 0 R] >>`)
	pdf.set(catalog, `<< /Type /Catalog /Pages ${tree} 0 R >>`)
	return pdf.finish(catalog)
}

/** The remote host every active-content action points at; nothing may ever ask for it. */
export const ACTIVE_HOST = 'example.invalid'

/**
 * One page with every kind of active content a PDF can carry: an OpenAction script, document-level and page
 * scripts, links that open a URL, launch an app or open a remote file, a submit-form button and an external stream.
 */
export function buildActiveContentPdf(): Uint8Array {
	const pdf = new PdfWriter()
	const catalog = pdf.reserve()
	const tree = pdf.reserve()
	const page = pdf.reserve()
	const font = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
	const script = (code: string) => pdf.add(`<< /S /JavaScript /JS ${literal(code)} >>`)
	const open = script(
		`app.alert('opened'); app.launchURL('https://${ACTIVE_HOST}/opened', true); this.submitForm('https://${ACTIVE_HOST}/submit');`,
	)
	const names = pdf.add(`<< /Names [(track) ${script(`app.launchURL('https://${ACTIVE_HOST}/names', true);`)} 0 R] >>`)
	const external = pdf.stream(`/F << /FS /URL /F (https://${ACTIVE_HOST}/pixel.bin) >> /Filter /FlateDecode`, '')
	const link = (y: number, action: string) =>
		pdf.add(
			`<< /Type /Annot /Subtype /Link /Rect [56 ${y - 4} 400 ${y + 14}] /Border [0 0 1] /C [0 0.4 1] /A ${action} /P ${page} 0 R >>`,
		)
	const links = [
		link(700, `<< /S /URI /URI (https://${ACTIVE_HOST}/pay?invoice=2026-118) >>`),
		link(670, '<< /S /Launch /F (/System/Applications/Calculator.app) /Win << /F (calc.exe) >> >>'),
		link(640, `<< /S /GoToR /F << /FS /URL /F (https://${ACTIVE_HOST}/terms.pdf) >> /D [0 /Fit] >>`),
		link(610, `${script(`app.launchURL('https://${ACTIVE_HOST}/link-script', true);`)} 0 R`),
	]
	const button = pdf.add(
		`<< /Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /T (pay) /Rect [56 540 200 570] /MK << /BG [0.9 0.9 0.9] /CA (Pay now) >> /A << /S /SubmitForm /F << /FS /URL /F (https://${ACTIVE_HOST}/submit-button) >> >> /AA << /E ${script(`app.alert('hovered');`)} 0 R >> /P ${page} 0 R >>`,
	)
	const form = pdf.add(`<< /Fields [${button} 0 R] /NeedAppearances false >>`)
	const text = [
		`BT /F1 18 Tf 56 770 Td ${literal('Invoice 2026-118')} Tj ET`,
		`BT /F1 10 Tf 56 745 Td ${literal('This file tries to run scripts and open things. In Helm, nothing below does anything.')} Tj ET`,
		`BT /F1 11 Tf 0 0.4 1 rg 58 700 Td ${literal('Pay online (a web link)')} Tj ET`,
		`BT /F1 11 Tf 0 0.4 1 rg 58 670 Td ${literal('Open the calculator (a launch action)')} Tj ET`,
		`BT /F1 11 Tf 0 0.4 1 rg 58 640 Td ${literal('Read the terms (a remote PDF)')} Tj ET`,
		`BT /F1 11 Tf 0 0.4 1 rg 58 610 Td ${literal('Track this invoice (a script)')} Tj ET`,
		`BT /F1 11 Tf 64 551 Td ${literal('Pay now')} Tj ET`,
		'0.5 w 56 540 144 30 re S',
		'q 10 0 0 10 420 540 cm /External Do Q',
	].join('\n')
	const content = pdf.stream('', text)
	const externalImage = pdf.add(
		`<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 0 /F << /FS /URL /F (https://${ACTIVE_HOST}/image.png) >> >>`,
	)
	pdf.set(
		page,
		`<< /Type /Page /Parent ${tree} 0 R /MediaBox ${A4} /Contents ${content} 0 R /Annots [${[...links, button].map(id => `${id} 0 R`).join(' ')}] /AA << /O ${script(`app.launchURL('https://${ACTIVE_HOST}/page-open', true);`)} 0 R >> /Resources << /Font << /F1 ${font} 0 R >> /XObject << /External ${externalImage} 0 R /Stream ${external} 0 R >> >> >>`,
	)
	pdf.set(tree, `<< /Type /Pages /Count 1 /Kids [${page} 0 R] >>`)
	pdf.set(
		catalog,
		`<< /Type /Catalog /Pages ${tree} 0 R /OpenAction ${open} 0 R /Names << /JavaScript ${names} 0 R >> /AcroForm ${form} 0 R /URI << /Base (https://${ACTIVE_HOST}/) >> >>`,
	)
	return pdf.finish(catalog)
}

/** One page showing a JPEG 2000 image (JPXDecode): pdf.js decodes it with the bundled openjpeg.wasm. */
export function buildJpxPdf(jp2: Uint8Array, width: number, height: number): Uint8Array {
	const pdf = new PdfWriter()
	const catalog = pdf.reserve()
	const tree = pdf.reserve()
	const image = pdf.stream(
		`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8 /Filter /JPXDecode`,
		jp2,
	)
	const drawn = 483
	const tall = (drawn * height) / width
	const content = pdf.stream('', `q ${drawn} 0 0 ${tall.toFixed(2)} 56 ${(785 - tall).toFixed(2)} cm /Photo Do Q`)
	const page = pdf.add(
		`<< /Type /Page /Parent ${tree} 0 R /MediaBox ${A4} /Contents ${content} 0 R /Resources << /XObject << /Photo ${image} 0 R >> >> >>`,
	)
	pdf.set(tree, `<< /Type /Pages /Count 1 /Kids [${page} 0 R] >>`)
	pdf.set(catalog, `<< /Type /Catalog /Pages ${tree} 0 R >>`)
	return pdf.finish(catalog)
}

/** Starts like a PDF and is nothing else. */
export function buildBrokenPdf(): Uint8Array {
	return latin1(`%PDF-1.7\n${'This file was cut off while copying. '.repeat(40)}\n`)
}
