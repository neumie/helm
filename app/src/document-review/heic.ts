// HEIC/HEIF for `helm open` (docs/plans/helm-open/spec.md, Formats: HEIC). Converted out of process: the pinned
// descriptor's bytes are copied into a private 0700 folder as a 0600 file, `/usr/bin/sips -g pixelWidth -g
// pixelHeight` enforces the 150 MP cap, then `sips -s format png` runs in a time-limited child. Main never decodes
// the original (no `nativeImage`); the PNG goes to the window by token and is only walked (`inspectPngStructure`).
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { ImageHeaderError, inspectPngStructure, pixelLimitRefusal } from '../../../src/document-review/image-header'
import { refuse } from '../../../src/document-review/refusal'
import type { ViewerFileSource } from './viewer-protocol'

export const SIPS = '/usr/bin/sips'
/** Size probe and conversion budgets; a stuck child is killed. */
export const HEIC_PROBE_MS = 15_000
export const HEIC_CONVERT_MS = 60_000
/** Largest PNG accepted from `sips` (150 MP of 16-bit RGBA compresses well below this). */
export const HEIC_PNG_BYTES = 640 * 1024 * 1024
const CHUNK = 8 * 1024 * 1024

export interface HeicOptions {
	/** Test seam: another `sips` (a script that writes nothing proves the empty-result refusal). */
	sips?: string
	probeMs?: number
	convertMs?: number
	signal?: AbortSignal
}
export interface HeicResult {
	png: Buffer
	width: number
	height: number
}

function run(file: string, args: string[], timeout: number, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{ timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin' }, signal },
			(error, stdout) => (error ? reject(error) : resolve(String(stdout))),
		)
	})
}

const slow = (name: string) => `${name} was not opened: converting it from HEIC did not finish in time.`

/** `pixelWidth: N` / `pixelHeight: N` from `sips -g` output, or null. */
export function sipsDimensions(output: string): { width: number; height: number } | null {
	const width = /^\s*pixelWidth:\s*(\d{1,9})\s*$/m.exec(output)?.[1]
	const height = /^\s*pixelHeight:\s*(\d{1,9})\s*$/m.exec(output)?.[1]
	if (!width || !height) return null
	return { width: Number(width), height: Number(height) }
}

/** Convert one admitted HEIC (read through its pinned source) to PNG; refusals name the file and the numbers. */
export async function convertHeic(
	name: string,
	source: ViewerFileSource,
	options: HeicOptions = {},
): Promise<HeicResult> {
	const sips = options.sips ?? SIPS
	const folder = await mkdtemp(join(tmpdir(), 'helm-heic-'))
	try {
		const copy = join(folder, 'source.heic')
		const out = join(folder, 'converted.png')
		const target = await open(
			copy,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		)
		try {
			for (let offset = 0; offset < source.size; offset += CHUNK) {
				const bytes = await source.read(offset, Math.min(CHUNK, source.size - offset))
				await target.write(bytes, 0, bytes.length, offset)
			}
		} finally {
			await target.close()
		}
		let probe: string
		try {
			probe = await run(
				sips,
				['-g', 'pixelWidth', '-g', 'pixelHeight', copy],
				options.probeMs ?? HEIC_PROBE_MS,
				options.signal,
			)
		} catch {
			if (options.signal?.aborted) throw refuse(slow(name))
			throw refuse(`${name} can't be shown: macOS could not read it as a HEIC image.`)
		}
		const size = sipsDimensions(probe)
		if (!size || size.width < 1 || size.height < 1)
			throw refuse(`${name} can't be shown: macOS reports no width and height for it.`)
		const capped = pixelLimitRefusal(name, size.width, size.height)
		if (capped) throw refuse(capped)
		try {
			await run(sips, ['-s', 'format', 'png', copy, '--out', out], options.convertMs ?? HEIC_CONVERT_MS, options.signal)
		} catch {
			if (options.signal?.aborted) throw refuse(slow(name))
			throw refuse(`${name} can't be shown: macOS could not convert it to PNG.`)
		}
		const handle = await open(out, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null)
		if (!handle) throw refuse(`${name} can't be shown: the conversion produced nothing.`)
		let png: Buffer
		try {
			const stat = await handle.stat()
			if (!stat.isFile() || stat.size === 0) throw refuse(`${name} can't be shown: the conversion produced nothing.`)
			if (stat.size > HEIC_PNG_BYTES) throw refuse(`${name} can't be shown: the converted image is too large.`)
			png = Buffer.alloc(stat.size)
			let used = 0
			while (used < png.length) {
				const read = await handle.read(png, used, png.length - used, used)
				if (read.bytesRead === 0) break
				used += read.bytesRead
			}
			if (used !== png.length) throw refuse(`${name} can't be shown: the conversion was cut short.`)
		} finally {
			await handle.close()
		}
		let made: { width: number; height: number }
		try {
			made = inspectPngStructure(png, HEIC_PNG_BYTES, crc32)
		} catch (error) {
			if (error instanceof ImageHeaderError) throw refuse(`${name} can't be shown: the conversion is not a valid PNG.`)
			throw error
		}
		const agrees =
			(made.width === size.width && made.height === size.height) ||
			(made.width === size.height && made.height === size.width)
		if (!agrees)
			throw refuse(
				`${name} can't be shown: macOS reported ${size.width} × ${size.height} but converted it to ${made.width} × ${made.height}.`,
			)
		return { png, width: made.width, height: made.height }
	} finally {
		await rm(folder, { recursive: true, force: true })
	}
}

/** Serves bytes Helm made itself (a converted HEIC) through a view token. */
export function memoryViewerSource(bytes: Uint8Array): ViewerFileSource {
	let closed = false
	return {
		size: bytes.length,
		async read(offset, count) {
			if (closed) throw new RangeError('closed')
			if (offset < 0 || count < 0 || offset + count > bytes.length) throw new RangeError('outside the served bytes')
			return bytes.subarray(offset, offset + count)
		},
		close() {
			closed = true
		},
	}
}
