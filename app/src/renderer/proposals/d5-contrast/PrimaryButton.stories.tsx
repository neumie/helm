// D5/2 Primary button — white on --accent-fill fails 4.5:1 at rest and worse on hover (hover is lighter).
// The same fill also paints the on state of Toggle and the agent picker's commit segment (both mounted below).
// See docs/plans/design-system/proposals/D5.md.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BUTTON, HELM, buttonFacts } from './values'
import { Board, ButtonPrimitives, FRAME_CSS, FieldPrimitives, Row, SidebarItemDetail } from './views'

const meta: Meta = {
	title: 'Proposals/D5 Contrast/Primary button',
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

function Surfaces() {
	return (
		<Board>
			<Row>
				<ButtonPrimitives />
				<FieldPrimitives />
				<SidebarItemDetail />
			</Row>
		</Board>
	)
}

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D5/2"
			variant="Current"
			note="Bílý text na #3b82f6. Hover je světlejší, takže kontrast ještě klesne."
			facts={buttonFacts(HELM.accentFill, HELM.accentFillHover, HELM.onAccent)}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · tmavší výplň (doporučuji)',
	render: () => (
		<Proposal
			decision="D5/2"
			variant="A · tmavší výplň, hover ještě tmavší (doporučuji)"
			note="Nejmenší ztmavení stejného odstínu na 4.5:1 pod bílou, hover o 4 % tmavší místo světlejšího; bílý text zůstává a změní se i zapnutý přepínač a výběr agenta."
			facts={buttonFacts(BUTTON.fill, BUTTON.fillHover, HELM.onAccent)}
			overrides={{ '--accent-fill': BUTTON.fill, '--accent-fill-hover': BUTTON.fillHover }}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · tmavý text',
	render: () => (
		<Proposal
			decision="D5/2"
			variant="B · tmavý text na dnešní výplni"
			note="Výplň beze změny, --on-accent = --well: kontrast vysoký, ale tmavý text na modré Helm ani macOS jinde nepoužívá."
			facts={buttonFacts(HELM.accentFill, HELM.accentFillHover, BUTTON.darkText)}
			overrides={{ '--on-accent': BUTTON.darkText }}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · ponechat',
	render: () => (
		<Proposal
			decision="D5/2"
			variant="C · ponechat, výjimka"
			note="Beze změny, primární tlačítko jako výjimka; 13/600 není pro WCAG velký text (ten začíná na 18.66 px tučně), takže jde o vědomé porušení AA."
			facts={buttonFacts(HELM.accentFill, HELM.accentFillHover, HELM.onAccent)}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}
