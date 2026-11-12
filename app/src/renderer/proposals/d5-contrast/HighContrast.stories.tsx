// D5/4 High contrast preset — the preset macOS Increase Contrast selects still fails AA: primary button text,
// control edges and --text-2 on --fill-strong (a pair no production rule paints: the quiet button's hover and the
// BlockNote tooltip carry --text-0). Every story applies the whole preset (as the theme picker does) plus the
// variant's fixes. See docs/plans/design-system/proposals/D5.md.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal, type TokenOverrides } from '../proposal'
import { HIGH, HIGH_CONTRAST_TOKENS, HIGH_FIX, highFacts } from './values'
import { Board, ButtonPrimitives, FRAME_CSS, FieldPrimitives, Row, SidebarItemDetail, SidebarSettings } from './views'

const meta: Meta = {
	title: 'Proposals/D5 Contrast/High contrast preset',
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

const SHIPPED = {
	accentFill: HIGH.accentFill,
	accentFillHover: HIGH.accentFillHover,
	hairlineAlpha: 0.16,
	hairlineStrongAlpha: 0.32,
	text2: HIGH.text2,
} as const

const BUTTON_FIX: TokenOverrides = {
	'--accent-fill': HIGH_FIX.accentFill,
	'--accent-fill-hover': HIGH_FIX.accentFillHover,
}
const EDGE_FIX: TokenOverrides = { '--hairline': HIGH_FIX.hairline, '--hairline-strong': HIGH_FIX.hairlineStrong }

function Surfaces() {
	return (
		<Board>
			<Row>
				<ButtonPrimitives />
				<FieldPrimitives />
				<SidebarItemDetail />
				<SidebarSettings />
			</Row>
		</Board>
	)
}

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D5/4"
			variant="Current · High contrast, jak je"
			note="Preset, který vybírá i macOS Increase Contrast: tlačítko těsně pod 4.5 (hover hůř) a okraje polí pod 3:1."
			facts={highFacts(SHIPPED)}
			overrides={HIGH_CONTRAST_TOKENS}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · opravit vše',
	render: () => (
		<Proposal
			decision="D5/4"
			variant="A · opravit vše"
			note="Jako B a navíc --text-2 na 4.5 i na --fill-strong; ta dvojice se v produkci nevyskytuje, je to jen pojistka a text-2 za ni téměř splyne s text-1."
			facts={highFacts({ ...HIGH_FIX })}
			overrides={{ ...HIGH_CONTRAST_TOKENS, ...BUTTON_FIX, ...EDGE_FIX, '--text-2': HIGH_FIX.text2 }}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · tlačítko + okraje (doporučuji)',
	render: () => (
		<Proposal
			decision="D5/4"
			variant="B · tlačítko + okraje, text-2 výjimka (doporučuji)"
			note="Tlačítko o krok tmavší (hover tmavší) a --hairline na 3:1; --text-2 zůstává, protože na --fill-strong v produkci neleží, a žebříček text-1/text-2 zůstane čitelný."
			facts={highFacts({ ...HIGH_FIX, text2: HIGH.text2 })}
			overrides={{ ...HIGH_CONTRAST_TOKENS, ...BUTTON_FIX, ...EDGE_FIX }}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · jen tlačítko',
	render: () => (
		<Proposal
			decision="D5/4"
			variant="C · jen tlačítko"
			note="Nejmenší změna, jen výplň primárního tlačítka; okraje polí zůstanou i v High contrast pod 3:1."
			facts={highFacts({ ...SHIPPED, accentFill: HIGH_FIX.accentFill, accentFillHover: HIGH_FIX.accentFillHover })}
			overrides={{ ...HIGH_CONTRAST_TOKENS, ...BUTTON_FIX }}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}
