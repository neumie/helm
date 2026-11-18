import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsWorkspace } from './SignalsWorkspace'

/**
 * Agent answers (§3.25, Jakub's pick 2026-11-18): an informational reply an agent files with
 * `helm signal answer` when Jakub asked it something in its chat — the answer would be buried there.
 * Unlike an ask it waits on nothing: listed in Needs you, set apart only by the ↳ glyph in the accent,
 * never counted there and never lighting its warn mark; no `r`. `↵` reads it in full (the detail
 * panel), `o` opens its link, `d` closes it once read (Done today: `read`).
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Answers',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'answers' },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** Answers among Needs you, set apart only by ↳; the band count counts only what waits on Jakub. */
export const InNeedsYou: Story = { name: 'In Needs you', args: {} }

/** `↵` (or a click) on the dispatcher's answer: its detail, the whole answer; `d` or Done closes it. */
export const Read: Story = { name: 'Read an answer', args: { detail: 601 } }

/** Done today: an answer Jakub closed says `read`. */
export const DoneToday: Story = { name: 'Done today: read', args: { flow: 'done' } }
