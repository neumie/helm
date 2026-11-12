// Helm's icon module (docs/design-system.md §0 Icons, §9 ruling 54): the geometry of every production icon in the
// desktop renderer, with its source. Each entry is the exact SVG a production site renders: the same path data,
// viewBox, size, fill/stroke, class and aria attributes, in the same attribute order. Two forms come from one
// entry: `iconNode` (createElementNS, for the plain-DOM terminal workspace) here, and `iconElement`/`Icon`/`GLYPH`
// (React) in ./Icon.tsx. Storybook: Primitives/Icons. Check: tests/design-icons.test.ts.
//
// Adding an icon: vendor it from an established set at its native size (16px solid Heroicons for strip-scale
// controls), copy the upstream geometry unchanged, give it a `heroicons` source and list it in
// THIRD_PARTY_NOTICES.md. The `hand-drawn` entries are Helm's own drawings, kept as they are until decision D6
// (docs/plans/design-system/spec.md) rules on them; never add a new one.
//
// Icons that are NOT in this module, and why (`ICONS_OUTSIDE_MODULE` below holds the same list for the test and
// the story):
// - app/src/renderer/index.html: the Background terminals toggle's static first-paint markup. It is a copy of
//   `backgroundStack`; tests/design-icons.test.ts holds its path data equal to this module's.
// - app/src/renderer/sidebar/sidebar.css `.select`: the select chevron as a CSS data URI (§3.7). Hand-drawn (D6).
// - extension/src/Widget.tsx `ModelSelect`: the chevron (10×6) and check (10×8) of the widget's model picker.
//   Hand-drawn (D6). The extension is SolidJS and keeps its own icons (decision D1).
// - app/assets/remote/command-line.svg: the Helm Remote PWA launcher source (Heroicons Command Line, v2.2.0),
//   rendered to PNGs by app/scripts/write-remote-icons.mjs.
// Prototypes (app/src/renderer/open-prototype/), proposals (app/src/renderer/proposals/) and Storybook fixtures
// are not production and may draw their own.

/** SVG attributes in DOM spelling (`stroke-width`, `aria-hidden`, `class`), in the order the element gets them. */
export type IconAttributes = Readonly<Record<string, string>>

export interface IconShape {
	readonly tag: 'path' | 'circle' | 'rect'
	readonly attributes: IconAttributes
}

export type IconSource =
	| {
			readonly kind: 'heroicons'
			/** The Heroicons name as heroicons.com and THIRD_PARTY_NOTICES.md spell it. */
			readonly name: string
			readonly style: '16 solid'
			/** Upstream tag or commit the geometry was copied from. */
			readonly revision: string
			readonly url: string
			readonly license: 'MIT'
	  }
	| { readonly kind: 'hand-drawn'; readonly decision: 'D6' }

export interface IconData {
	readonly svg: IconAttributes
	readonly shapes: readonly IconShape[]
	readonly source: IconSource
	/** Where production renders it. */
	readonly usedBy: string
}

const HAND_DRAWN: IconSource = { kind: 'hand-drawn', decision: 'D6' }

const heroicon = (name: string, file: string, revision: string): IconSource => ({
	kind: 'heroicons',
	name,
	style: '16 solid',
	revision,
	url: `https://github.com/tailwindlabs/heroicons/blob/${revision}/optimized/16/solid/${file}.svg`,
	license: 'MIT',
})

/** Heroicons commit the terminal-strip and Scheduled runs icons were vendored from. */
const HEROICONS_STRIP = '616b7a4dbbf3d011760af8066262cd5c6b3868f3'
const HEROICONS_V2_2 = 'v2.2.0'

const path = (attributes: IconAttributes): IconShape => ({ tag: 'path', attributes })

/** The sidebar's stroke glyph: a 16-unit viewBox path at 1.5 units, stroke following currentColor so button tones apply. */
const glyph = (d: string, usedBy: string, size = 14): IconData => ({
	svg: { width: String(size), height: String(size), viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
	shapes: [
		path({
			d,
			stroke: 'currentColor',
			'stroke-width': '1.5',
			'stroke-linecap': 'round',
			'stroke-linejoin': 'round',
		}),
	],
	source: HAND_DRAWN,
	usedBy,
})

const SIDEBAR = 'GLYPH (sidebar, Document Review, Remote)'

export const ICONS = {
	plus: glyph('M8 3v10M3 8h10', SIDEBAR),
	menu: {
		svg: { width: '16', height: '16', viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
		shapes: [
			path({
				'fill-rule': 'evenodd',
				d: 'M2 4.75A.75.75 0 0 1 2.75 4h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 6.5a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z',
				'clip-rule': 'evenodd',
			}),
		],
		source: heroicon('Bars 2', 'bars-2', HEROICONS_V2_2),
		usedBy: 'GLYPH.menu (Remote navigation drawer)',
	},
	back: glyph('M9.5 3.5 5 8l4.5 4.5', SIDEBAR),
	chevronRight: glyph('M6 3.5 10.5 8 6 12.5', SIDEBAR, 12),
	chevronDown: glyph('M3.5 6 8 10.5 12.5 6', SIDEBAR, 12),
	ellipsis: {
		svg: { width: '14', height: '14', viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
		shapes: [
			{ tag: 'circle', attributes: { cx: '3', cy: '8', r: '1.3' } },
			{ tag: 'circle', attributes: { cx: '8', cy: '8', r: '1.3' } },
			{ tag: 'circle', attributes: { cx: '13', cy: '8', r: '1.3' } },
		],
		source: HAND_DRAWN,
		usedBy: SIDEBAR,
	},
	external: glyph('M6.5 4H4v8h8V9.5M9 3h4v4M13 3 7.5 8.5', SIDEBAR, 12),
	copy: glyph('M6 6h7v7H6zM10 6V3H3v7h3', SIDEBAR, 12),
	check: glyph('M3.5 8.5 6.5 11.5 12.5 4.5', SIDEBAR),
	agent: glyph('M4 5h8v7H4zM8 2.5V5M6 8h.1M9.9 8h.1M6 10h4', SIDEBAR),
	manual: glyph('M8 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M3.5 13a4.5 4 0 0 1 9 0', SIDEBAR),
	play: glyph('M5 3.5 12 8 5 12.5z', SIDEBAR),
	queue: glyph('M8 2.5v7M5.5 7 8 9.5 10.5 7M3.5 12.5h9', SIDEBAR),
	retry: glyph('M12.5 5.5V2.8l-2.2 1.4A5 5 0 1 0 13 8', SIDEBAR),
	stop: glyph('M4.5 4.5h7v7h-7z', SIDEBAR),
	pause: glyph('M5.5 4v8M10.5 4v8', SIDEBAR),
	return: glyph('M6.5 4 3 7.5 6.5 11M3.5 7.5H9a4 4 0 0 1 4 4', SIDEBAR),
	plan: glyph('M4 2.5h6l2 2V13.5H4zM10 2.5v2h2M6 7h4M6 9.5h4', SIDEBAR, 13),
	archive: glyph('M3 5h10v8H3zM2.5 3h11v2h-11M6.5 8h3', SIDEBAR),
	calendar: {
		svg: { width: '14', height: '14', viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
		shapes: [
			path({
				d: 'M5.75 7.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM5 10.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0ZM10.25 7.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM7.25 8.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0ZM8 9.5A.75.75 0 1 0 8 11a.75.75 0 0 0 0-1.5Z',
			}),
			path({
				'fill-rule': 'evenodd',
				d: 'M4.75 1a.75.75 0 0 0-.75.75V3a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2V1.75a.75.75 0 0 0-1.5 0V3h-5V1.75A.75.75 0 0 0 4.75 1ZM3.5 7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V7Z',
				'clip-rule': 'evenodd',
			}),
		],
		source: heroicon('Calendar Days', 'calendar-days', HEROICONS_STRIP),
		usedBy: 'GLYPH.calendar (Scheduled runs)',
	},
	group: glyph('M3 3.5h10v3H3zM3 9.5h7v3H3z', SIDEBAR),
	settings: glyph(
		'M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5M8 2.5v1M8 12.5v1M2.5 8h1M12.5 8h1M4.1 4.1l.7.7M11.2 11.2l.7.7M11.9 4.1l-.7.7M4.8 11.2l-.7.7',
		SIDEBAR,
	),
	close: glyph('M4 4l8 8M12 4l-8 8', SIDEBAR),
	arrowUp: {
		svg: { width: '16', height: '16', viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
		shapes: [
			path({
				'fill-rule': 'evenodd',
				'clip-rule': 'evenodd',
				d: 'M8 14a.75.75 0 0 1-.75-.75V4.56L4.03 7.78a.75.75 0 0 1-1.06-1.06l4.5-4.5a.75.75 0 0 1 1.06 0l4.5 4.5a.75.75 0 0 1-1.06 1.06L8.75 4.56v8.69A.75.75 0 0 1 8 14Z',
			}),
		],
		source: heroicon('Arrow Up', 'arrow-up', HEROICONS_V2_2),
		usedBy: 'RemoteArrow (Remote composer send, Earlier messages)',
	},
	arrowDown: {
		svg: { width: '16', height: '16', viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
		shapes: [
			path({
				'fill-rule': 'evenodd',
				'clip-rule': 'evenodd',
				d: 'M8 2a.75.75 0 0 1 .75.75v8.69l3.22-3.22a.75.75 0 1 1 1.06 1.06l-4.5 4.5a.75.75 0 0 1-1.06 0l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.22 3.22V2.75A.75.75 0 0 1 8 2Z',
			}),
		],
		source: heroicon('Arrow Down', 'arrow-down', HEROICONS_V2_2),
		usedBy: 'RemoteArrow (Remote Jump to latest)',
	},
	chatBubbleLeftEllipsis: {
		svg: { viewBox: '0 0 16 16', width: '16', height: '16', fill: 'currentColor', 'aria-hidden': 'true' },
		shapes: [
			path({
				'fill-rule': 'evenodd',
				d: 'M1 8.74c0 .983.713 1.825 1.69 1.943.764.092 1.534.164 2.31.216v2.351a.75.75 0 0 0 1.28.53l2.51-2.51c.182-.181.427-.286.684-.294a44.298 44.298 0 0 0 3.837-.293C14.287 10.565 15 9.723 15 8.74V4.26c0-.983-.713-1.825-1.69-1.943a44.447 44.447 0 0 0-10.62 0C1.712 2.435 1 3.277 1 4.26v4.482ZM5.5 6.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm2.5 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm3.5 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
				'clip-rule': 'evenodd',
			}),
		],
		source: heroicon('Chat Bubble Left Ellipsis', 'chat-bubble-left-ellipsis', HEROICONS_V2_2),
		usedBy: 'PassageComments (Document Review passage conversation)',
	},
	folder: {
		svg: { class: 'group-icon', viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
		shapes: [
			path({
				d: 'M2 3.5A1.5 1.5 0 0 1 3.5 2h2.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H12.5A1.5 1.5 0 0 1 14 5.5v1.401a2.986 2.986 0 0 0-1.5-.401h-9c-.546 0-1.059.146-1.5.401V3.5ZM2 9.5v3A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3A1.5 1.5 0 0 0 12.5 8h-9A1.5 1.5 0 0 0 2 9.5Z',
			}),
		],
		source: heroicon('Folder', 'folder', HEROICONS_STRIP),
		usedBy: 'terminal-workspace.ts (terminal group headers)',
	},
	backgroundStack: {
		svg: {
			class: 'background-icon',
			width: '16',
			height: '16',
			viewBox: '0 0 16 16',
			fill: 'currentColor',
			'aria-hidden': 'true',
		},
		shapes: [
			path({
				d: 'M7 1a.75.75 0 0 1 .75.75V6h-1.5V1.75A.75.75 0 0 1 7 1ZM6.25 6v2.94L5.03 7.72a.75.75 0 0 0-1.06 1.06l2.5 2.5a.75.75 0 0 0 1.06 0l2.5-2.5a.75.75 0 1 0-1.06-1.06L7.75 8.94V6H10a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.25Z',
			}),
			path({ d: 'M4.268 14A2 2 0 0 0 6 15h6a2 2 0 0 0 2-2v-3a2 2 0 0 0-1-1.732V11a3 3 0 0 1-3 3H4.268Z' }),
		],
		source: heroicon('Arrow Down on Square Stack', 'arrow-down-on-square-stack', HEROICONS_STRIP),
		usedBy: 'index.html #bg-toggle (static copy) and the terminal-workspace fixtures',
	},
	sidebarToggle: {
		svg: {
			width: '16',
			height: '16',
			viewBox: '0 0 20 20',
			fill: 'none',
			stroke: 'currentColor',
			'stroke-width': '1.5',
			'aria-hidden': 'true',
		},
		shapes: [
			{ tag: 'rect', attributes: { x: '3', y: '4', width: '14', height: '12', rx: '2' } },
			path({ d: 'M8 4v12' }),
		],
		source: HAND_DRAWN,
		usedBy: 'sidebar-layout.ts (#sidebar-toggle in the topbar)',
	},
} satisfies Record<string, IconData>

export type IconName = keyof typeof ICONS

/** A production icon that cannot live in this module, with its reason. tests/design-icons.test.ts allows exactly these. */
export interface IconOutsideModule {
	readonly file: string
	readonly what: string
	readonly source: IconSource
	readonly reason: string
}

export const ICONS_OUTSIDE_MODULE: readonly IconOutsideModule[] = [
	{
		file: 'app/src/renderer/index.html',
		what: 'Background terminals toggle (#bg-toggle)',
		source: ICONS.backgroundStack.source,
		reason: 'static first-paint HTML; its path data is held equal to `backgroundStack`',
	},
	{
		file: 'app/src/renderer/sidebar/sidebar.css',
		what: 'select chevron (`.select` background-image data URI, §3.7)',
		source: HAND_DRAWN,
		reason: 'a CSS data URI, not a DOM element',
	},
	{
		file: 'extension/src/Widget.tsx',
		what: 'model picker chevron (10×6) and check (10×8)',
		source: HAND_DRAWN,
		reason: 'the extension is SolidJS and keeps its own icons (decision D1)',
	},
	{
		file: 'app/assets/remote/command-line.svg',
		what: 'Helm Remote PWA launcher',
		source: heroicon('Command Line', 'command-line', HEROICONS_V2_2),
		reason: 'an asset file rendered to PNGs by app/scripts/write-remote-icons.mjs',
	},
]

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The DOM form of an icon: the same element the React form renders, built with createElementNS. */
export function iconNode(icon: IconData, doc: Document = document): SVGSVGElement {
	const svg = doc.createElementNS(SVG_NS, 'svg')
	for (const [name, value] of Object.entries(icon.svg)) svg.setAttribute(name, value)
	for (const shape of icon.shapes) {
		const node = doc.createElementNS(SVG_NS, shape.tag)
		for (const [name, value] of Object.entries(shape.attributes)) node.setAttribute(name, value)
		svg.append(node)
	}
	return svg
}
