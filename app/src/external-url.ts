const MAX_EXTERNAL_URL_LENGTH = 2048

/**
 * Accept only bounded HTTP(S) URLs for OS-browser handoff. Renderer content is
 * untrusted input at this boundary; file, javascript, data, and custom schemes
 * must never reach Electron's shell.openExternal.
 */
export function parseExternalHttpUrl(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EXTERNAL_URL_LENGTH) return null
	if (/\p{Cc}/u.test(value)) return null
	try {
		const url = new URL(value)
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
		return url.href
	} catch {
		return null
	}
}

// app/package.json is CommonJS; plain-Node tests loaded through tsx receive the
// module namespace through the default export.
export default { parseExternalHttpUrl }
