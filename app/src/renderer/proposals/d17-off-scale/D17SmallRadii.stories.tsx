// D17 · Small radii (docs/plans/design-system/proposals/D17.md §2): §2.4 starts at --radius-sm 4, while seven
// rules use 1, 1.5, 2 or 3 px. Three are thin bars whose radius is half their thickness (a pill); the others are a
// checkbox mark, the color swatch (3 inside a 6 px field with 3 px padding, concentric), a search match and the
// PDF page. Frames are the real production stories, cropped and magnified.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameSpec } from './frame'

const FRAMES: readonly FrameSpec[] = [
	{
		id: 'views-sidebar--work-list',
		label: 'Seznam práce · podtržení aktivní záložky 2 px (dnes radius 1)',
		width: 460,
		height: 500,
		zoom: 6,
		crop: { selector: '.segmented-index .segment-active .segment-body', pad: 4 },
	},
	{
		id: 'views-sidebar--new-item',
		label: 'New item · pruh u zaostřeného promptu 2 px (dnes radius 1; zaostření vynuceno v rámu)',
		width: 460,
		height: 700,
		zoom: 6,
		// The bar shows only while the prompt holds focus, which the page takes back from the frame: show that state.
		setup: async ({ doc }) => {
			const style = doc.createElement('style')
			style.textContent = '.new-item-prompt-field::before { background: var(--accent); }'
			doc.head.append(style)
		},
		crop: { selector: '.new-item-prompt-field .field-label', pad: 12, width: 40 },
	},
	{
		id: 'views-agent-dock-agents-entry--agents-entry',
		label: 'Dock · segmenty pruhu agentů 8 × 3 (dnes radius 1.5)',
		width: 900,
		height: 220,
		zoom: 10,
		crop: { selector: '.agent-dock-agents-bar', pad: 3 },
	},
	{
		id: 'compositions-agent-dock--question-open',
		label: 'Dock · zaškrtávátko vícenásobné volby 10 × 10 (dnes radius 3; data-multi zapnuto v rámu)',
		width: 1200,
		height: 700,
		zoom: 6,
		setup: async ({ doc }) => {
			doc.querySelector('.agent-dock-choices')?.setAttribute('data-multi', 'true')
			doc.querySelector('.agent-dock-choice-cursor')?.setAttribute('data-on', 'true')
		},
		crop: { selector: '.agent-dock-choice', pad: 2, width: 64 },
	},
	{
		id: 'views-sidebar--appearance',
		label: 'Appearance · vzorník barvy v poli 24 px (dnes pole radius 6, odsazení 3, vzorník 16 px radius 3)',
		width: 460,
		height: 900,
		zoom: 8,
		crop: { selector: '.color-input', pad: 4 },
	},
	{
		id: 'views-helm-open-c-format-views-code--search',
		label: 'Prohlížeč kódu · nalezený výraz 43 × 14 (dnes radius 2)',
		width: 1200,
		height: 800,
		zoom: 5,
		crop: { selector: '.cm-searchMatch', pad: 6 },
	},
	{
		id: 'views-document-review-pdf--report',
		label: 'PDF · roh stránky (dnes radius 2)',
		width: 1200,
		height: 800,
		zoom: 8,
		crop: { selector: '.viewer-pdf-paper', pad: 6, width: 40, height: 30 },
	},
]

/** Thin bars as pills: identical pixels (radius = half the thickness), written as the full radius. */
const PILL_BARS = `
.agent-dock-agents-seg { border-radius: 999px; }
.new-item-prompt-field::before { border-radius: 999px; }
.segmented-index .segment-active .segment-body::after { border-radius: 999px; }
`

/** Everything on --radius-sm 4; the swatch keeps its 3 px padding. */
const ALL_FOUR = `
.agent-dock-agents-seg { border-radius: 4px; }
.new-item-prompt-field::before { border-radius: 4px; }
.segmented-index .segment-active .segment-body::after { border-radius: 4px; }
.agent-dock-choices[data-multi="true"] .agent-dock-choice-cursor { border-radius: 4px; }
.color-input::-webkit-color-swatch { border-radius: 4px; }
.viewer-code .cm-editor .cm-searchMatch { border-radius: 4px; }
.viewer-pdf-paper { border-radius: 4px; }
`

/** Bars as pills, small shapes on 4, the swatch concentric: padding 2 + radius 4 = field radius 6. */
const PILLS_AND_FOUR = `${PILL_BARS}
.agent-dock-choices[data-multi="true"] .agent-dock-choice-cursor { border-radius: 4px; }
.color-input::-webkit-color-swatch-wrapper { padding: 2px; }
.color-input::-webkit-color-swatch { border-radius: 4px; }
.viewer-code .cm-editor .cm-searchMatch { border-radius: 4px; }
.viewer-pdf-paper { border-radius: 4px; }
`

const meta: Meta = { title: 'Proposals/D17 Off-scale values/Small radii', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · 1 / 1.5 / 2 / 3',
	render: () => (
		<Proposal
			decision="D17"
			variant="Current · 1 / 1.5 / 2 / 3"
			note="Tři tenké čáry mají poloměr = polovina tloušťky (kulaté konce). Zaškrtávátko 3, vzorník 3 (pole 6 − odsazení 3 = 3, soustředné), nalezený výraz a stránka PDF 2."
			facts={[
				'čáry: 2 px / 1, 2 px / 1, 3 px / 1.5',
				'zaškrtávátko 10 × 10 / 3',
				'vzorník 16 × 16 / 3 v poli 24 / 6, odsazení 3',
				'nalezený výraz 2, stránka PDF 2',
				'7 lint výjimek + odsazení vzorníku 3',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · vše na 4 (--radius-sm)',
	render: () => (
		<Proposal
			decision="D17"
			variant="A · vše na 4 (--radius-sm)"
			note="Čáry vypadají stejně: prohlížeč poloměr větší než polovina tloušťky zkrátí. Zaškrtávátko, nalezený výraz a roh stránky se zakulatí. Vzorník 4 v odsazení 3 už není soustředný s polem (6 − 3 = 3 ≠ 4)."
			facts={[
				'čáry: beze změny pixelů (zapsáno 4)',
				'zaškrtávátko 10 × 10 / 4 (skoro kroužek)',
				'vzorník 16 × 16 / 4, odsazení 3, nesoustředné',
				'nalezený výraz 4 na řádku 14 px, stránka PDF 4',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={ALL_FOUR} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · čáry jako pilulka, ostatní 4, vzorník soustředně (doporučuji)',
	render: () => (
		<Proposal
			decision="D17"
			variant="B · čáry jako pilulka (999), ostatní 4, vzorník soustředně (doporučuji)"
			note="Tenké čáry se zapíšou jako plné zaoblení (999, stejné pixely). Zaškrtávátko, nalezený výraz a stránka PDF na 4. Vzorník dostane odsazení 2 a poloměr 4: 6 − 2 = 4, takže zůstane soustředný a o 2 px větší."
			facts={[
				'čáry: 999, beze změny pixelů',
				'zaškrtávátko 10 × 10 / 4',
				'vzorník 16 → 18 px, radius 4, odsazení 2 (soustředné s polem 6)',
				'nalezený výraz 4, stránka PDF 4',
				'odsazení vzorníku 2 platí jen s volbou C v otázce 2px steps',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={PILLS_AND_FOUR} />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · zapsat jako rozměry komponent',
	render: () => (
		<Proposal
			decision="D17"
			variant="C · zapsat jako rozměry komponent"
			note="Vypadá stejně jako Current, jen pravidlo: každá hodnota se zapíše do §3 své komponenty (segmentový index, pruh agentů, pole barvy, prohlížeč). Stupnice §2.4 zůstane 4 / 6 / 8 / 999, pod 4 jen ve vlastní specifikaci."
			facts={['žádný pixel se nemění', '7 výjimek přejde z D17 na §3 řádky']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}
