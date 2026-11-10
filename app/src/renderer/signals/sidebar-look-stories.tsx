// Story helpers for Views / Signals / Sidebar look: every look gets the same five stories, so the
// variants compare state by state. The production column on fixture services (SignalsWorkspace).
import type { StoryObj } from '@storybook/react-vite'
import type { SignalsLook } from './SignalsLook'
import { SignalsColumnFrames, SignalsWorkspace } from './SignalsWorkspace'

type Story = StoryObj<typeof SignalsWorkspace>

export const lookMeta = {
	component: SignalsWorkspace,
	parameters: { layout: 'fullscreen' },
}

export function lookStories(look: SignalsLook): {
	Empty: Story
	Busy: Story
	HalfQuiet: Story
	EmptySourceDown: Story
	Widths: Story
} {
	return {
		Empty: { name: 'Empty', args: { look, scenario: 'empty' } },
		Busy: { name: 'Busy', args: { look, scenario: 'asks' } },
		HalfQuiet: { name: 'Nothing needs you, two managed', args: { look, scenario: 'quiet' } },
		EmptySourceDown: { name: 'Empty, Mail not answering', args: { look, scenario: 'empty-down' } },
		Widths: {
			name: 'Widths 260 and 420',
			render: () => (
				<SignalsColumnFrames
					look={look}
					height={1000}
					frames={[
						{ width: 260, scenario: 'empty', label: '260 · empty' },
						{ width: 260, scenario: 'asks', label: '260 · busy' },
						{ width: 420, scenario: 'empty', label: '420 · empty' },
						{ width: 420, scenario: 'asks', label: '420 · busy' },
					]}
				/>
			),
		},
	}
}
