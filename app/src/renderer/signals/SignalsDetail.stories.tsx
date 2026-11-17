import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * An agent row's detail (§3.25): a click on an ask or an answer (or ↵) opens it, a second click or
 * Esc closes it. It shows the whole body (13/20, line breaks kept), who filed it and the agent in the
 * terminal it came from (dock name, state, project, branch), its links (click or 1–9 opens one through
 * main), and for an ask its quick answers (1–9 when it has any) and an answer field (⌘↵ sends; saved
 * first, typed into the agent when the dock can). j/k keep moving the list; the panel follows.
 *
 * Where it opens is Jakub's pick (review only, `detailLayout`):
 *
 * - **1 Slide-over**: a panel out of the column over the terminals; the column keeps its width, so
 *   no terminal refits.
 * - **2 Split**: the lower part of the column, under the list.
 * - **3 In place**: in place of the list, like the other flows.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Detail',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'detail' },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** 1: the dispatcher's ask with quick answers, in a panel over the terminals. */
export const SlideOver: Story = { name: '1 Slide-over', args: { detailLayout: 'slide-over', detail: 505 } }

/** 2: the same ask in the lower part of the column; j/k move the list above and the panel follows. */
export const Split: Story = { name: '2 Split', args: { detailLayout: 'split', detail: 505 } }

/** 3: the same ask in place of the list. */
export const InPlace: Story = { name: '3 In place', args: { detailLayout: 'in-place', detail: 505 } }

/** An answer: no answer field, `d` or Done closes it once read. */
export const Answer: Story = { name: 'Answer', args: { detailLayout: 'slide-over', detail: 601 } }

/** A long ask from a terminal the dock does not list: the body scrolls, the answer is saved on the thread. */
export const LongBody: Story = { name: 'Long body', args: { detailLayout: 'slide-over', detail: 506 } }

/** Nothing open: click an agent row (or ↵ on one) to try each layout. */
export const ClickARow: Story = { name: 'Click a row', args: { detailLayout: 'slide-over' } }
