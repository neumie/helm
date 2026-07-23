// helm:// deep links. Current links are profile-qualified so an Item id is
// always resolved against the database that owns it:
//   helm://profile/<profileId>/item/<itemId>
// Legacy helm://item/<id> and vigil://item/<id> links remain accepted and open
// in the currently active profile. Electron-free for plain-node tests.

export interface HelmItemDestination {
	itemId: string
	profileId: string | null
}

function segment(raw: string): string | null {
	try {
		const value = decodeURIComponent(raw)
		return value !== '' && !value.includes('/') ? value : null
	} catch {
		return null
	}
}

/** Parse a current profile-qualified or legacy Item destination. */
export function parseHelmDestination(raw: string): HelmItemDestination | null {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return null
	}
	if (url.protocol !== 'helm:' && url.protocol !== 'vigil:') return null
	const parts = url.pathname.split('/').filter(Boolean)
	if (url.hostname === 'item' && parts.length === 1) {
		const itemId = segment(parts[0] ?? '')
		return itemId ? { itemId, profileId: null } : null
	}
	if (url.hostname === 'profile' && parts.length === 3 && parts[1] === 'item') {
		const profileId = segment(parts[0] ?? '')
		const itemId = segment(parts[2] ?? '')
		return profileId && itemId ? { itemId, profileId } : null
	}
	return null
}

/** Legacy compatibility helper retained for callers that only need an Item id. */
export function parseHelmItemUrl(raw: string): string | null {
	return parseHelmDestination(raw)?.itemId ?? null
}
