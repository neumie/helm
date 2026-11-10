// Range reads of a view's PDF token (docs/plans/helm-open/spec.md, Streamed files). pdf.js asks for byte ranges and
// this answers each with one `Range` request to the helm-viewer: token. A 409 (the file changed: main is reading the
// new version) or 404 (the token was revoked) ends the stream: no more reads, and the newer token is on its way.
import { TOKEN_RANGE_BYTES } from './token-bytes'

export type RangeRead = { kind: 'bytes'; bytes: Uint8Array } | { kind: 'stale' }

/** Bytes `[begin, end)` of the token at `url`, whose size is `size`. */
export async function readTokenRange(
	url: string,
	size: number,
	begin: number,
	end: number,
	signal: AbortSignal,
): Promise<RangeRead> {
	if (!(begin >= 0 && end <= size && end > begin)) throw new RangeError('The PDF asked for bytes it does not have.')
	const whole = new Uint8Array(end - begin)
	for (let start = begin; start < end; start += TOKEN_RANGE_BYTES) {
		const last = Math.min(end, start + TOKEN_RANGE_BYTES) - 1
		const response = await fetch(url, {
			signal,
			cache: 'no-store',
			credentials: 'omit',
			headers: { Range: `bytes=${start}-${last}` },
		})
		if (response.status === 409 || response.status === 404) return { kind: 'stale' }
		const full = response.status === 200 && start === 0 && last === size - 1
		if (response.status !== 206 && !full) throw new Error(`The PDF could not be read (${response.status}).`)
		// A part must be the part asked for, of a file of the size this view admitted.
		if (response.status === 206 && response.headers.get('content-range') !== `bytes ${start}-${last}/${size}`)
			throw new Error('The PDF answered a different range.')
		const part = new Uint8Array(await response.arrayBuffer())
		if (part.length !== last - start + 1) throw new Error('The PDF could not be read completely.')
		whole.set(part, start - begin)
	}
	return { kind: 'bytes', bytes: whole }
}
