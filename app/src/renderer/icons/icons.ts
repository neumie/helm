// Helm's icon module (docs/design-system.md §3.1 Icons, §9 rulings 54 and 95): the geometry of every production
// icon in the desktop renderer, with its source. Each entry is the exact SVG a production site renders: the same
// path data, viewBox, size, fill/stroke, class and aria attributes, in the same attribute order. Two forms come
// from one entry: `iconNode` (createElementNS, for the plain-DOM terminal workspace) here, and
// `iconElement`/`Icon`/`GLYPH` (React) in ./Icon.tsx. Storybook: Primitives/Icons. Check: tests/design-icons.test.ts.
//
// One set (§9 ruling 95): Heroicons v2.2.0 24px outline, path geometry copied unchanged from
// https://github.com/tailwindlabs/heroicons/tree/v2.2.0/src/24/outline, drawn with stroke width 2 (not the
// published 1.5) at the size each site had before the switch (14px, 13px plan, 12px chevrons/external/copy, 16px
// strip, Remote and Review controls). Only the stroke colour is bound to currentColor. MIT, Tailwind Labs; every
// entry is listed in THIRD_PARTY_NOTICES.md.
//
// Adding an icon: reuse an entry first; otherwise copy the Heroicons 24 outline file's path data unchanged through
// `outline(...)` at the size of its slot and list it in THIRD_PARTY_NOTICES.md. Never draw one by hand, never mix
// in the solid or micro styles.
//
// Icons that are NOT in this module, and why (`ICONS_OUTSIDE_MODULE` below holds the same list for the test and
// the story):
// - app/src/renderer/index.html: the Background terminals toggle's static first-paint markup. It is a copy of
//   `backgroundStack`; tests/design-icons.test.ts holds it equal to this module's entry.
// - app/src/renderer/sidebar/sidebar.css `.select`: the select chevron as a CSS data URI (§3.7), the outline
//   Chevron Down at stroke 2 in a 14px box.
// - extension/src/Widget.tsx `ModelSelect`: the outline Chevron Down and Check of the widget's model picker, stroke
//   2 in a 14px box. The extension is SolidJS and keeps its own icons (decision D1).
// - app/assets/remote/command-line.svg: the Helm Remote PWA launcher source (Heroicons Command Line, 16 solid),
//   rendered to the home-screen PNGs by app/scripts/write-remote-icons.mjs. An app icon asset, not a UI glyph, so
//   it keeps its solid style (§9 ruling 95).
// Prototypes (app/src/renderer/open-prototype/), proposals (app/src/renderer/proposals/) and Storybook fixtures
// are not production and may draw their own.

/** SVG attributes in DOM spelling (`stroke-width`, `aria-hidden`, `class`), in the order the element gets them. */
export type IconAttributes = Readonly<Record<string, string>>

export interface IconShape {
	readonly tag: 'path' | 'circle' | 'rect'
	readonly attributes: IconAttributes
}

export interface IconSource {
	readonly kind: 'heroicons'
	/** The Heroicons name as heroicons.com and THIRD_PARTY_NOTICES.md spell it. */
	readonly name: string
	/** `24 outline` for every UI glyph; `16 solid` only for the PWA launcher asset (§9 ruling 95). */
	readonly style: '24 outline' | '16 solid'
	/** Upstream tag the geometry was copied from. */
	readonly revision: string
	readonly url: string
	readonly license: 'MIT'
}

export interface IconData {
	readonly svg: IconAttributes
	readonly shapes: readonly IconShape[]
	readonly source: IconSource
	/** Where production renders it. */
	readonly usedBy: string
}

/** Heroicons release the geometry is copied from. */
export const HEROICONS_REVISION = 'v2.2.0'
/** The stroke width Helm draws the 24px outline set with (Heroicons publish 1.5; §9 ruling 95). */
export const ICON_STROKE_WIDTH = '2'

const outlineSource = (name: string, file: string): IconSource => ({
	kind: 'heroicons',
	name,
	style: '24 outline',
	revision: HEROICONS_REVISION,
	url: `https://github.com/tailwindlabs/heroicons/blob/${HEROICONS_REVISION}/src/24/outline/${file}.svg`,
	license: 'MIT',
})

const path = (attributes: IconAttributes): IconShape => ({ tag: 'path', attributes })

/** A Heroicons 24 outline icon: its path data unchanged, stroke 2 in currentColor, drawn at `size` px. `svg`
 * leads with extra root attributes (a class, or no width/height when CSS sizes the icon). */
function outline(
	name: string,
	file: string,
	d: string | readonly string[],
	usedBy: string,
	size: number | null = 14,
	lead: IconAttributes = {},
): IconData {
	return {
		svg: {
			...lead,
			...(size === null ? {} : { width: String(size), height: String(size) }),
			viewBox: '0 0 24 24',
			fill: 'none',
			stroke: 'currentColor',
			'stroke-width': ICON_STROKE_WIDTH,
			'aria-hidden': 'true',
		},
		shapes: (typeof d === 'string' ? [d] : d).map(value =>
			path({ d: value, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
		),
		source: outlineSource(name, file),
		usedBy,
	}
}

const SIDEBAR = 'GLYPH (sidebar, Document Review, Remote)'

export const ICONS = {
	plus: outline('Plus', 'plus', 'M12 4.5V19.5M19.5 12L4.5 12', SIDEBAR),
	menu: outline(
		'Bars 2',
		'bars-2',
		'M3.75 9H20.25M3.75 15.75H20.25',
		'GLYPH.menu (Remote navigation drawer, Document Review contents)',
		16,
	),
	back: outline('Chevron Left', 'chevron-left', 'M15.75 19.5L8.25 12L15.75 4.5', SIDEBAR),
	chevronRight: outline('Chevron Right', 'chevron-right', 'M8.25 4.5L15.75 12L8.25 19.5', SIDEBAR, 12),
	chevronDown: outline('Chevron Down', 'chevron-down', 'M19.5 8.25L12 15.75L4.5 8.25', SIDEBAR, 12),
	ellipsis: outline(
		'Ellipsis Horizontal',
		'ellipsis-horizontal',
		[
			'M6.75 12C6.75 12.4142 6.41421 12.75 6 12.75C5.58579 12.75 5.25 12.4142 5.25 12C5.25 11.5858 5.58579 11.25 6 11.25C6.41421 11.25 6.75 11.5858 6.75 12Z',
			'M12.75 12C12.75 12.4142 12.4142 12.75 12 12.75C11.5858 12.75 11.25 12.4142 11.25 12C11.25 11.5858 11.5858 11.25 12 11.25C12.4142 11.25 12.75 11.5858 12.75 12Z',
			'M18.75 12C18.75 12.4142 18.4142 12.75 18 12.75C17.5858 12.75 17.25 12.4142 17.25 12C17.25 11.5858 17.5858 11.25 18 11.25C18.4142 11.25 18.75 11.5858 18.75 12Z',
		],
		SIDEBAR,
	),
	external: outline(
		'Arrow Top Right on Square',
		'arrow-top-right-on-square',
		'M13.5 6H5.25C4.00736 6 3 7.00736 3 8.25V18.75C3 19.9926 4.00736 21 5.25 21H15.75C16.9926 21 18 19.9926 18 18.75V10.5M7.5 16.5L21 3M21 3L15.75 3M21 3V8.25',
		SIDEBAR,
		12,
	),
	copy: outline(
		'Square 2 Stack',
		'square-2-stack',
		'M16.5 8.25V6C16.5 4.75736 15.4926 3.75 14.25 3.75H6C4.75736 3.75 3.75 4.75736 3.75 6V14.25C3.75 15.4926 4.75736 16.5 6 16.5H8.25M16.5 8.25H18C19.2426 8.25 20.25 9.25736 20.25 10.5V18C20.25 19.2426 19.2426 20.25 18 20.25H10.5C9.25736 20.25 8.25 19.2426 8.25 18V16.5M16.5 8.25H10.5C9.25736 8.25 8.25 9.25736 8.25 10.5V16.5',
		SIDEBAR,
		12,
	),
	check: outline('Check', 'check', 'M4.5 12.75L10.5 18.75L19.5 5.25', SIDEBAR),
	agent: outline(
		'CPU Chip',
		'cpu-chip',
		'M8.25 3V4.5M4.5 8.25H3M21 8.25H19.5M4.5 12H3M21 12H19.5M4.5 15.75H3M21 15.75H19.5M8.25 19.5V21M12 3V4.5M12 19.5V21M15.75 3V4.5M15.75 19.5V21M6.75 19.5H17.25C18.4926 19.5 19.5 18.4926 19.5 17.25V6.75C19.5 5.50736 18.4926 4.5 17.25 4.5H6.75C5.50736 4.5 4.5 5.50736 4.5 6.75V17.25C4.5 18.4926 5.50736 19.5 6.75 19.5ZM7.5 7.5H16.5V16.5H7.5V7.5Z',
		SIDEBAR,
	),
	manual: outline(
		'User',
		'user',
		[
			'M15.75 6C15.75 8.07107 14.071 9.75 12 9.75C9.9289 9.75 8.24996 8.07107 8.24996 6C8.24996 3.92893 9.9289 2.25 12 2.25C14.071 2.25 15.75 3.92893 15.75 6Z',
			'M4.5011 20.1182C4.5714 16.0369 7.90184 12.75 12 12.75C16.0982 12.75 19.4287 16.0371 19.4988 20.1185C17.216 21.166 14.6764 21.75 12.0003 21.75C9.32396 21.75 6.78406 21.1659 4.5011 20.1182Z',
		],
		SIDEBAR,
	),
	play: outline(
		'Play',
		'play',
		'M5.25 5.65273C5.25 4.79705 6.1674 4.25462 6.91716 4.66698L18.4577 11.0143C19.2349 11.4417 19.2349 12.5584 18.4577 12.9858L6.91716 19.3331C6.1674 19.7455 5.25 19.203 5.25 18.3474V5.65273Z',
		SIDEBAR,
	),
	queue: outline(
		'Arrow Down Tray',
		'arrow-down-tray',
		'M3 16.5V18.75C3 19.9926 4.00736 21 5.25 21H18.75C19.9926 21 21 19.9926 21 18.75V16.5M16.5 12L12 16.5M12 16.5L7.5 12M12 16.5V3',
		SIDEBAR,
	),
	retry: outline(
		'Arrow Path',
		'arrow-path',
		'M16.0228 9.34841H21.0154V9.34663M2.98413 19.6444V14.6517M2.98413 14.6517L7.97677 14.6517M2.98413 14.6517L6.16502 17.8347C7.15555 18.8271 8.41261 19.58 9.86436 19.969C14.2654 21.1483 18.7892 18.5364 19.9685 14.1353M4.03073 9.86484C5.21 5.46374 9.73377 2.85194 14.1349 4.03121C15.5866 4.4202 16.8437 5.17312 17.8342 6.1655L21.0154 9.34663M21.0154 4.3558V9.34663',
		SIDEBAR,
	),
	stop: outline(
		'Stop',
		'stop',
		'M5.25 7.5C5.25 6.25736 6.25736 5.25 7.5 5.25H16.5C17.7426 5.25 18.75 6.25736 18.75 7.5V16.5C18.75 17.7426 17.7426 18.75 16.5 18.75H7.5C6.25736 18.75 5.25 17.7426 5.25 16.5V7.5Z',
		SIDEBAR,
	),
	pause: outline('Pause', 'pause', 'M15.75 5.25L15.75 18.75M8.25 5.25V18.75', SIDEBAR),
	return: outline(
		'Arrow Uturn Left',
		'arrow-uturn-left',
		'M9 15L3 9M3 9L9 3M3 9H15C18.3137 9 21 11.6863 21 15C21 18.3137 18.3137 21 15 21H12',
		SIDEBAR,
	),
	plan: outline(
		'Document Text',
		'document-text',
		'M19.5 14.25V11.625C19.5 9.76104 17.989 8.25 16.125 8.25H14.625C14.0037 8.25 13.5 7.74632 13.5 7.125V5.625C13.5 3.76104 11.989 2.25 10.125 2.25H8.25M8.25 15H15.75M8.25 18H12M10.5 2.25H5.625C5.00368 2.25 4.5 2.75368 4.5 3.375V20.625C4.5 21.2463 5.00368 21.75 5.625 21.75H18.375C18.9963 21.75 19.5 21.2463 19.5 20.625V11.25C19.5 6.27944 15.4706 2.25 10.5 2.25Z',
		SIDEBAR,
		13,
	),
	archive: outline(
		'Archive Box',
		'archive-box',
		'M20.25 7.5L19.6246 18.1321C19.5546 19.3214 18.5698 20.25 17.3785 20.25H6.62154C5.43022 20.25 4.44538 19.3214 4.37542 18.1321L3.75 7.5M9.99976 11.25H13.9998M3.375 7.5H20.625C21.2463 7.5 21.75 6.99632 21.75 6.375V4.875C21.75 4.25368 21.2463 3.75 20.625 3.75H3.375C2.75368 3.75 2.25 4.25368 2.25 4.875V6.375C2.25 6.99632 2.75368 7.5 3.375 7.5Z',
		SIDEBAR,
	),
	calendar: outline(
		'Calendar Days',
		'calendar-days',
		'M6.75 3V5.25M17.25 3V5.25M3 18.75V7.5C3 6.25736 4.00736 5.25 5.25 5.25H18.75C19.9926 5.25 21 6.25736 21 7.5V18.75M3 18.75C3 19.9926 4.00736 21 5.25 21H18.75C19.9926 21 21 19.9926 21 18.75M3 18.75V11.25C3 10.0074 4.00736 9 5.25 9H18.75C19.9926 9 21 10.0074 21 11.25V18.75M12 12.75H12.0075V12.7575H12V12.75ZM12 15H12.0075V15.0075H12V15ZM12 17.25H12.0075V17.2575H12V17.25ZM9.75 15H9.7575V15.0075H9.75V15ZM9.75 17.25H9.7575V17.2575H9.75V17.25ZM7.5 15H7.5075V15.0075H7.5V15ZM7.5 17.25H7.5075V17.2575H7.5V17.25ZM14.25 12.75H14.2575V12.7575H14.25V12.75ZM14.25 15H14.2575V15.0075H14.25V15ZM14.25 17.25H14.2575V17.2575H14.25V17.25ZM16.5 12.75H16.5075V12.7575H16.5V12.75ZM16.5 15H16.5075V15.0075H16.5V15Z',
		'GLYPH.calendar (Scheduled runs)',
	),
	settings: outline(
		'Cog 6 Tooth',
		'cog-6-tooth',
		[
			'M9.59356 3.94014C9.68397 3.39768 10.1533 3.00009 10.7033 3.00009H13.2972C13.8472 3.00009 14.3165 3.39768 14.4069 3.94014L14.6204 5.22119C14.6828 5.59523 14.9327 5.9068 15.2645 6.09045C15.3387 6.13151 15.412 6.17393 15.4844 6.21766C15.8095 6.41393 16.2048 6.47495 16.5604 6.34175L17.7772 5.88587C18.2922 5.69293 18.8712 5.9006 19.1462 6.37687L20.4432 8.6233C20.7181 9.09957 20.6085 9.70482 20.1839 10.0544L19.1795 10.8812C18.887 11.122 18.742 11.4938 18.7491 11.8726C18.7498 11.915 18.7502 11.9575 18.7502 12.0001C18.7502 12.0427 18.7498 12.0852 18.7491 12.1275C18.742 12.5064 18.887 12.8782 19.1795 13.119L20.1839 13.9458C20.6085 14.2953 20.7181 14.9006 20.4432 15.3769L19.1462 17.6233C18.8712 18.0996 18.2922 18.3072 17.7772 18.1143L16.5604 17.6584C16.2048 17.5252 15.8095 17.5862 15.4844 17.7825C15.412 17.8263 15.3387 17.8687 15.2645 17.9097C14.9327 18.0934 14.6828 18.4049 14.6204 18.779L14.4069 20.06C14.3165 20.6025 13.8472 21.0001 13.2972 21.0001H10.7033C10.1533 21.0001 9.68397 20.6025 9.59356 20.06L9.38005 18.779C9.31771 18.4049 9.06774 18.0934 8.73597 17.9097C8.66179 17.8687 8.58847 17.8263 8.51604 17.7825C8.19101 17.5863 7.79568 17.5252 7.44011 17.6584L6.22325 18.1143C5.70826 18.3072 5.12926 18.0996 4.85429 17.6233L3.55731 15.3769C3.28234 14.9006 3.39199 14.2954 3.81657 13.9458L4.82092 13.119C5.11343 12.8782 5.25843 12.5064 5.25141 12.1276C5.25063 12.0852 5.25023 12.0427 5.25023 12.0001C5.25023 11.9575 5.25063 11.915 5.25141 11.8726C5.25843 11.4938 5.11343 11.122 4.82092 10.8812L3.81657 10.0544C3.39199 9.70484 3.28234 9.09958 3.55731 8.62332L4.85429 6.37688C5.12926 5.90061 5.70825 5.69295 6.22325 5.88588L7.4401 6.34176C7.79566 6.47496 8.19099 6.41394 8.51603 6.21767C8.58846 6.17393 8.66179 6.13151 8.73597 6.09045C9.06774 5.9068 9.31771 5.59523 9.38005 5.22119L9.59356 3.94014Z',
			'M15 12C15 13.6569 13.6569 15 12 15C10.3431 15 9 13.6569 9 12C9 10.3432 10.3431 9.00001 12 9.00001C13.6569 9.00001 15 10.3432 15 12Z',
		],
		SIDEBAR,
	),
	close: outline('X Mark', 'x-mark', 'M6 18L18 6M6 6L18 18', SIDEBAR),
	arrowUp: outline(
		'Arrow Up',
		'arrow-up',
		'M4.5 10.5L12 3M12 3L19.5 10.5M12 3V21',
		'RemoteArrow (Remote composer send, Earlier messages)',
		16,
	),
	arrowDown: outline(
		'Arrow Down',
		'arrow-down',
		'M19.5 13.5L12 21M12 21L4.5 13.5M12 21L12 3',
		'RemoteArrow (Remote Jump to latest)',
		16,
	),
	chatBubbleLeftEllipsis: outline(
		'Chat Bubble Left Ellipsis',
		'chat-bubble-left-ellipsis',
		'M8.625 9.75C8.625 9.95711 8.45711 10.125 8.25 10.125C8.04289 10.125 7.875 9.95711 7.875 9.75C7.875 9.54289 8.04289 9.375 8.25 9.375C8.45711 9.375 8.625 9.54289 8.625 9.75ZM8.625 9.75H8.25M12.375 9.75C12.375 9.95711 12.2071 10.125 12 10.125C11.7929 10.125 11.625 9.95711 11.625 9.75C11.625 9.54289 11.7929 9.375 12 9.375C12.2071 9.375 12.375 9.54289 12.375 9.75ZM12.375 9.75H12M16.125 9.75C16.125 9.95711 15.9571 10.125 15.75 10.125C15.5429 10.125 15.375 9.95711 15.375 9.75C15.375 9.54289 15.5429 9.375 15.75 9.375C15.9571 9.375 16.125 9.54289 16.125 9.75ZM16.125 9.75H15.75M2.25 12.7593C2.25 14.3604 3.37341 15.754 4.95746 15.987C6.04357 16.1467 7.14151 16.27 8.25 16.3556V21L12.4335 16.8165C12.6402 16.6098 12.9193 16.4923 13.2116 16.485C15.1872 16.4361 17.1331 16.2678 19.0425 15.9871C20.6266 15.7542 21.75 14.3606 21.75 12.7595V6.74056C21.75 5.13946 20.6266 3.74583 19.0425 3.51293C16.744 3.17501 14.3926 3 12.0003 3C9.60776 3 7.25612 3.17504 4.95747 3.51302C3.37342 3.74593 2.25 5.13956 2.25 6.74064V12.7593Z',
		'PassageComments (Document Review passage conversation)',
		16,
	),
	folder: outline(
		'Folder',
		'folder',
		'M2.25 12.75V12C2.25 10.7574 3.25736 9.75 4.5 9.75H19.5C20.7426 9.75 21.75 10.7574 21.75 12V12.75M13.0607 6.31066L10.9393 4.18934C10.658 3.90804 10.2765 3.75 9.87868 3.75H4.5C3.25736 3.75 2.25 4.75736 2.25 6V18C2.25 19.2426 3.25736 20.25 4.5 20.25H19.5C20.7426 20.25 21.75 19.2426 21.75 18V9C21.75 7.75736 20.7426 6.75 19.5 6.75H14.1213C13.7235 6.75 13.342 6.59197 13.0607 6.31066Z',
		'terminal-workspace.ts (terminal group headers)',
		null,
		{ class: 'group-icon' },
	),
	backgroundStack: outline(
		'Arrow Down on Square Stack',
		'arrow-down-on-square-stack',
		'M7.5 7.5H6.75C5.50736 7.5 4.5 8.50736 4.5 9.75V17.25C4.5 18.4926 5.50736 19.5 6.75 19.5H14.25C15.4926 19.5 16.5 18.4926 16.5 17.25V9.75C16.5 8.50736 15.4926 7.5 14.25 7.5H13.5M7.5 11.25L10.5 14.25M10.5 14.25L13.5 11.25M10.5 14.25L10.5 1.5M16.5 10.5H17.25C18.4926 10.5 19.5 11.5074 19.5 12.75V20.25C19.5 21.4926 18.4926 22.5 17.25 22.5H9.75C8.50736 22.5 7.5 21.4926 7.5 20.25V19.5',
		'index.html #bg-toggle (static copy) and the terminal-workspace fixtures',
		16,
		{ class: 'background-icon' },
	),
	sidebarToggle: outline(
		'View Columns',
		'view-columns',
		'M9 4.5V19.5M15 4.5V19.5M4.125 19.5H19.875C20.4963 19.5 21 18.9963 21 18.375V5.625C21 5.00368 20.4963 4.5 19.875 4.5H4.125C3.50368 4.5 3 5.00368 3 5.625V18.375C3 18.9963 3.50368 19.5 4.125 19.5Z',
		'sidebar-layout.ts (#sidebar-toggle in the topbar)',
		16,
	),
} satisfies Record<string, IconData>

export type IconName = keyof typeof ICONS

/** A production icon that cannot live in this module, with its reason. tests/design-icons.test.ts allows exactly these. */
export interface IconOutsideModule {
	readonly file: string
	readonly what: string
	readonly source: IconSource | readonly IconSource[]
	readonly reason: string
}

/** The outline Chevron Down and Check the extension and the `.select` data URI copy (path data, for the test). */
export const OUTSIDE_GEOMETRY = {
	chevronDown: 'M19.5 8.25L12 15.75L4.5 8.25',
	check: 'M4.5 12.75L10.5 18.75L19.5 5.25',
} as const

export const ICONS_OUTSIDE_MODULE: readonly IconOutsideModule[] = [
	{
		file: 'app/src/renderer/index.html',
		what: 'Background terminals toggle (#bg-toggle)',
		source: ICONS.backgroundStack.source,
		reason: 'static first-paint HTML; held equal to `backgroundStack`',
	},
	{
		file: 'app/src/renderer/sidebar/sidebar.css',
		what: 'select chevron (`.select` background-image data URI, §3.7), 14px box',
		source: outlineSource('Chevron Down', 'chevron-down'),
		reason: 'a CSS data URI, not a DOM element',
	},
	{
		file: 'extension/src/Widget.tsx',
		what: 'model picker chevron and check, 14px box',
		source: [outlineSource('Chevron Down', 'chevron-down'), outlineSource('Check', 'check')],
		reason: 'the extension is SolidJS and keeps its own icons (decision D1)',
	},
	{
		file: 'app/assets/remote/command-line.svg',
		what: 'Helm Remote PWA launcher',
		source: {
			kind: 'heroicons',
			name: 'Command Line',
			style: '16 solid',
			revision: HEROICONS_REVISION,
			url: `https://github.com/tailwindlabs/heroicons/blob/${HEROICONS_REVISION}/optimized/16/solid/command-line.svg`,
			license: 'MIT',
		},
		reason:
			'a home-screen icon asset rendered to PNGs by app/scripts/write-remote-icons.mjs; keeps its solid style (§9 ruling 95)',
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
