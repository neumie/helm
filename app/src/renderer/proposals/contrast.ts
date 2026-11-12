// WCAG 2.x contrast for proposal captions. Colours are #rrggbb, or #rrggbb + alpha composited over a base
// (the way a translucent fill reads on its surface). Storybook-only; the enforced table is S4's contrast test.

const channel = (hex: string, offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16)

export function parseHex(hex: string): readonly [number, number, number] {
	if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Expected #rrggbb, got ${hex}`)
	return [channel(hex, 1), channel(hex, 3), channel(hex, 5)]
}

/** `fg` at `alpha` over opaque `base`, as #rrggbb. */
export function over(fg: string, alpha: number, base: string): string {
	const a = parseHex(fg)
	const b = parseHex(base)
	return `#${a
		.map((value, index) => Math.round(value * alpha + (b[index] ?? 0) * (1 - alpha)))
		.map(value => value.toString(16).padStart(2, '0'))
		.join('')}`
}

function luminance(hex: string): number {
	const [r, g, b] = parseHex(hex).map(value => {
		const s = value / 255
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
	}) as unknown as [number, number, number]
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(fg: string, bg: string): number {
	const a = luminance(fg)
	const b = luminance(bg)
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** "2.96:1" (truncated, never rounded up across a threshold). */
export function ratio(fg: string, bg: string): string {
	return `${(Math.floor(contrast(fg, bg) * 100) / 100).toFixed(2)}:1`
}
