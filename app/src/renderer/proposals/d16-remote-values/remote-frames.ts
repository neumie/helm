// Phone frames of the real Helm Remote stories (390×760 → the max-width 799px phone layout) for the D16 proposals.
// Each setup opens one surface the way a person would. Nothing here is imported by production code.
import { type FrameSpec, click, waitFor } from './frame'

const PHONE = { width: 390, height: 760 } as const

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** The frame's own constructors (an event built in the parent realm still dispatches, but React reads the frame's). */
type FrameRealm = Window & {
	HTMLTextAreaElement: typeof HTMLTextAreaElement
	Event: typeof Event
	MouseEvent: typeof MouseEvent
}
const realm = (win: Window) => win as FrameRealm

/** The Reading story opens its conversation on its own; wait until it has, then let it settle. */
async function conversationOpen(doc: Document): Promise<void> {
	await waitFor(() => doc.querySelector('.remote-user-text'), 'opened conversation')
	await sleep(600)
}

/** Types a draft into the composer the way React sees typing, so Send turns primary (white today). */
async function typeDraft(doc: Document, win: Window, text: string): Promise<void> {
	const field = await waitFor(
		() => doc.querySelector<HTMLTextAreaElement>('.remote-compose-surface textarea'),
		'composer textarea',
	)
	const setter = Object.getOwnPropertyDescriptor(realm(win).HTMLTextAreaElement.prototype, 'value')?.set
	setter?.call(field, text)
	field.dispatchEvent(new (realm(win).Event)('input', { bubbles: true }))
	await waitFor(() => doc.querySelector('.remote-send.btn-primary'), 'primary Send')
	await sleep(200)
}

/** Whole phone: a draft in the capsule, Send at rest. */
export const SEND_PHONE: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'Konverzace · rozepsaná zpráva',
	...PHONE,
	setup: async ({ doc, win }) => {
		await conversationOpen(doc)
		await typeDraft(doc, win, 'Ship it.')
	},
}

/** The capsule cropped and magnified: Send at rest. */
export const SEND_REST: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'Kapsle · Send v klidu',
	...PHONE,
	zoom: 2,
	crop: { selector: '.remote-compose-surface', pad: 8 },
	setup: SEND_PHONE.setup,
}

/** The same crop with Send held in hover. */
export const SEND_HOVER: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'Kapsle · Send v hover',
	...PHONE,
	zoom: 2,
	crop: { selector: '.remote-compose-surface', pad: 8 },
	setup: async context => {
		await SEND_PHONE.setup?.(context)
		const send = await waitFor(() => context.doc.querySelector<HTMLElement>('.remote-send'), 'Send')
		send.dataset.forceState = 'hover'
	},
}

/** The capsule with an empty draft: Send is the quiet grey circle, the same in every variant. */
export const SEND_EMPTY: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'Kapsle · prázdná (Send tichý, beze změny)',
	...PHONE,
	zoom: 2,
	crop: { selector: '.remote-compose-surface', pad: 8 },
	setup: async ({ doc }) => conversationOpen(doc),
}

export const DELIVERY_MENU: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'Menu doručení',
	...PHONE,
	zoom: 1.5,
	crop: { selector: '.remote-composer-actions .menu-panel', pad: 56 },
	setup: async ({ doc }) => {
		await conversationOpen(doc)
		await click(doc, '.remote-mode-trigger')
	},
}

export const ROW_MENU: FrameSpec = {
	id: 'views-helm-remote--favorites',
	label: 'Menu řádku (Pin, podržení)',
	...PHONE,
	zoom: 1.5,
	crop: { selector: '.remote-row-menu', pad: 40 },
	setup: async ({ doc, win }) => {
		const entry = await waitFor(() => doc.querySelector<HTMLElement>('.remote-session-entry'), 'session row')
		entry.dispatchEvent(new (realm(win).MouseEvent)('contextmenu', { bubbles: true, cancelable: true }))
		await waitFor(() => doc.querySelector('.remote-row-menu'), 'row menu')
		await sleep(300)
	},
}

export const MORE_SHEET: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'More · sheet + scrim',
	...PHONE,
	setup: async ({ doc }) => {
		await conversationOpen(doc)
		await click(doc, '.remote-add-images')
		await sleep(300)
	},
}

export const NAVIGATION: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'Navigace · drawer + scrim',
	...PHONE,
	setup: async ({ doc }) => {
		await conversationOpen(doc)
		await click(doc, '.remote-navigation-trigger')
		await sleep(300)
	},
}

/** The More sheet's top edge cropped and magnified, where its shadow meets the scrim. */
export const SHEET_EDGE: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'More · horní okraj sheetu',
	...PHONE,
	zoom: 1.5,
	// Wide enough to hold the shadow beside the sheet (its blur reaches 30-60 px out).
	crop: { selector: '.remote-sheet', pad: 32 },
	setup: MORE_SHEET.setup,
}

/** The drawer's right edge cropped and magnified (around its Sessions row), where its sideways shadow falls. */
export const DRAWER_EDGE: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'Navigace · pravý okraj draweru',
	...PHONE,
	zoom: 2,
	crop: { selector: '.remote-navigation-items .remote-navigation-item', pad: 56 },
	setup: NAVIGATION.setup,
}

/** The app's own sheet over the sidebar (uses --scrim), for comparing the two scrims side by side. */
export const APP_SHEET: FrameSpec = {
	id: 'compositions-menu-and-navigation--finish-item-setup-sheet',
	label: 'Aplikace · sheet Finish setup (--scrim)',
	width: 390,
	height: 760,
	// The sheet focuses its first field a moment after mount; wait for that, so the frame then gives the page's
	// focus back and no variant shows a focus ring the others lack.
	setup: async ({ doc }) => {
		await waitFor(() => doc.querySelector('select, input'), 'sheet field')
		await sleep(800)
	},
}
