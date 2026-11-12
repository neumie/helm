// D5/3 Control edges — inputs, selects and toggles are outlined with --hairline (rest) / --hairline-strong (hover),
// 1.19 / 1.60:1 on --pane, under WCAG 1.4.11's 3:1 for an essential boundary. See docs/plans/design-system/proposals/D5.md.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ratio } from '../contrast'
import { Proposal } from '../proposal'
import { EDGE, HELM, edgeFacts } from './values'
import { Board, FRAME_CSS, FieldPrimitives, FieldStates, Row, SidebarRunLimits } from './views'

const meta: Meta = {
	title: 'Proposals/D5 Contrast/Control edges',
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

/** Variant A: a new --edge-control token, used only by enabled field-like controls (focus and invalid keep their
 *  colour; disabled controls stay at --hairline, WCAG 1.4.11 exempts them). Hover answers the real `:hover` and
 *  the StateGrid's forced `[data-force-state="hover"]`, like the production rule. */
const FIELD =
	'.proposal-stage .input:not(:focus):not([data-force-state="focus-visible"]):not(:disabled):not(.input-invalid):not(.new-item-title-input)'
const CONTROL_EDGE_CSS = `
${FIELD},
.proposal-stage .toggle:not(.toggle-on):not(:disabled) { border-color: var(--edge-control); }
@media (hover: hover) {
	${FIELD}:hover,
	${FIELD}[data-force-state="hover"] { border-color: var(--edge-control-hover); }
}
`

function Surfaces() {
	return (
		<Board>
			<Row>
				<FieldStates />
				<FieldPrimitives />
				<SidebarRunLimits />
			</Row>
		</Board>
	)
}

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D5/3"
			variant="Current"
			note="Pole a přepínače mají okraj --hairline (hover --hairline-strong) a výplň pole se od pane skoro neliší, takže hranici nese hlavně tenká čára."
			facts={edgeFacts(0.07, 0.16)}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · silnější okraj jen u polí',
	render: () => (
		<Proposal
			decision="D5/3"
			variant="A · silnější okraj jen u polí"
			note="Nový token --edge-control (bílá 33 %, 3:1) jen pro povolená pole, select a vypnutý přepínač, dělicí čáry a zakázaná pole zůstávají --hairline; formuláře působí těžší."
			facts={edgeFacts(EDGE.controlAlpha, EDGE.controlHoverAlpha)}
			overrides={{ '--edge-control': EDGE.control, '--edge-control-hover': EDGE.controlHover }}
			css={FRAME_CSS + CONTROL_EDGE_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · výjimka, okraj dekorativní (doporučuji)',
	render: () => (
		<Proposal
			decision="D5/3"
			variant="B · výjimka: okraj je dekorativní (doporučuji)"
			note={`Beze změny: pole poznáš podle štítku, hodnoty a fokusu (accent na pane ${ratio(HELM.accent, HELM.pane)}), okraj je dekorace a silný okraj dostane High contrast preset (D5/4).`}
			facts={edgeFacts(0.07, 0.16)}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}
