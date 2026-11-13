// Type tokens (docs/design-system.md §2.2): the two families, defined once on `:root`; components use
// `var(--font-ui)` / `var(--font-mono)`, never a hand-written stack (§9 ruling 14). Not theme tokens.
export const TYPE_TOKENS = {
	'--font-ui': '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
	'--font-mono': '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
	// The sidebar's UI text scale (§2.2): 0.92 / 1 / 1.08 from Settings → Appearance; appearance.ts sets it at runtime.
	'--ui-scale': '1',
} as const satisfies Record<string, string>
