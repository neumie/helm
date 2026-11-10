// Copy image as PNG for `helm open` picture windows (docs/plans/helm-open/spec.md, Renderer isolation): the window
// encodes PNG itself; main only walks the chunks (structure, CRCs, size) and never decodes pixels before handing
// the bytes to the pasteboard. Electron-free so `node --test` covers it.
import { crc32 } from 'node:zlib'
import { inspectPngStructure } from '../../../src/document-review/image-header'

/** The macOS pasteboard type for PNG (Electron's `writeBuffer` takes the platform's own format name). */
export const PNG_PASTEBOARD = process.platform === 'darwin' ? 'public.png' : 'image/png'
/** Largest PNG a window may put on the clipboard. */
export const COPY_PNG_BYTES = 256 * 1024 * 1024

export function copyPngToClipboard(raw: unknown, write: (bytes: Buffer) => void): { width: number; height: number } {
	if (!(raw instanceof Uint8Array)) throw new Error('The image is not a valid PNG.')
	if (raw.byteLength > COPY_PNG_BYTES) throw new Error('This image is too large to copy.')
	const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
	let size: { width: number; height: number }
	try {
		size = inspectPngStructure(bytes, COPY_PNG_BYTES, crc32)
	} catch {
		throw new Error('The image is not a valid PNG.')
	}
	write(Buffer.from(bytes))
	return size
}
