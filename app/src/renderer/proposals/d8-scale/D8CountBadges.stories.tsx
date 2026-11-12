// D8 · Count badges (research/helm-spec.md C5 + C21, research/helm-tokens.md §3.2): the small counts and the
// question mark use 10 px (off the §2.2 scale 11/12/13/17), two of them at weight 700. Frames are the real
// terminal workspace (Background badge, group counts). The detail's clarifying-question mark (.question-mark,
// 10/700) has no story yet (no story opens an Item with questions); the variant CSS still covers it.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameSpec } from './frame'

const FRAMES: readonly FrameSpec[] = [
	{
		id: 'views-terminal-workspace--background-terminals',
		label: 'Pás tabů · odznak Background (.bg-count), počet ve skupině',
		width: 900,
		height: 230,
		zoom: 1.4,
	},
	{
		id: 'views-terminal-workspace--collapsed-tab-group',
		label: 'Sbalená skupina tabů · počet (.tab-group-count)',
		width: 900,
		height: 60,
		zoom: 1.4,
	},
]

const NEAREST = `
.bg-count { font-size: 11px; font-weight: 600; }
.tab-group-count { font-size: calc(11px * var(--ui-scale)); }
.question-mark { font-size: calc(11px * var(--ui-scale)); font-weight: 600; }
`

const COUNT_STEP = `
.bg-count { font-weight: 600; }
.question-mark { font-weight: 600; }
`

const meta: Meta = { title: 'Proposals/D8 Scale/Count badges', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · 10 px, tučnost 700',
	render: () => (
		<Proposal
			decision="D8"
			variant="Current · 10 px, tučnost 700"
			note="§2.2 zná nejmenší krok 11; dock a Signals tučné písmo nepoužívají."
			facts={[
				'.bg-count 10/700, odznak 2 7 px',
				'.tab-group-count 10/500 mono',
				'.question-mark 10/700 v kruhu 16 px (detail otázek, zatím bez story)',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · zaokrouhlit na 11 / 600 (doporučuji)',
	render: () => (
		<Proposal
			decision="D8"
			variant="A · zaokrouhlit na 11 / 600 (doporučuji)"
			note="Všechny tři dostanou krok Meta 11 a tučnost 600. Odznak naroste o 1 px a čte se lépe; žádný nový krok. Otazník v kruhu 16 px bude těsnější (nemá story; Tučnost B by mu nechala 700)."
			facts={['.bg-count 11/600', '.tab-group-count 11/500 mono', '.question-mark 11/600']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={NEAREST} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · nový krok 10 pro počty, tučnost 600',
	render: () => (
		<Proposal
			decision="D8"
			variant="B · nový krok 10 pro počty, tučnost 600"
			note="Stupnice dostane krok 10 jen pro čísla a znak v odznaku nebo kruhu do 16 px. Velikost zůstává, 700 → 600 (spolu s Tučnost A konec zapsaného 700)."
			facts={[
				'nový krok: 10 (počty v odznacích)',
				'.bg-count 10/600',
				'.question-mark 10/600',
				'.tab-group-count beze změny',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={COUNT_STEP} />
		</Proposal>
	),
}
