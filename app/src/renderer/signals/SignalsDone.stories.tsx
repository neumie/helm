import type { Meta, StoryObj } from '@storybook/react-vite'
import { SignalsColumnFrames, SignalsWorkspace } from './SignalsWorkspace'

/**
 * Done threads (§3.25): after the snoozed rows, one `Done today 8` line with the filtered mail
 * count after it (`· 5 filtered`). `D` (or a click on the count) opens **Done today** in place of
 * the list, built like Filtered mail (`f`): every thread done in the last 24 hours, each saying how
 * it got done after its ref (`okena#298 · gone from GitHub`, the whole as tooltip); `t` reopens,
 * `o` opens, Esc back. The production column on the `done` fixture: one row per way a thread gets done.
 */
const meta: Meta<typeof SignalsWorkspace> = {
	title: 'Views/Signals/Done',
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'done' },
}

export default meta
type Story = StoryObj<typeof SignalsWorkspace>

/** The list with its `Done today 8 · 5 filtered` line after the snoozed rows. */
export const Line: Story = {}

/** `D`: the Done today list, each row with how it got done after its ref. */
export const List: Story = { args: { flow: 'done' } }

/**
 * Story only, not picked yet: while Signals does not hold the keys, the selected row's key hints
 * either keep their room (`reserved`, production today: focusing the column moves nothing, but an
 * unfocused busy column has an empty band under the done line) or take none (`no room`: the done line
 * sits on the bottom edge like at rest, and focusing the column lifts it by the hints' height). Click a
 * frame to give it the keys and compare.
 */
const HINTS_TAKE_NO_ROOM = `
[data-signals-variant='hints-take-no-room'] .signals:not(:focus-within) .signals-foot-hints { display: none; }
[data-signals-variant='hints-take-no-room'] .signals:not(:focus-within)
	.signals-foot:not(:has(.signals-note:not(:empty), .signals-health, .signals-foot-actions)) {
	min-height: 0;
	padding: 0;
}
`

/**
 * The done line at the column's bottom edge: at rest (nothing open) the empty footer takes no room,
 * so `Done today 8 · 5 filtered` sits 8px over the edge. A busy column without the keys, in the two
 * looks not picked yet (see `HINTS_TAKE_NO_ROOM`): hints keep their room, or take none.
 */
export const AtTheBottom: Story = {
	render: () => (
		<>
			<style>{HINTS_TAKE_NO_ROOM}</style>
			<SignalsColumnFrames
				height={640}
				frames={[
					{ width: 340, scenario: 'empty', label: 'At rest' },
					{ width: 340, scenario: 'done', label: 'Busy, no keys · A: hints keep their room (now)' },
					{
						width: 340,
						scenario: 'done',
						label: 'Busy, no keys · B: hints take no room',
						variant: 'hints-take-no-room',
					},
				]}
			/>
		</>
	),
}
