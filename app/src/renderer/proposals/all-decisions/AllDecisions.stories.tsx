// Proposals/All decisions — the one page Jakub opens to decide every open design-system question
// (docs/plans/design-system/spec.md § Open decisions). Each variant is the real story of its Proposals/ group.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { AllDecisions } from './AllDecisions'

const meta: Meta = {
	title: 'Proposals/All decisions',
	parameters: { layout: 'fullscreen' },
}
export default meta

export const Page: StoryObj = {
	name: 'Rozhodni tady',
	render: () => <AllDecisions />,
}
