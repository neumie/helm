// D17 · 2px steps (docs/plans/design-system/proposals/D17.md §1): §2.3 allows 2 px only as the inner padding of
// segmented tracks and the countdown bar; 20 more places use a 2 px gap/margin/padding (D17 lint entries). Frames
// are the real production stories; each variant changes only those 2 px values.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameSpec } from './frame'

const FRAMES: readonly FrameSpec[] = [
	{
		id: 'compositions-list-row--quick-actions',
		label: 'Řádek fronty · dvě ikonová tlačítka (.item-row-actions gap)',
		width: 460,
		height: 300,
		zoom: 4,
		// Both buttons in their hover fill, so the gap between the two 28 px fills shows.
		setup: async ({ doc }) => {
			for (const button of doc.querySelectorAll('.item-row-actions .icon-btn')) {
				button.setAttribute('data-force-state', 'hover')
			}
		},
		crop: { selector: '.item-row-actions', pad: 6 },
	},
	{
		id: 'primitives-activity-indicator--in-progress',
		label: 'Indikátor činnosti · tečky 2 px (.activity-indicator gap)',
		width: 300,
		height: 200,
		zoom: 8,
		crop: { selector: '.activity-indicator', pad: 4 },
	},
	{
		id: 'views-agent-dock-agents-entry--agents-entry',
		label: 'Dock · pruh agentů (.agent-dock-agents-bar gap)',
		width: 900,
		height: 220,
		zoom: 6,
		crop: { selector: '.agent-dock-agents-bar', pad: 6 },
	},
	{
		id: 'views-signals-column--column',
		label: 'Signals · Braillova značka sekce (.signals-braille-cell gap)',
		width: 420,
		height: 800,
		zoom: 6,
		crop: { selector: '.signals-braille-mark .signals-braille-cell', pad: 6 },
	},
	{
		id: 'views-sidebar--terminal-settings',
		label:
			'Settings → Terminal · název a zkratka (.shortcut-title gap); čára vlevo je výchozí okraj fieldsetu, mimo D17',
		width: 460,
		height: 900,
		zoom: 3,
		crop: { selector: '.shortcut-title', pad: 6 },
	},
	{
		id: 'views-run-context-editor--source-context',
		label: 'Run Context · nadtitulek nad názvem (.run-context-kicker margin)',
		width: 1100,
		height: 600,
		zoom: 2,
		crop: { selector: '.run-context-heading', pad: 6 },
	},
	{
		id: 'views-run-context-editor--source-context',
		label: 'Run Context · popisek a hodnota v liště (.run-context-source dl > div gap)',
		width: 1100,
		height: 600,
		zoom: 2,
		crop: { selector: '.run-context-source dl', pad: 6 },
	},
	{
		id: 'views-agent-dock-turn-message--markdown',
		label: 'Dock · seznam ve zprávě (li + li, p + ul margin, li padding)',
		width: 1200,
		height: 800,
		zoom: 1.5,
		crop: { selector: '.agent-dock-md ul', pad: 24 },
	},
]

/** Every 2 px D17 lint entry with its selector; `step` is the replacement. */
const rules = (step: string) => `
.agent-dock-agents-bar { gap: ${step}; }
.agent-dock-md li { padding-left: ${step}; }
.agent-dock-md li + li, .agent-dock-md li > :is(ul, ol), .agent-dock-md li > p + * { margin-top: ${step}; }
.agent-dock-md p + :is(ul, ol) { margin-top: ${step}; }
.agent-dock-source + .agent-dock-source::before { margin-right: ${step}; }
.review-screenshots { padding: ${step}; }
.remote-information h3 { padding-left: ${step}; }
.remote-markdown code { padding: ${step} 4px; }
.remote-workspace .remote-compose-open textarea { padding-bottom: ${step}; }
.run-context-banner > div { gap: ${step}; }
.run-context-kicker { margin-bottom: ${step}; }
.run-context-source dl > div { gap: ${step}; }
.item-row-actions { gap: ${step}; }
.remote-device-state { margin-top: ${step}; }
.sheet-heading { padding-top: ${step}; }
.shortcut-title { gap: ${step}; }
.signals-braille-mark .signals-braille-cell { gap: ${step}; }
.signals-foot-hints { row-gap: ${step}; }
.activity-indicator { gap: ${step}; }
.tab-running { margin-right: ${step}; }
`

const meta: Meta = { title: 'Proposals/D17 Off-scale values/2px steps', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · 2 px na 20 místech',
	render: () => (
		<Proposal
			decision="D17"
			variant="Current · 2 px na 20 místech"
			note="2 px drží pohromadě dvojice uvnitř jedné komponenty: tečky a čárky kreslených značek, popisek nad hodnotou, položky seznamu, dvě ikonová tlačítka vedle sebe. §2.3 ho dnes povoluje jen ve stopě segmentového přepínače a v pruhu odpočtu."
			facts={[
				'2 px: 20 pravidel (D17 v lint baseline)',
				'kreslené značky: tečky indikátoru 2 + 2, pruh agentů 8 + 2, Braille',
				'text nad textem: 7 (nadtitulek, dt/dd, zkratka, seznam v docku)',
				'odznak Background a čipy 2 × 8 už rozhodnuty (§9 ruling 26, 98)',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · 2 → 4 (nejbližší krok)',
	render: () => (
		<Proposal
			decision="D17"
			variant="A · 2 → 4 (nejbližší krok, remíza nahoru jako u D8)"
			note="Všech 20 míst dostane 4. Kreslené značky se roztáhnou (indikátor 6 × 10 → 8 × 14 px, Braille 6 × 10 → 8 × 14), dvojice textů se od sebe odlepí, dvě ikonová tlačítka v řádku fronty se rozestoupí."
			facts={[
				'indikátor činnosti 6 × 10 → 8 × 14 px',
				'pruh agentů: 3 agenti 28 → 32 px',
				'řádky Run Context lišty o 2 px vyšší',
				'seznam v docku o 2 px na položku řidší',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={rules('4px')} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · 2 → 0',
	render: () => (
		<Proposal
			decision="D17"
			variant="B · 2 → 0 (druhý nejbližší krok)"
			note="Všech 20 míst dostane 0. Text nad textem drží jen výška řádku; kreslené značky slijí do bloku (tečky indikátoru, segmenty pruhu agentů), tlačítka v řádku fronty se dotknou."
			facts={[
				'indikátor činnosti 6 × 10 → 4 × 6 px, tečky bez mezery',
				'pruh agentů: 3 agenti 28 → 24 px, segmenty splynou',
				'dt/dd a nadtitulek o 2 px těsněji',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={rules('0px')} />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · 2 jako krok uvnitř komponenty (doporučuji)',
	render: () => (
		<Proposal
			decision="D17"
			variant="C · 2 jako krok uvnitř komponenty (doporučuji)"
			note="Vypadá stejně jako Current, jen pravidlo: §2.3 přidá 2 ke krokům 6 a 10, jen uvnitř komponenty (kreslené značky, popisek nad hodnotou, sousední ikony, položky seznamu), nikdy mezi sekcemi nebo od okraje."
			facts={['žádný pixel se nemění', '20 lint výjimek zmizí, lint přijme 2 jako 6 a 10']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}
