import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * An agent row's detail (§3.25, Jakub's pick 2026-11-18): a click on an ask or an answer (or ↵)
 * opens it as a slide-over out of the column over the terminals; the column keeps its width, so no
 * terminal refits. A second click, ↵ again or Esc closes it. It shows the whole body (13/20, line
 * breaks kept), who filed it and the agent in the terminal it came from (dock name, state, project,
 * branch), its links (click or 1–9 opens one through main), and for an ask its quick answers (1–9 when
 * it has any) and an answer field (⌘↵ sends; saved first, typed into the agent when the dock can).
 * j/k keep moving the list; the panel follows. Opened from Done today it shows in place of that list.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Detail',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'detail' },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** The dispatcher's ask with quick answers, in the panel over the terminals. */
export const Ask: Story = { name: 'Ask', args: { detail: 505 } }

/** An answer: no answer field; its Done button (or `d` from the list) closes it once read. */
export const Answer: Story = { name: 'Answer', args: { detail: 601 } }

/** A long ask from a terminal the dock does not list: the body scrolls, the answer is saved on the thread. */
export const LongBody: Story = { name: 'Long body', args: { detail: 506 } }

/** Nothing open: click an agent row (or ↵ on one). */
export const ClickARow: Story = { name: 'Click a row', args: {} }
