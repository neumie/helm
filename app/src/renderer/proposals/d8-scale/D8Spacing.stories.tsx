// D8 · Spacing (research/helm-spec.md C6, research/helm-tokens.md §3.6): §2.3 allows 4/8/12/16/20/24/32 only,
// while 112 padding/margin/gap values are off it: 6 ×37 and 10 ×31 are most of them, then odd optical values
// (3/5/7/9/11/13) and layout metrics (80/84/90 traffic-light reserve). Frames are the real toast, banner, item
// detail and work list; each variant changes only the values those frames show, except the button padding/gap
// (10/14, 6: a component metric owned by §3.1) and the 6 px toast stack gap (an inline style of the toast story).
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameSpec } from './frame'

const FRAMES: readonly FrameSpec[] = [
	{ id: 'compositions-toast--stack-limit', label: 'Toasty', width: 380, height: 280, zoom: 1.4 },
	{ id: 'primitives-banner--with-action', label: 'Banner', width: 420, height: 110, zoom: 1.4 },
	{ id: 'views-sidebar--item-detail', label: 'Detail položky · záhlaví, sekce, log', width: 460, height: 860 },
	{ id: 'views-sidebar--work-list', label: 'Seznam práce · lišta, seznam, stav řádku', width: 460, height: 560 },
]

/** Odd optical values in these frames; shared by both variants. */
const ODD = `
.toast { padding: 12px; }
.toast-action { margin: -4px 0 0 0; }
.toast-countdown { bottom: 4px; }
.item-row-status, .detail-hero, .activity-list { gap: 4px; }
.command-status { gap: 8px; }
`

/** Every value in these frames to the nearest 4-scale step; ties (6, 10) round up. Buttons excepted (§3.1). */
const NEAREST = `${ODD}
.toast { gap: 12px; }
.toast-dismiss { margin: -4px -8px 0 -8px; }
.banner, .security-note, .log-well, .plan-well { padding: 12px; }
.card, [data-detail-state] .card { gap: 12px; }
.card-flush .card-head { margin-bottom: 8px; }
.list-toolbar { padding: 12px 8px 0; }
.list-scroll { padding: 8px 0 16px; }
.empty-detail, .run-caption { margin-top: 8px; }
.segmented-index .segment-body, .intent-questions { gap: 8px; }
`

/** 6 and 10 become scale steps; only the odd optical values snap. */
const HALF_STEPS = `${ODD}
.toast-dismiss { margin: -4px -6px 0 -6px; }
`

const meta: Meta = { title: 'Proposals/D8 Scale/Spacing', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · 6, 10 a liché hodnoty',
	render: () => (
		<Proposal
			decision="D8"
			variant="Current · 6, 10 a liché hodnoty"
			note="Ve snímcích: toast 11 / 12 / 13 s mezerou 10 a posuny −3, banner a log 10 / 12, sekce detailu mezera 10, záhlaví detailu 5, lišta seznamu 10, seznam 6, stav řádku 5."
			facts={[
				'mimo stupnici: 112 ze 747',
				'6 ×37, 10 ×31',
				'liché 3/5/7/9/11/13: 20',
				'14/18/22/28/40/48: 18',
				'80/84/90 (rezerva semaforu): 6',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · hodnoty v rámech na 4 / 8 / 12 / 16',
	render: () => (
		<Proposal
			decision="D8"
			variant="A · hodnoty v rámech na 4 / 8 / 12 / 16"
			note="Vše v těchto rámech na nejbližší krok, remízy (6, 10) nahoru; tlačítka (10 / 14, mezera 6) ne, jejich rozměr řeší §3.1. Banner a log jsou o 4 px vyšší, toast stejně vysoký (11 + 13 = 12 + 12; s tlačítkem o 1 px nižší kvůli posunu −4), sekce detailu řidší, seznam se posune o 2 px."
			facts={[
				'10 → 12',
				'6 → 8',
				'11 / 13 → 12',
				'5 → 4, 7 → 8',
				'−3 → −4',
				'mezera mezi toasty 6 = inline styl story',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={NEAREST} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · přidat 6 a 10, liché zaokrouhlit (doporučuji)',
	render: () => (
		<Proposal
			decision="D8"
			variant="B · přidat 6 a 10, liché zaokrouhlit (doporučuji)"
			note="Stupnice dostane mezikroky 6 a 10 jen dovnitř komponent (mezery, vnitřní odsazení studní, toastů a bannerů). Mění se jen liché hodnoty."
			facts={[
				'nové kroky: 6, 10 (uvnitř komponent)',
				'toast 11 / 13 → 12, posuny −3 → −4',
				'záhlaví detailu a stav řádku 5 → 4',
				'68 hodnot přestane být chybou',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={HALF_STEPS} />
		</Proposal>
	),
}
