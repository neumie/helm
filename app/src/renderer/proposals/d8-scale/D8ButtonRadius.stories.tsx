// D8 · Button radius (research/helm-spec.md C2): design-system §2.4 puts buttons at --radius-md 6, §3.1 and
// button.css give the md button 8 and the sm button 6. Frames are the real item detail and Settings → Remote.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameSpec } from './frame'

const FRAMES: readonly FrameSpec[] = [
	{
		id: 'views-sidebar--item-detail',
		label: 'Detail položky · Focus in Okena, Set as done (md), Show (sm)',
		width: 460,
		height: 860,
	},
	{
		id: 'views-sidebar--remote-pairing-code',
		label: 'Settings → Remote · New code (md), Hide code (sm)',
		width: 460,
		height: 860,
	},
]

const meta: Meta = { title: 'Proposals/D8 Scale/Button radius', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · md 8, sm 6 (doporučuji)',
	render: () => (
		<Proposal
			decision="D8"
			variant="Current · md 8, sm 6 (doporučuji)"
			note="Kód (button.css) a §3.1: md tlačítko 8, sm 6. Poměr poloměr / výška je u obou stejný (1/4). Stačí opravit řádek v tabulce §2.4, pixely se nemění."
			facts={[
				'.btn 32px · radius 8px (0.25 výšky)',
				'.btn-sm 24px · radius 6px (0.25 výšky)',
				'§2.4 říká buttons = --radius-md 6',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · md 6 podle tabulky §2.4',
	render: () => (
		<Proposal
			decision="D8"
			variant="A · md 6 podle tabulky §2.4"
			note="Všechna tlačítka 6. Velké tlačítko (32 px) je pak hranatější než malé (24 px); plné tlačítko Set as done přes celou šířku působí tvrdší."
			facts={['.btn 32px · radius 6px (0.19 výšky)', '.btn-sm 24px · radius 6px (0.25 výšky)']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css=".btn:not(.btn-sm) { border-radius: 6px; }" />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · všechna tlačítka 8',
	render: () => (
		<Proposal
			decision="D8"
			variant="B · všechna tlačítka 8"
			note="Jeden poloměr pro všechna tlačítka. Malé tlačítko (24 px) je pak skoro kapsle; ikonová tlačítka (6) se od něj odliší."
			facts={['.btn 32px · radius 8px (0.25 výšky)', '.btn-sm 24px · radius 8px (0.33 výšky)']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css=".btn-sm { border-radius: 8px; }" />
		</Proposal>
	),
}
