import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * Agent answers (§3.25): an informational reply an agent files with `helm signal add --kind answer`
 * when Jakub asked it something in its chat — the answer would be buried there. Unlike an ask it waits
 * on nothing: glyph ↳ in the accent, no `r`, never counted in Needs you; `↵` reads it in full, `o`
 * opens its link, `d` closes it once read (Done today: `read`). Where answers live and what closes
 * them is Jakub's pick (review only, `answerLayout`):
 *
 * - **A Answers band**: their own band under Needs you; `d` closes.
 * - **B In Needs you**: listed among Needs you, set apart only by ↳ (and not counted there); `d` closes.
 * - **C Read in the list**: an Answers band whose rows show the body in place (six lines, then
 *   `… ↵ read all`); `d` closes.
 * - **D Reading closes it**: an Answers band; leaving the detail panel (`↵`, then esc) closes it as read.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Answers',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'answers' },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** A: answers on their own band under Needs you, with its own count; `↵` read, `d` done. */
export const AnswersBand: Story = { name: 'A Answers band', args: { answerLayout: 'section' } }

/** B: answers among Needs you, set apart only by the ↳ glyph; the band count still counts only what waits on Jakub. */
export const InNeedsYou: Story = { name: 'B In Needs you', args: { answerLayout: 'needs' } }

/** C: an Answers band whose rows show the answer in place (six lines, then `… ↵ read all`). */
export const ReadInTheList: Story = { name: 'C Read in the list', args: { answerLayout: 'inline' } }

/** D: an Answers band; reading it (`↵`) and going back (esc) closes it as read, no `d` needed. */
export const ReadingClosesIt: Story = { name: 'D Reading closes it', args: { answerLayout: 'read-closes' } }

/** `↵` (or a click) on the dispatcher's answer: its detail, the whole answer; `d` or Done closes it. */
export const Read: Story = { name: 'Read an answer', args: { answerLayout: 'section', detail: 601 } }

/** D's detail: the status line says going back closes it. */
export const ReadClosing: Story = { name: 'Read an answer (D)', args: { answerLayout: 'read-closes', detail: 601 } }

/** Done today: an answer Jakub closed says `read`. */
export const DoneToday: Story = { name: 'Done today: read', args: { answerLayout: 'section', flow: 'done' } }
