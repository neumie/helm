/** Display links never authorize arbitrary schemes or credential-bearing URLs. */
export function externalHttpUrl(value: string | null): string | null {
	if (!value || value.length > 4096) return null
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code <= 0x20 || code === 0x7f) return null
	}
	try {
		const url = new URL(value)
		return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url.href : null
	} catch {
		return null
	}
}
