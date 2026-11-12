// WCAG 2.x contrast for the design system's measured pairs (docs/design-system.md §2.9).
//
// Colours are resolved from CSS custom-property declarations the way a browser paints them:
// - `var(--x)` / `var(--x, fallback)` resolve against the scope that declares the property (a custom
//   property holding `var()` is computed on the element that declares it, and descendants inherit the
//   computed colour; that is why Review light re-declares `--danger-soft` but not `--accent-soft`).
// - `color-mix(in srgb, A p%, B)` mixes premultiplied sRGB (gamma space), so `X 15%, transparent` is X at
//   alpha 0.15.
// - Translucent layers are composited source-over in gamma-space sRGB (as browsers paint them), in exact
//   arithmetic like Tally's measureContrast. A real rasteriser quantises to 8 bits and lands within 1.5/255
//   per channel of this (checked against Chromium's painted pixels for every row, 2026-11-12), so a
//   ratio here can differ from a pixel-picker reading in the second decimal; the rule is the exact value.
// Plain data in, numbers out: no DOM, no Node APIs, safe for Storybook and node tests alike.

export interface Rgba {
	readonly r: number
	readonly g: number
	readonly b: number
	/** 0..1 */
	readonly a: number
}

/** A scope's declarations, outermost scope first (e.g. `:root`, then `.agent-dock`). */
export type Scopes = readonly Readonly<Record<string, string>>[]

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 }

function parseHex(hex: string): Rgba {
	const digits = hex.slice(1)
	const full = digits.length === 3 || digits.length === 4 ? [...digits].map(d => d + d).join('') : digits
	if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) throw new Error(`Bad hex colour ${hex}`)
	const byte = (i: number) => Number.parseInt(full.slice(i, i + 2), 16)
	return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) / 255 : 1 }
}

function parseAlpha(text: string): number {
	const t = text.trim()
	return t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t)
}

function parseRgbFunction(text: string): Rgba {
	const inner = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')).trim()
	let parts: string[]
	let alpha = '1'
	if (inner.includes(',')) {
		parts = inner.split(',').map(p => p.trim())
		if (parts.length === 4) alpha = parts.pop() ?? '1'
	} else {
		const [channels, slash] = inner.split('/')
		parts = (channels ?? '').trim().split(/\s+/)
		if (slash !== undefined) alpha = slash
	}
	if (parts.length !== 3) throw new Error(`Bad rgb() colour ${text}`)
	const channel = (p: string) => (p.endsWith('%') ? (Number(p.slice(0, -1)) / 100) * 255 : Number(p))
	const [r, g, b] = parts.map(channel) as [number, number, number]
	const a = parseAlpha(alpha)
	if (![r, g, b, a].every(Number.isFinite)) throw new Error(`Bad rgb() colour ${text}`)
	return { r, g, b, a }
}

/** Split `a, b(c, d), e` on top-level commas. */
function splitArgs(text: string): string[] {
	const out: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < text.length; i++) {
		const c = text[i]
		if (c === '(') depth++
		else if (c === ')') depth--
		else if (c === ',' && depth === 0) {
			out.push(text.slice(start, i).trim())
			start = i + 1
		}
	}
	out.push(text.slice(start).trim())
	return out
}

function functionArgs(text: string, name: string): string[] {
	if (!text.startsWith(`${name}(`) || !text.endsWith(')')) throw new Error(`Expected ${name}(…), got ${text}`)
	return splitArgs(text.slice(name.length + 1, -1))
}

/** `color-mix` operand: `<colour> [<p>%]`, the percentage last. */
function mixOperand(text: string): { colour: string; percent: number | null } {
	const match = /^(.*\S)\s+(-?\d*\.?\d+)%$/.exec(text)
	return match ? { colour: match[1] ?? '', percent: Number(match[2]) } : { colour: text, percent: null }
}

function colorMix(a: Rgba, pa: number, b: Rgba, pb: number): Rgba {
	const sum = pa + pb
	const wa = pa / sum
	const wb = pb / sum
	const alpha = a.a * wa + b.a * wb
	const channel = (ca: number, cb: number) => (alpha === 0 ? 0 : (ca * a.a * wa + cb * b.a * wb) / alpha)
	// A sum under 100% scales the result's alpha (CSS Color 5 §2.2).
	const scale = Math.min(sum, 100) / 100
	return { r: channel(a.r, b.r), g: channel(a.g, b.g), b: channel(a.b, b.b), a: alpha * scale }
}

/** Resolve a property declared in `scopes` (innermost declaration wins). */
export function resolveProperty(scopes: Scopes, name: string, depth = 0): Rgba {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const value = scopes[i]?.[name]
		if (value !== undefined) return resolveValue(scopes.slice(0, i + 1), value, depth + 1)
	}
	throw new Error(`Unknown colour ${name}`)
}

/** Resolve a CSS colour value whose `var()` references resolve against `scopes`. */
export function resolveValue(scopes: Scopes, value: string, depth = 0): Rgba {
	if (depth > 20) throw new Error(`Colour reference cycle at ${value}`)
	const text = value.trim().replace(/\s+/g, ' ')
	if (text === 'transparent') return TRANSPARENT
	if (text.startsWith('#')) return parseHex(text)
	if (text.startsWith('rgb(') || text.startsWith('rgba(')) return parseRgbFunction(text)
	if (text.startsWith('var(')) {
		const [name = '', ...fallback] = functionArgs(text, 'var')
		const declared = scopes.some(scope => scope[name] !== undefined)
		if (declared) return resolveProperty(scopes, name, depth + 1)
		if (fallback.length > 0) return resolveValue(scopes, fallback.join(', '), depth + 1)
		throw new Error(`Unknown colour ${name}`)
	}
	if (text.startsWith('color-mix(')) {
		const [space, first = '', second = ''] = functionArgs(text, 'color-mix')
		if (space !== 'in srgb') throw new Error(`Only srgb color-mix is supported: ${text}`)
		const a = mixOperand(first)
		const b = mixOperand(second)
		const pa = a.percent ?? (b.percent === null ? 50 : 100 - b.percent)
		const pb = b.percent ?? 100 - pa
		return colorMix(resolveValue(scopes, a.colour, depth + 1), pa, resolveValue(scopes, b.colour, depth + 1), pb)
	}
	throw new Error(`Unsupported colour value ${value}`)
}

const round8 = (c: number) => Math.min(255, Math.max(0, Math.round(c)))

/** Paint `top` over the opaque `base` (source-over, gamma sRGB). */
export function over(top: Rgba, base: Rgba): Rgba {
	if (base.a !== 1) throw new Error('Composite base must be opaque')
	const mix = (t: number, b: number) => t * top.a + b * (1 - top.a)
	return { r: mix(top.r, base.r), g: mix(top.g, base.g), b: mix(top.b, base.b), a: 1 }
}

/** Paint `layers` bottom-up; the bottom layer must be opaque. */
export function paint(scopes: Scopes, layers: readonly string[]): Rgba {
	const [bottom, ...rest] = layers
	if (bottom === undefined) throw new Error('A background needs at least one layer')
	const base = resolveProperty(scopes, bottom)
	if (base.a !== 1) throw new Error(`Bottom layer ${bottom} is translucent; name the surface under it`)
	let painted: Rgba = base
	for (const layer of rest) painted = over(resolveProperty(scopes, layer), painted)
	return painted
}

function linear(channel: number): number {
	const s = channel / 255
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function luminance(c: Rgba): number {
	return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
}

/** WCAG 2.x contrast ratio of two opaque colours (1..21). */
export function contrast(a: Rgba, b: Rgba): number {
	const la = luminance(a)
	const lb = luminance(b)
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Two decimals, truncated: a ratio never reads as passing a threshold it misses. */
export function truncate2(ratio: number): number {
	return Math.floor(ratio * 100 + 1e-9) / 100
}

export function toHex(c: Rgba): string {
	return `#${[c.r, c.g, c.b].map(v => round8(v).toString(16).padStart(2, '0')).join('')}`
}
