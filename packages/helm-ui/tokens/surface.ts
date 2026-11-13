// Surface and layout tokens that are not colours of the theme. Not theme tokens.
export const SURFACE_TOKENS = {
	// The paper behind a rendered PDF page (§3.27): white whatever the theme, like the printed page.
	'--paper': '#fff',
	// The task sidebar's default width (§3.14); sidebar-layout.ts sets the operator's width at runtime.
	'--left-width': '340px',
} as const satisfies Record<string, string>
