/** Encoding adapter for xterm text and binary input at the node-pty seam. */
export function encodePtyInput(data: unknown, binary: unknown = false): string | Buffer | null {
	if (typeof data !== 'string' || (binary !== false && binary !== true)) return null
	if (!binary) return data
	// onBinary is an eight-bit string. Buffer.from(..., 'latin1') would silently
	// truncate non-byte characters, so reject malformed input before conversion.
	for (let index = 0; index < data.length; index++) if (data.charCodeAt(index) > 255) return null
	return Buffer.from(data, 'latin1')
}
