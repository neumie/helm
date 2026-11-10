// The one description of what `helm open` shows and how (docs/plans/helm-open/spec.md, Formats and Renderer
// registry). Shared by the CLI, Electron main (admission, limits) and the renderer (view choice), so it stays pure:
// no node:, no DOM, no zod. Plain mode only: feedback mode keeps `readReviewFile`'s own md/jsx/tsx rule.

export type ViewerFormat =
	| 'markdown'
	| 'canvas'
	| 'text'
	| 'code'
	| 'data'
	| 'image'
	| 'heic'
	| 'svg'
	| 'pdf'
	| 'csv'
	| 'sheet'
	| 'docx'
	| 'media'
	| 'email'
	| 'html'
	| 'mdx'
	| 'quicklook'

/** Feedback anchors a format offers (S8); empty means whole-file feedback only. */
export type AnchorKind = 'passage' | 'lines' | 'json-pointer' | 'cell' | 'pdf-text' | 'image-region'

export interface FormatEntry {
	format: ViewerFormat
	/** Whether this version of Helm shows the format; the others refuse with "not yet". */
	available: boolean
	/** Plural noun for refusals: "Helm shows code up to 16 MiB", "Helm can't show PDFs yet". */
	noun: string
	/** Lower-case extensions with the dot. The last extension of a name decides. */
	extensions: readonly string[]
	/** Confirms a binary family from the first bytes; a mismatch is refused, never guessed. */
	magic?: (head: Uint8Array) => boolean
	read: 'utf8-text' | 'bytes' | 'stream'
	maxBytes: number
	/** Text families only: the most lines shown. */
	maxLines?: number
	journal: 'in-file' | 'none'
	anchors: readonly AnchorKind[]
	capabilities: {
		search: boolean
		zoom: 'scale' | 'font' | 'none'
		print: 'view' | 'default-app'
		copy: 'text' | 'range' | 'image'
	}
}

const KiB = 1024
const MiB = 1024 * KiB

/** Plain Markdown is read up to the Markdown renderer's own budget (S1's choice, kept). */
export const VIEWER_MARKDOWN_BYTES = 512 * KiB
export const VIEWER_TEXT_BYTES = 16 * MiB
export const VIEWER_TEXT_LINES = 1_000_000
export const VIEWER_DATA_BYTES = 32 * MiB
export const VIEWER_IMAGE_BYTES = 256 * MiB
export const VIEWER_SVG_BYTES = 16 * MiB
/** PDFs: bytes (pdf.js's ChunkedStream allocates the whole file in its worker) and pages. */
export const VIEWER_PDF_BYTES = 256 * MiB
export const VIEWER_PDF_PAGES = 5_000
/** pdf.js accepts a `%PDF-` header anywhere in the first 1 KiB (junk before it is common); so does Helm. */
export const PDF_HEAD_BYTES = 1024
/** Decoded pixels an image may have (width × height after the header check, before any decode). */
export const VIEWER_IMAGE_PIXELS = 150_000_000
/** CSV/TSV: bytes (streamed by range to the grid's worker), records, and columns of the widest record. */
export const VIEWER_CSV_BYTES = 128 * MiB
export const VIEWER_CSV_ROWS = 1_000_000
export const VIEWER_CSV_COLUMNS = 16_384
/** Bytes main reads of a CSV: a byte order mark and a known binary signature fit in the first 16. */
export const CSV_HEAD_BYTES = 16
/** Children of one tree node the data view lists before an "N more" row. */
export const VIEWER_DATA_CHILDREN = 10_000

const starts = (head: Uint8Array, bytes: readonly number[], at = 0) =>
	head.length >= at + bytes.length && bytes.every((byte, index) => head[at + index] === byte)
const ascii = (text: string) => [...text].map(char => char.charCodeAt(0))

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]
const ZIP = [0x50, 0x4b, 0x03, 0x04]
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const isPng = (head: Uint8Array) => starts(head, PNG)
const isJpeg = (head: Uint8Array) => starts(head, JPEG)
const isGif = (head: Uint8Array) => starts(head, ascii('GIF87a')) || starts(head, ascii('GIF89a'))
const isWebp = (head: Uint8Array) => starts(head, ascii('RIFF')) && starts(head, ascii('WEBP'), 8)
const PDF_HEADER = ascii('%PDF-')
const isPdf = (head: Uint8Array) => starts(head, PDF_HEADER)
/** Where the `%PDF-` header starts within the first PDF_HEAD_BYTES, or -1. */
export function pdfHeaderOffset(head: Uint8Array): number {
	const end = Math.min(head.length, PDF_HEAD_BYTES) - PDF_HEADER.length
	for (let at = 0; at <= end; at++) if (starts(head, PDF_HEADER, at)) return at
	return -1
}
/** "invoice.pdf is not a PDF (it starts like a PNG image)." or null when the header is there. */
export function pdfMismatch(name: string, head: Uint8Array): string | null {
	if (pdfHeaderOffset(head) >= 0) return null
	const what = binarySignature(head.subarray(0, 16))
	return `${name} is not a PDF${what ? ` (it starts like ${what})` : ''}.`
}
const isZip = (head: Uint8Array) => starts(head, ZIP)
const isBmp = (head: Uint8Array) => starts(head, ascii('BM')) && head.length >= 26
const isIco = (head: Uint8Array) => starts(head, [0, 0, 1, 0]) && head.length >= 6 && (head[4] !== 0 || head[5] !== 0)

/** Brands of an ISO-BMFF `ftyp` box at the start (major + compatible), or null when there is none. */
function ftypBrands(head: Uint8Array): string[] | null {
	if (head.length < 16 || !starts(head, ascii('ftyp'), 4)) return null
	const size = ((head[0] ?? 0) << 24) | ((head[1] ?? 0) << 16) | ((head[2] ?? 0) << 8) | (head[3] ?? 0)
	if (size < 16 || size > 4096) return null
	const end = Math.min(size, head.length)
	const brand = (at: number) =>
		String.fromCharCode(head[at] ?? 0, head[at + 1] ?? 0, head[at + 2] ?? 0, head[at + 3] ?? 0)
	const brands = [brand(8)]
	for (let at = 16; at + 4 <= end; at += 4) brands.push(brand(at))
	return brands
}
const AVIF_BRANDS = new Set(['avif', 'avis'])
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'])
const isAvif = (head: Uint8Array) => Boolean(ftypBrands(head)?.some(brand => AVIF_BRANDS.has(brand)))
/** HEIC/HEIF: a HEIF brand and no AVIF brand (an AVIF also carries `mif1`). */
const isHeic = (head: Uint8Array) => {
	const brands = ftypBrands(head)
	return Boolean(brands?.some(brand => HEIC_BRANDS.has(brand)) && !brands?.some(brand => AVIF_BRANDS.has(brand)))
}

/** Raster types Chromium decodes from bytes; HEIC and SVG are their own families. */
export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'bmp' | 'ico'
export type PictureType = ImageType | 'svg' | 'heic'
export const IMAGE_EXTENSIONS: Readonly<Record<string, ImageType>> = {
	'.png': 'png',
	'.apng': 'png',
	'.jpg': 'jpeg',
	'.jpeg': 'jpeg',
	'.jpe': 'jpeg',
	'.jfif': 'jpeg',
	'.gif': 'gif',
	'.webp': 'webp',
	'.avif': 'avif',
	'.bmp': 'bmp',
	'.ico': 'ico',
}
export const PICTURE_WORDS: Readonly<Record<PictureType, string>> = {
	png: 'PNG',
	jpeg: 'JPEG',
	gif: 'GIF',
	webp: 'WebP',
	avif: 'AVIF',
	bmp: 'BMP',
	ico: 'ICO',
	svg: 'SVG',
	heic: 'HEIC',
}
/** The type the browser is told the bytes are; HEIC is served as the PNG `sips` made. */
export const PICTURE_MIME: Readonly<Record<PictureType, string>> = {
	png: 'image/png',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
	svg: 'image/svg+xml',
	heic: 'image/png',
}
const PICTURE_MAGIC: Readonly<Record<Exclude<PictureType, 'svg'>, (head: Uint8Array) => boolean>> = {
	png: isPng,
	jpeg: isJpeg,
	gif: isGif,
	webp: isWebp,
	avif: isAvif,
	bmp: isBmp,
	ico: isIco,
	heic: isHeic,
}
/** Bytes a picture's signature needs: the longest is an `ftyp` box with its compatible brands. */
export const PICTURE_HEAD_BYTES = 256
/** What picture type the first bytes are, or null. SVG is text and has no signature. */
export function pictureTypeOf(head: Uint8Array): Exclude<PictureType, 'svg'> | null {
	for (const [type, test] of Object.entries(PICTURE_MAGIC)) if (test(head)) return type as Exclude<PictureType, 'svg'>
	return null
}
/**
 * Extension and magic must agree: "photo.png is not a PNG image (it starts like a JPEG image)". Returns the
 * refusal, or null when the bytes are what the name says.
 */
export function pictureMismatch(name: string, expected: Exclude<PictureType, 'svg'>, head: Uint8Array): string | null {
	if (PICTURE_MAGIC[expected](head)) return null
	const found = pictureTypeOf(head)
	const what = found
		? `${found === 'avif' ? 'an' : 'a'} ${PICTURE_WORDS[found]} image`
		: binarySignature(head.subarray(0, 16))
	return `${name} is not a${expected === 'avif' ? 'n' : ''} ${PICTURE_WORDS[expected]} image${what ? ` (it starts like ${what})` : ''}.`
}

/** Known binary signatures, for "report.txt is not text (it starts like a PDF)". */
const SIGNATURES: readonly { test: (head: Uint8Array) => boolean; what: string }[] = [
	{ test: isPdf, what: 'a PDF' },
	{ test: isPng, what: 'a PNG image' },
	{ test: isJpeg, what: 'a JPEG image' },
	{ test: isGif, what: 'a GIF image' },
	{ test: isWebp, what: 'a WebP image' },
	{ test: isAvif, what: 'an AVIF image' },
	{ test: isHeic, what: 'a HEIC image' },
	{ test: isZip, what: 'a zip archive' },
	{ test: head => starts(head, OLE), what: 'an Office document' },
	{ test: head => starts(head, [0x1f, 0x8b]), what: 'a gzip archive' },
	{ test: head => starts(head, [0x7f, 0x45, 0x4c, 0x46]), what: 'a program' },
	{
		test: head =>
			starts(head, [0xcf, 0xfa, 0xed, 0xfe]) ||
			starts(head, [0xce, 0xfa, 0xed, 0xfe]) ||
			starts(head, [0xca, 0xfe, 0xba, 0xbe]),
		what: 'a program',
	},
]

const TEXT_CAPS = { search: true, zoom: 'font', print: 'view', copy: 'text' } as const
const IMAGE_CAPS = { search: false, zoom: 'scale', print: 'view', copy: 'image' } as const
const LATER_CAPS = { search: false, zoom: 'scale', print: 'default-app', copy: 'text' } as const
const later = (
	format: ViewerFormat,
	noun: string,
	extensions: readonly string[],
	maxBytes: number,
	magic?: (head: Uint8Array) => boolean,
): FormatEntry => ({
	format,
	available: false,
	noun,
	extensions,
	...(magic ? { magic } : {}),
	read: 'bytes',
	maxBytes,
	journal: 'none',
	anchors: [],
	capabilities: LATER_CAPS,
})

/**
 * Extension → CodeMirror language id. The renderer maps each id to a lazily loaded language chunk; `plain` has
 * no highlighting. Plain `.jsx/.tsx` are code here: the canvas executes a component, so it stays feedback-only.
 */
export const CODE_LANGUAGES: Readonly<Record<string, string>> = {
	'.js': 'javascript',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.jsx': 'jsx',
	'.ts': 'typescript',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.tsx': 'tsx',
	'.json5': 'javascript',
	'.jsonc': 'json',
	'.py': 'python',
	'.pyi': 'python',
	'.pyw': 'python',
	'.css': 'css',
	'.scss': 'scss',
	'.less': 'less',
	'.sass': 'sass',
	'.html': 'html',
	'.htm': 'html',
	'.xhtml': 'html',
	'.vue': 'html',
	'.svelte': 'html',
	'.mdx': 'markdown',
	'.xml': 'xml',
	'.xsd': 'xml',
	'.xsl': 'xml',
	'.plist': 'xml',
	'.sh': 'shell',
	'.bash': 'shell',
	'.zsh': 'shell',
	'.ksh': 'shell',
	'.fish': 'shell',
	'.command': 'shell',
	'.sql': 'sql',
	'.go': 'go',
	'.rs': 'rust',
	'.java': 'java',
	'.kt': 'kotlin',
	'.kts': 'kotlin',
	'.scala': 'scala',
	'.sc': 'scala',
	'.c': 'c',
	'.h': 'c',
	'.cc': 'cpp',
	'.cpp': 'cpp',
	'.cxx': 'cpp',
	'.hpp': 'cpp',
	'.hh': 'cpp',
	'.hxx': 'cpp',
	'.cs': 'csharp',
	'.m': 'objectivec',
	'.mm': 'objectivec',
	'.dart': 'dart',
	'.swift': 'swift',
	'.rb': 'ruby',
	'.rake': 'ruby',
	'.gemspec': 'ruby',
	'.lua': 'lua',
	'.pl': 'perl',
	'.pm': 'perl',
	'.r': 'r',
	'.hs': 'haskell',
	'.erl': 'erlang',
	'.hrl': 'erlang',
	'.clj': 'clojure',
	'.cljs': 'clojure',
	'.cljc': 'clojure',
	'.edn': 'clojure',
	'.groovy': 'groovy',
	'.gradle': 'groovy',
	'.jl': 'julia',
	'.ps1': 'powershell',
	'.psm1': 'powershell',
	'.diff': 'diff',
	'.patch': 'diff',
	'.ini': 'properties',
	'.cfg': 'properties',
	'.conf': 'properties',
	'.properties': 'properties',
	'.dockerfile': 'dockerfile',
	'.proto': 'protobuf',
	'.tex': 'latex',
	'.sty': 'latex',
	'.cls': 'latex',
	'.cmake': 'cmake',
	'.vb': 'vb',
	'.vbs': 'vb',
	'.scm': 'scheme',
	'.ss': 'scheme',
	'.rkt': 'scheme',
	'.php': 'plain',
	'.graphql': 'plain',
	'.gql': 'plain',
	'.tf': 'plain',
	'.hcl': 'plain',
	'.ex': 'plain',
	'.exs': 'plain',
	'.zig': 'plain',
	'.nim': 'plain',
	'.elm': 'plain',
	'.ml': 'plain',
	'.fs': 'plain',
}

/** Data languages the tree parses (and Raw highlights). */
export type DataLanguage = 'json' | 'jsonl' | 'yaml' | 'toml'
export const DATA_LANGUAGES: Readonly<Record<string, DataLanguage>> = {
	'.json': 'json',
	'.jsonl': 'jsonl',
	'.ndjson': 'jsonl',
	'.yaml': 'yaml',
	'.yml': 'yaml',
	'.toml': 'toml',
}

const TEXT_EXTENSIONS = ['.txt', '.text', '.log', '.out', '.err', '.rst', '.adoc', '.org', '.lock', '.nfo']

export const FORMATS: readonly FormatEntry[] = [
	{
		format: 'markdown',
		available: true,
		noun: 'Markdown',
		extensions: ['.md', '.markdown'],
		read: 'utf8-text',
		maxBytes: VIEWER_MARKDOWN_BYTES,
		journal: 'in-file',
		anchors: ['passage'],
		capabilities: TEXT_CAPS,
	},
	{
		format: 'code',
		available: true,
		noun: 'code',
		extensions: Object.keys(CODE_LANGUAGES),
		read: 'utf8-text',
		maxBytes: VIEWER_TEXT_BYTES,
		maxLines: VIEWER_TEXT_LINES,
		journal: 'none',
		anchors: ['lines'],
		capabilities: TEXT_CAPS,
	},
	{
		format: 'text',
		available: true,
		noun: 'text files',
		extensions: TEXT_EXTENSIONS,
		read: 'utf8-text',
		maxBytes: VIEWER_TEXT_BYTES,
		maxLines: VIEWER_TEXT_LINES,
		journal: 'none',
		anchors: ['lines'],
		capabilities: TEXT_CAPS,
	},
	{
		format: 'data',
		available: true,
		noun: 'JSON, YAML and TOML files',
		extensions: Object.keys(DATA_LANGUAGES),
		read: 'utf8-text',
		maxBytes: VIEWER_DATA_BYTES,
		journal: 'none',
		anchors: ['json-pointer'],
		capabilities: TEXT_CAPS,
	},
	{
		format: 'image',
		available: true,
		noun: 'images',
		extensions: Object.keys(IMAGE_EXTENSIONS),
		magic: head => pictureTypeOf(head) !== null && pictureTypeOf(head) !== 'heic',
		read: 'bytes',
		maxBytes: VIEWER_IMAGE_BYTES,
		journal: 'none',
		anchors: [],
		capabilities: IMAGE_CAPS,
	},
	{
		format: 'heic',
		available: true,
		noun: 'HEIC images',
		extensions: ['.heic', '.heif', '.hif'],
		magic: isHeic,
		read: 'bytes',
		maxBytes: VIEWER_IMAGE_BYTES,
		journal: 'none',
		anchors: [],
		capabilities: IMAGE_CAPS,
	},
	{
		format: 'svg',
		available: true,
		noun: 'SVG images',
		extensions: ['.svg'],
		read: 'utf8-text',
		maxBytes: VIEWER_SVG_BYTES,
		journal: 'none',
		anchors: [],
		capabilities: IMAGE_CAPS,
	},
	{
		format: 'pdf',
		available: true,
		noun: 'PDFs',
		extensions: ['.pdf'],
		magic: head => pdfHeaderOffset(head) >= 0,
		read: 'stream',
		maxBytes: VIEWER_PDF_BYTES,
		journal: 'none',
		anchors: ['pdf-text'],
		capabilities: { search: true, zoom: 'scale', print: 'default-app', copy: 'text' },
	},
	{
		format: 'csv',
		available: true,
		noun: 'CSV files',
		extensions: ['.csv', '.tsv', '.tab'],
		read: 'stream',
		maxBytes: VIEWER_CSV_BYTES,
		journal: 'none',
		anchors: ['cell'],
		capabilities: { search: true, zoom: 'font', print: 'default-app', copy: 'range' },
	},
	later('sheet', 'spreadsheets', ['.xlsx', '.xlsm', '.xls', '.ods'], 64 * MiB),
	later('docx', 'Word documents', ['.docx'], 64 * MiB, isZip),
	later(
		'media',
		'audio and video',
		['.mp4', '.m4v', '.mov', '.webm', '.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac'],
		Number.MAX_SAFE_INTEGER,
	),
	later('email', 'emails', ['.eml'], 64 * MiB),
	later('quicklook', 'presentations and iWork files', ['.pptx', '.ppt', '.key', '.pages', '.numbers'], 256 * MiB),
]

const ARCHIVES = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.dmg']

/** Names with no extension (or dotfiles) that are text, by lower-cased name. */
const NAMED: Readonly<Record<string, { format: 'text' | 'code'; language: string }>> = {
	dockerfile: { format: 'code', language: 'dockerfile' },
	containerfile: { format: 'code', language: 'dockerfile' },
	makefile: { format: 'code', language: 'plain' },
	gnumakefile: { format: 'code', language: 'plain' },
	justfile: { format: 'code', language: 'plain' },
	gemfile: { format: 'code', language: 'ruby' },
	rakefile: { format: 'code', language: 'ruby' },
	brewfile: { format: 'code', language: 'ruby' },
	podfile: { format: 'code', language: 'ruby' },
	fastfile: { format: 'code', language: 'ruby' },
	vagrantfile: { format: 'code', language: 'ruby' },
	jenkinsfile: { format: 'code', language: 'groovy' },
	procfile: { format: 'text', language: 'plain' },
	license: { format: 'text', language: 'plain' },
	licence: { format: 'text', language: 'plain' },
	readme: { format: 'text', language: 'plain' },
	changelog: { format: 'text', language: 'plain' },
	authors: { format: 'text', language: 'plain' },
	notice: { format: 'text', language: 'plain' },
	copying: { format: 'text', language: 'plain' },
	codeowners: { format: 'text', language: 'plain' },
	version: { format: 'text', language: 'plain' },
	'.gitignore': { format: 'code', language: 'properties' },
	'.gitattributes': { format: 'code', language: 'properties' },
	'.gitmodules': { format: 'code', language: 'properties' },
	'.dockerignore': { format: 'code', language: 'properties' },
	'.npmignore': { format: 'code', language: 'properties' },
	'.npmrc': { format: 'code', language: 'properties' },
	'.nvmrc': { format: 'text', language: 'plain' },
	'.editorconfig': { format: 'code', language: 'properties' },
	'.env': { format: 'code', language: 'properties' },
	'.bashrc': { format: 'code', language: 'shell' },
	'.bash_profile': { format: 'code', language: 'shell' },
	'.profile': { format: 'code', language: 'shell' },
	'.zshrc': { format: 'code', language: 'shell' },
	'.zprofile': { format: 'code', language: 'shell' },
	'.zshenv': { format: 'code', language: 'shell' },
}

export type FormatDetection =
	| { ok: true; entry: FormatEntry; extension: string; language: string }
	| { ok: false; reason: string }

const lastExtension = (name: string) => {
	const dot = name.lastIndexOf('.')
	return dot > 0 ? name.slice(dot).toLowerCase() : ''
}
const entryOf = (format: ViewerFormat) => FORMATS.find(entry => entry.format === format) as FormatEntry

/**
 * Plain-mode family of a file name (a basename): the last extension decides (`foo.test.tsx` is code), known
 * compound archives are refused as archives, a few extension-less names are text. Content checks come later
 * (`textEncoding`, `binarySignature`), on the bytes Helm actually read.
 */
export function detectViewerFormat(name: string): FormatDetection {
	const lower = name.toLowerCase()
	const archive = ARCHIVES.find(suffix => lower.endsWith(suffix) && lower.length > suffix.length)
	if (archive) return { ok: false, reason: `${name} is an archive; Helm doesn't open archives.` }
	// Own keys only: a file named `constructor` or `__proto__` must not find Object.prototype.
	const named = Object.hasOwn(NAMED, lower) ? NAMED[lower] : lower.startsWith('.env.') ? NAMED['.env'] : undefined
	const dockerfile = lower.startsWith('dockerfile.') || lower.endsWith('.dockerfile')
	if (named) return { ok: true, entry: entryOf(named.format), extension: '', language: named.language }
	if (dockerfile) return { ok: true, entry: entryOf('code'), extension: '', language: 'dockerfile' }
	const extension = lastExtension(name)
	if (!extension) return { ok: false, reason: `Helm can't show ${name}: it has no file extension.` }
	const entry = FORMATS.find(candidate => candidate.extensions.includes(extension))
	if (!entry) return { ok: false, reason: `Helm can't show ${extension} files (${name}).` }
	if (!entry.available) return { ok: false, reason: `Helm can't show ${entry.noun} yet (${name}).` }
	const language =
		entry.format === 'code'
			? (CODE_LANGUAGES[extension] ?? 'plain')
			: entry.format === 'data'
				? (DATA_LANGUAGES[extension] ?? 'json')
				: entry.format === 'markdown'
					? 'markdown'
					: entry.format === 'image'
						? (IMAGE_EXTENSIONS[extension] ?? 'png')
						: entry.format === 'heic' || entry.format === 'svg' || entry.format === 'pdf'
							? entry.format
							: entry.format === 'csv'
								? extension === '.csv'
									? 'csv'
									: 'tsv'
								: 'plain'
	return { ok: true, entry, extension, language }
}

export type TextEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be'

/** The encoding a text family's bytes declare: a UTF-16 BOM decodes as UTF-16, anything else must be UTF-8. */
export function textEncoding(head: Uint8Array): TextEncoding {
	if (starts(head, [0xff, 0xfe])) return 'utf-16le'
	if (starts(head, [0xfe, 0xff])) return 'utf-16be'
	if (starts(head, [0xef, 0xbb, 0xbf])) return 'utf-8-bom'
	return 'utf-8'
}

/** What a known binary signature says the bytes are, or null. Text families refuse such bytes. */
export function binarySignature(head: Uint8Array): string | null {
	return SIGNATURES.find(signature => signature.test(head))?.what ?? null
}

export const ENCODING_LABEL: Readonly<Record<TextEncoding, string>> = {
	'utf-8': 'UTF-8',
	'utf-8-bom': 'UTF-8 with BOM',
	'utf-16le': 'UTF-16 LE',
	'utf-16be': 'UTF-16 BE',
}

/** The decoder label for `TextDecoder`. */
export const decoderLabel = (encoding: TextEncoding) =>
	encoding === 'utf-16le' ? 'utf-16le' : encoding === 'utf-16be' ? 'utf-16be' : 'utf-8'

export type LineEnding = 'LF' | 'CRLF' | 'CR' | 'mixed' | 'none'

/** Line count and ending of decoded text. One pass, no splitting. */
export function textShape(text: string): { lines: number; ending: LineEnding } {
	let lines = 1
	let lf = 0
	let crlf = 0
	let cr = 0
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index)
		if (code === 10) {
			lines++
			lf++
		} else if (code === 13) {
			lines++
			if (text.charCodeAt(index + 1) === 10) {
				crlf++
				index++
			} else cr++
		}
	}
	const kinds = (lf > 0 ? 1 : 0) + (crlf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0)
	const ending: LineEnding = kinds === 0 ? 'none' : kinds > 1 ? 'mixed' : lf ? 'LF' : crlf ? 'CRLF' : 'CR'
	return { lines, ending }
}

/** "16 MiB", "512 KiB", "3.2 MiB": sizes in refusals, always with the binary unit. */
export function sizeText(bytes: number): string {
	if (bytes >= MiB) {
		const value = bytes / MiB
		return `${Number.isInteger(value) ? value : value.toFixed(1)} MiB`
	}
	return `${Math.ceil(bytes / KiB)} KiB`
}

/** "1,000,000": counts in refusals. */
export const countText = (value: number) => value.toLocaleString('en-US')
