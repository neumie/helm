// Reads a view token's bytes in ranges of at most the protocol's cap (a full response past it is refused).
// A stale token (409 after a change, 404 after revocation) reads as null: the newer token is on its way.
export const TOKEN_RANGE_BYTES = 64 * 1024 * 1024

export async function readTokenBytes(url: string, size: number, signal: AbortSignal): Promise<ArrayBuffer | null> {
	if (size <= TOKEN_RANGE_BYTES) {
		const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' })
		if (response.status === 409 || response.status === 404) return null
		if (!response.ok) throw new Error(`The file could not be read (${response.status}).`)
		const bytes = await response.arrayBuffer()
		if (bytes.byteLength !== size) throw new Error('The file could not be read completely.')
		return bytes
	}
	const whole = new Uint8Array(size)
	for (let start = 0; start < size; start += TOKEN_RANGE_BYTES) {
		const end = Math.min(size, start + TOKEN_RANGE_BYTES) - 1
		const response = await fetch(url, {
			signal,
			cache: 'no-store',
			credentials: 'omit',
			headers: { Range: `bytes=${start}-${end}` },
		})
		if (response.status === 409 || response.status === 404) return null
		if (response.status !== 206) throw new Error(`The file could not be read (${response.status}).`)
		const part = new Uint8Array(await response.arrayBuffer())
		if (part.length !== end - start + 1) throw new Error('The file could not be read completely.')
		whole.set(part, start)
	}
	return whole.buffer
}
