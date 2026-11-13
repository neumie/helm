// Z-index tokens (docs/design-system.md §2.7), with today's values. Not theme tokens.
export const Z_TOKENS = {
	// Order inside one component's own stacking context (a pseudo-element behind its box, overlays above its
	// content); never a layer between surfaces.
	'--z-under': '-1',
	'--z-content': '0',
	'--z-local-1': '1',
	'--z-local-2': '2',
	'--z-local-3': '3',
	'--z-local-4': '4',
	// The §2.7 layers.
	'--z-bar': '10', // pinned bars: topbar, action bar, push-nav header
	'--z-menu': '40', // menus and popovers
	'--z-sheet': '60', // sheet + scrim
	'--z-toast': '100',
	'--z-widget-host': '2147483647', // the extension widget's shadow host only (competes with the host page)
} as const satisfies Record<string, string>
