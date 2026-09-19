/**
 * Destination glyphs for the tab bar. Stroked rather than filled so they read at 24px
 * against a dark bar, and drawn on the same 24-unit grid as the platform's own.
 */
export function RemoteSessionsIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
			<path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9" strokeLinecap="round" />
		</svg>
	)
}

export function RemoteUsageIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
			<path d="M5 19V11M12 19V5M19 19v-5" strokeLinecap="round" />
		</svg>
	)
}
