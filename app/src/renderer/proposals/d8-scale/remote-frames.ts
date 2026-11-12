// Phone frames of the real Helm Remote stories (360×720 → the max-width 799px phone layout), shared by the D8
// Remote radii and Remote type proposals. Each setup opens one surface the way a person would.
import { type FrameSpec, click, waitFor } from './frame'

const PHONE = { width: 360, height: 720 } as const

/** The Reading story opens its conversation on its own; wait until it has, then let it settle. */
async function conversationOpen(doc: Document): Promise<void> {
	await waitFor(() => doc.querySelector('.remote-user-text'), 'opened conversation')
	await new Promise(resolve => setTimeout(resolve, 600))
}

export const REMOTE_READING: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'Konverzace · bublina, nadpis, kapsle',
	...PHONE,
}

export const REMOTE_DELIVERY_MENU: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'Menu doručení zprávy',
	...PHONE,
	setup: async ({ doc }) => {
		await conversationOpen(doc)
		await click(doc, '.remote-mode-trigger')
	},
}

/** The delivery menu cropped and magnified, its first item held in hover, so the 18 / 12 nesting is visible. */
export const REMOTE_DELIVERY_MENU_ITEM: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'Menu doručení · položka v hover',
	...PHONE,
	zoom: 2,
	crop: { selector: '.remote-composer-actions .menu-panel', pad: 12 },
	setup: async ({ doc }) => {
		await conversationOpen(doc)
		await click(doc, '.remote-mode-trigger')
		const item = await waitFor(
			() => doc.querySelector<HTMLElement>('.remote-composer-actions .menu-panel .menu-item'),
			'delivery menu item',
		)
		item.dataset.forceState = 'hover'
	},
}

export const REMOTE_MORE_SHEET: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'More · sheet',
	...PHONE,
	setup: async ({ doc }) => {
		await conversationOpen(doc)
		await click(doc, '.remote-add-images')
	},
}

export const REMOTE_NAVIGATION: FrameSpec = {
	id: 'views-helm-remote--reading',
	label: 'Navigace',
	...PHONE,
	setup: async ({ doc }) => {
		await conversationOpen(doc)
		await click(doc, '.remote-navigation-trigger')
	},
}

export const REMOTE_INFO: FrameSpec = {
	id: 'views-helm-remote--information',
	label: 'More → Info',
	...PHONE,
	setup: async ({ doc }) => {
		await click(doc, '.remote-session-row')
		await click(doc, '.remote-add-images')
		await click(doc, '.remote-sheet-option', 'Info')
	},
}

export const REMOTE_SESSIONS: FrameSpec = {
	id: 'views-helm-remote--terminal-metadata',
	label: 'Seznam konverzací',
	...PHONE,
}

/** The pairing form cropped and magnified: the code field's radius is the only thing that changes here. */
export const REMOTE_PAIRING: FrameSpec = {
	id: 'views-helm-remote--pairing-entry',
	label: 'Párování · pole kódu',
	...PHONE,
	zoom: 2,
	crop: { selector: '.remote-login form', pad: 12 },
}
