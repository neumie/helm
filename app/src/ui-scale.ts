// UI text scale (Settings → Appearance; docs/design-system.md §2.8): the three values the cockpit offers. The
// cockpit owns the choice (appearance.ts, localStorage); main relays it to the document windows, which run in
// their own in-memory session and never see the cockpit's storage (§9 ruling 108).

export const UI_SCALE_VALUES = [0.92, 1, 1.08] as const

export type UiScaleValue = (typeof UI_SCALE_VALUES)[number]

/** One of the offered scales, else the default 1. */
export function uiScaleOrDefault(raw: unknown): UiScaleValue {
	return UI_SCALE_VALUES.find(value => value === raw) ?? 1
}
