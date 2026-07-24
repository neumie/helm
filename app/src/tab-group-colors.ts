export const TAB_GROUP_COLORS = ['blue', 'purple', 'pink', 'red', 'orange', 'green', 'cyan'] as const

export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number]

export const TAB_GROUP_COLOR_LABELS: Record<TabGroupColor, string> = {
	blue: 'Blue',
	purple: 'Purple',
	pink: 'Pink',
	red: 'Red',
	orange: 'Orange',
	green: 'Green',
	cyan: 'Cyan',
}

export function isTabGroupColor(value: unknown): value is TabGroupColor {
	return typeof value === 'string' && TAB_GROUP_COLORS.includes(value as TabGroupColor)
}

/** Stable legacy/new-group fallback without storing display colors in session rows. */
export function defaultTabGroupColor(groupId: string): TabGroupColor {
	let hash = 0
	for (const character of groupId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
	return TAB_GROUP_COLORS[hash % TAB_GROUP_COLORS.length] ?? 'blue'
}

/** Safe CSS indirection: callers never interpolate persisted values directly. */
export function tabGroupColorCssVar(color: TabGroupColor): string {
	return `var(--group-${color})`
}

export default {
	TAB_GROUP_COLORS,
	TAB_GROUP_COLOR_LABELS,
	defaultTabGroupColor,
	isTabGroupColor,
	tabGroupColorCssVar,
}
