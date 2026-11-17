// D15/5 Terminal group band — the tab text, group name and count inside a named group's colour band (and its hover
// tint) in the tab strip. The Background list header uses the same name and count rules; it is in the captions only,
// because Chromium misplaces its top-layer popover inside these nested frames. See docs/plans/design-system/proposals/D15.md.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameContext, type FrameSpec, waitFor } from './frame'
import { BAND_CURRENT, BAND_FAINT, BAND_LIFT, bandCss, bandFacts, helm, high } from './values'

/**
 * Gives the fixture's groups the colour with the lowest ratios (cyan for tab text, red for the name and count; the
 * fixtures use blue and purple), then holds the state that matters through `data-d15-hover`.
 */
const recolour =
	(colour: 'cyan' | 'red', within: string, hover: readonly string[] = []) =>
	async ({ doc }: FrameContext) => {
		const host = await waitFor(() => doc.querySelector(within), within)
		for (const element of host.querySelectorAll<HTMLElement>('[style*="--group-color"]'))
			element.style.setProperty('--group-color', `var(--group-${colour})`)
		for (const selector of hover)
			(await waitFor(() => host.querySelector(selector), selector)).setAttribute('data-d15-hover', '')
	}

const strip = (label: string, hover: readonly string[], palette?: 'high'): FrameSpec => ({
	id: 'views-terminal-workspace--grouped-tab-headers',
	label,
	...(palette ? { palette } : {}),
	width: 1100,
	height: 300,
	zoom: 3,
	crop: { selector: '#tabs .tab-group-section', pad: 6 },
	setup: recolour('cyan', '#tabs', hover),
})

const FRAMES: readonly FrameSpec[] = [
	strip('Lišta · azurová skupina, karta „compile“ v klidu', []),
	strip('Lišta · azurová skupina, karta „compile“ v hoveru', ['.tab-group-section .tab']),
	{
		id: 'views-terminal-workspace--collapsed-tab-group',
		label: 'Lišta · červená sbalená skupina v hoveru (název a počet)',
		width: 1100,
		height: 300,
		zoom: 3,
		crop: { selector: '#tabs .tab-group-section', pad: 6 },
		setup: recolour('red', '#tabs', ['.tab-group-toggle']),
	},
	strip('Lišta · azurová skupina, karta „compile“ v klidu', [], 'high'),
]

const meta: Meta = { title: 'Proposals/D15 Contrast/Group band', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

/** Helm: the worst of each pair over the seven group colours; High contrast: only its lowest pair. */
const facts = (rule: typeof BAND_CURRENT) => {
	const low = bandFacts(high, rule)
		.map(fact => ({ fact, value: Number(/min (\d+\.\d+)/.exec(fact)?.[1]) }))
		.reduce((a, b) => (b.value < a.value ? b : a))
	return [...bandFacts(helm, rule), `HC nejnižší: ${low.fact}`]
}

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D15/5"
			variant="Current"
			note="Pás skupiny je 15 % barvy skupiny (hover 22 %). Karta v pásu má --text-2, název barvu skupiny přimíchanou do --text-1, počet do --text-2. Nejhorší je azurová (karta) a červená (název, počet)."
			facts={facts(BAND_CURRENT)}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · text v pásu o stupeň světlejší (doporučuji)',
	render: () => (
		<Proposal
			decision="D15/5"
			variant="A · text v pásu o stupeň světlejší (doporučuji)"
			note="Pás zůstává. Karta v pásu má --text-1 (hover --text-0, číslo ⌘N stejně jako text karty), název se míchá do --text-0 a v hoveru je --text-0, počet je 40 % barvy v --text-1. Barva skupiny zůstává v pásu, ikoně a nádechu názvu."
			facts={facts(BAND_LIFT)}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={bandCss(BAND_LIFT)} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · slabší pás a světlejší text',
	render: () => (
		<Proposal
			decision="D15/5"
			variant="B · slabší pás a světlejší text"
			note="Pás 8 % (hover 12 %, aktivní 20 %) a text jako v A. Samotný slabší pás nestačí: --text-2 by měl jen 3.93–4.15. Skupina je méně vidět, barevnou identitu nese hlavně ikona."
			facts={facts(BAND_FAINT)}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={bandCss(BAND_FAINT)} />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · ponechat, výjimka',
	render: () => (
		<Proposal
			decision="D15/5"
			variant="C · ponechat, výjimka"
			note="Vypadá stejně jako Current, jen pravidlo: text v barevném pásu skupiny se vyjme z 4.5:1. Karta i název jsou čitelné jinde (Background, tooltip, menu), ale v liště je to hlavní místo, kde je čteš."
			facts={facts(BAND_CURRENT)}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}
