// D5/1 Meta text — `--text-2` is the standard meta colour (77 production uses) and fails 4.5:1 on every surface.
// See docs/plans/design-system/proposals/D5.md.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { HELM, META, metaFacts } from './values'
import {
	Board,
	FRAME_CSS,
	FieldPrimitives,
	Row,
	SidebarItemDetail,
	SidebarNewItem,
	SidebarWorkList,
	SignalsAndDock,
} from './views'

const meta: Meta = {
	title: 'Proposals/D5 Contrast/Meta text',
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

/** Signals first: its column takes focus on mount, so lower down it would scroll the canvas away from the top. */
function Surfaces() {
	return (
		<Board>
			<SignalsAndDock label="Signals + agent dock (Views/Signals/Column) · meta tu nese hlavně --dock-dim, odvozený z --text-2, mění se nepřímo" />
			<Row>
				<SidebarWorkList />
				<SidebarItemDetail />
				<SidebarNewItem />
				<FieldPrimitives />
			</Row>
		</Board>
	)
}

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D5/1"
			variant="Current"
			note="Meta text (časy, počty, popisky polí, placeholdery) je dnes pod 4.5:1 na všech plochách."
			facts={metaFacts(HELM.text2)}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · 4.5:1 na chrome (doporučuji)',
	render: () => (
		<Proposal
			decision="D5/1"
			variant="A · 4.5:1 na chrome (doporučuji)"
			note="Nejmenší zesvětlení stejného odstínu, které drží 4.5:1 na všech plochách bez výplně (vybraný řádek a placeholder zůstanou pod); cena: text-2 se přiblíží text-1."
			facts={metaFacts(META.chrome)}
			overrides={{ '--text-2': META.chrome }}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · 4.5:1 jen na pane',
	render: () => (
		<Proposal
			decision="D5/1"
			variant="B · 4.5:1 jen na pane"
			note="Střední krok: 4.5:1 na pane a well (sidebar, detail), na chrome (Signals, topbar, dock) zůstane pod."
			facts={metaFacts(META.pane)}
			overrides={{ '--text-2': META.pane }}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · ponechat, výjimka',
	render: () => (
		<Proposal
			decision="D5/1"
			variant="C · ponechat, výjimka pro dekorativní meta"
			note="Beze změny vzhledu; pravidlo by pustilo --text-2 jen na doplňkový meta text a všech 77 míst by se muselo projít a zařadit."
			facts={metaFacts(HELM.text2)}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}
