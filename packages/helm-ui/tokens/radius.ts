// Radius tokens (docs/design-system.md §2.4, §9 rulings 17 and 100). Not theme tokens.
export const RADIUS_TOKENS = {
	'--radius-lg': '8px',
	'--radius-md': '6px',
	'--radius-sm': '4px',
	// Helm Remote phone radii (§9 ruling 100): rows, fields and menu items; bubble and floating surfaces; the
	// composer capsule at half its 56px rest height. Remote only (the lint refuses them elsewhere).
	'--radius-touch': '12px',
	'--radius-float': '18px',
	'--radius-capsule': '28px',
} as const satisfies Record<string, string>
