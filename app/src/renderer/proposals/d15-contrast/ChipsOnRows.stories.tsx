// D15/4 Chips on rows — a tone on its 15 % soft fill is checked over the bare pane; a chip on a hovered or pressed
// row sits on that row's fill too, and blue, red and gray drop under 4.5:1. See docs/plans/design-system/proposals/D15.md.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameSpec, mark } from './frame'
import { S, TONE_LIFT, chipRatio, helm, high } from './values'

/** Every row in one state; the list is scrolled to its end so the blue, gray and red chips are all in view. */
const rows =
	(state: 'hover' | 'active') =>
	async ({ doc }: { doc: Document }) => {
		await mark(doc, '.item-row', 'data-force-state', state)
		const list = doc.querySelector<HTMLElement>('.list-scroll')
		if (list) list.scrollTop = list.scrollHeight
	}

const frame = (state: 'hover' | 'active', palette?: 'high'): FrameSpec => ({
	id: 'compositions-list-row--verdict-rows',
	label: state === 'hover' ? 'Seznam práce · řádky v hoveru' : 'Seznam práce · řádky stisknuté',
	...(palette ? { palette } : {}),
	width: 380,
	height: 420,
	zoom: 2,
	crop: { selector: '.list-scroll', pad: 0 },
	setup: rows(state),
})

const FRAMES: readonly FrameSpec[] = [frame('hover'), frame('active'), frame('active', 'high')]

/** A: the soft fill is mixed into the pane, so the chip carries its own opaque background on any row. */
const OPAQUE = `
.chip-gray { background: color-mix(in srgb, var(--neutral) 15%, var(--pane)); }
.chip-blue { background: color-mix(in srgb, var(--accent) 15%, var(--pane)); }
.chip-green { background: color-mix(in srgb, var(--success) 15%, var(--pane)); }
.chip-amber { background: color-mix(in srgb, var(--warn) 15%, var(--pane)); }
.chip-red { background: color-mix(in srgb, var(--danger) 15%, var(--pane)); }
`

/** B changes the Helm preset only (High contrast hover already passes). */
const LIFT = `:root:not([data-d15-palette="high"]) { --danger: ${TONE_LIFT['--danger']} !important; --neutral: ${TONE_LIFT['--neutral']} !important; }`

const h = S.helm
const hc = S.high
const row = (tone: string, word: string) =>
	`${word}: klid ${chipRatio(helm, tone, h.pane)}, hover ${chipRatio(helm, tone, h.input)}, stisk ${chipRatio(helm, tone, h.selected)}`
const CURRENT_FACTS = [
	row('--accent', 'modrý'),
	row('--danger', 'červený'),
	row('--neutral', 'šedý'),
	`HC stisk: modrý ${chipRatio(high, '--accent', hc.selected)}, červený ${chipRatio(high, '--danger', hc.selected)}, šedý ${chipRatio(high, '--neutral', hc.selected)}`,
	'zelený a žlutý procházejí všude',
]

const meta: Meta = { title: 'Proposals/D15 Contrast/Chips on rows', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D15/4"
			variant="Current"
			note="Čip je průhledná 15% výplň barvy tónu. Na řádku v hoveru nebo stisku se přidá výplň řádku, čip ztmavne a text tónu ztratí kontrast."
			facts={CURRENT_FACTS}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · neprůhledná výplň čipu',
	render: () => (
		<Proposal
			decision="D15/4"
			variant="A · neprůhledná výplň čipu"
			note="Výplň čipu se smíchá s plochou panelu (color-mix s --pane místo s transparent). Čip má na každém řádku stejný kontrast jako v klidu; na řádku v hoveru je o odstín tmavší než okolí (vypadá jako vložený)."
			facts={[
				`modrý ${chipRatio(helm, '--accent', h.pane)}, červený ${chipRatio(helm, '--danger', h.pane)}, šedý ${chipRatio(helm, '--neutral', h.pane)} v každém stavu`,
				`HC modrý ${chipRatio(high, '--accent', hc.pane)}, červený ${chipRatio(high, '--danger', hc.pane)}, šedý ${chipRatio(high, '--neutral', hc.pane)}`,
				'barvy tónů beze změny; nový odvozený token „-soft“ na --pane',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={OPAQUE} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · zesvětlit červenou a šedou, stisk výjimkou (doporučuji)',
	render: () => (
		<Proposal
			decision="D15/4"
			variant="B · zesvětlit červenou a šedou, stisk výjimkou (doporučuji)"
			note={`--danger ${TONE_LIFT['--danger']} a --neutral ${TONE_LIFT['--neutral']} (nejmenší posun stejného odstínu): čip projde na řádku v hoveru. Stisk trvá jen po dobu kliknutí, ten se vyjme. Modrá v hoveru prochází už dnes.`}
			facts={[
				`hover: modrý ${chipRatio(helm, '--accent', h.input)}, červený ${chipRatio(helm, '--danger', h.input, TONE_LIFT['--danger'])}, šedý ${chipRatio(helm, '--neutral', h.input, TONE_LIFT['--neutral'])}`,
				`stisk (výjimka): červený ${chipRatio(helm, '--danger', h.selected, TONE_LIFT['--danger'])}, šedý ${chipRatio(helm, '--neutral', h.selected, TONE_LIFT['--neutral'])}`,
				'mění se --danger všude (chyby, mazání), --neutral se blíží --text-1',
				'HC hover prochází už dnes',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={LIFT} />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · ponechat, výjimka',
	render: () => (
		<Proposal
			decision="D15/4"
			variant="C · ponechat, výjimka"
			note="Vypadá stejně jako Current, jen pravidlo: čipy na řádku v hoveru i stisku se vyjmou. Hover trvá, dokud je na řádku kurzor, takže výjimka pokrývá i čtení."
			facts={CURRENT_FACTS}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}
