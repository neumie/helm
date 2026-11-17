// D17 · Component dimensions (docs/plans/design-system/proposals/D17.md §3): 14/18/22/28/36/40/44/48/68 and the
// 84/90 traffic-light reserve are padding/margin values off §2.3 (largest step 32). Some are component metrics a
// §3 spec already names (md button 0 14 §3.1, terminal well 14 §3.14, traffic-light reserve 84 §3.14/§3.30 and
// 90 §3.26); others are plain spacing between parts. Frames show the ones whose pixels a variant changes; the
// reserves, Remote's 44/68 header, the viewer's 48 and the reading margins 40/80 stay in every variant.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameSpec } from './frame'

const FRAMES: readonly FrameSpec[] = [
	{
		id: 'primitives-button--tones',
		label: 'Tlačítko md · odsazení dnes 0 14 (§3.1)',
		width: 600,
		height: 200,
		zoom: 3,
		crop: { selector: '.btn', pad: 8 },
	},
	{
		id: 'primitives-field--select',
		label: 'Select · místo pro šipku vpravo, dnes 28',
		width: 460,
		height: 300,
		zoom: 2,
		crop: { selector: '.select', pad: 8 },
	},
	{
		id: 'views-agent-dock-turn-message--markdown',
		label: 'Dock · odsazení seznamu, dnes 18',
		width: 1200,
		height: 800,
		zoom: 1.5,
		crop: { selector: '.agent-dock-md ul', pad: 24, width: 420 },
	},
	{
		id: 'views-helm-remote--reading',
		label: 'Remote (telefon) · odsazení bubliny zprávy, dnes 8 14',
		width: 390,
		height: 700,
		zoom: 2,
		crop: { selector: '.remote-message[data-role="user"] .remote-user-text', pad: 12 },
	},
	{
		id: 'views-signals-column--column',
		label: 'Signals · mezera mezi sekcemi, dnes 28',
		width: 420,
		height: 800,
		zoom: 1.5,
		// Anchored on the last row ABOVE the gap, so a changed gap moves the next section within the crop.
		crop: {
			find: ({ doc }) => [...(doc.querySelector('.signals-section')?.querySelectorAll('.signals-tr') ?? [])].at(-1),
			pad: 0,
			height: 110,
		},
	},
	{
		id: 'views-sidebar--terminal-settings',
		label:
			'Settings → Terminal · mezera nad další skupinou zkratek, dnes 14; čára vlevo je výchozí okraj fieldsetu, mimo D17',
		width: 460,
		height: 900,
		zoom: 2,
		// The first group ends below the fold: scroll its last shortcut to the middle of the page.
		setup: async ({ doc }) => {
			doc.querySelector('.shortcut-scope')?.lastElementChild?.scrollIntoView({ block: 'center' })
		},
		crop: {
			find: ({ doc }) => doc.querySelector('.shortcut-scope')?.lastElementChild,
			pad: 0,
			height: 90,
		},
	},
	{
		id: 'views-run-context-editor--source-context',
		label: 'Run Context · horní odsazení dokumentu, dnes 28',
		width: 1100,
		height: 600,
		zoom: 1.5,
		crop: { selector: '.run-context-editor', pad: 0, width: 520, height: 110 },
	},
]

/** Shared by A and B: plain spacing between parts, to the nearest step (ties up, as in D8). */
const SPACING = `
.signals-section + .signals-section { margin-top: 32px; }
.signals-section .signals-tr { scroll-margin-top: 32px; }
/* Not the section count mark: it resets its margin with .signals-braille-mark, which this rule would beat. */
.signals-braille:not(.signals-braille-mark) { margin-bottom: 16px; }
.signals-foot-hints { column-gap: 16px; }
.shortcut-scope:not(:first-child) { margin-top: 16px; }
.run-context-dialog { padding: 24px; }
.run-context-dialog p, .run-context-start-state p { margin: 8px 0 24px; }
.run-context-editor { padding-top: 32px; padding-bottom: 32px; }
.remote-sheet { padding-top: 20px; }
`

/** A: every value up to 32 on the scale, component metrics too. */
const ALL_SNAPPED = `${SPACING}
.btn:not(.btn-sm) { padding: 0 16px; }
.select { padding-right: 32px; }
.agent-dock-md :is(ul, ol), .agent-dock-md blockquote { padding-left: 20px; }
.remote-message[data-role="user"] .remote-user-text { padding: 8px 16px; }
.remote-transcript { padding-bottom: calc(32px + var(--remote-composer-overlap, 76px)); }
`

const meta: Meta = {
	title: 'Proposals/D17 Off-scale values/Component dimensions',
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · 14 / 18 / 22 / 28 a větší',
	render: () => (
		<Proposal
			decision="D17"
			variant="Current · 14 / 18 / 22 / 28 a větší"
			note="Část jsou rozměry komponent, které §3 už jmenuje (tlačítko 0 14, studna terminálu 14, rezerva semaforu 84 / 90). Zbytek jsou obyčejné mezery mezi částmi (sekce Signals 28, skupiny zkratek 14, dialog Run Context 22)."
			facts={[
				'30 lint výjimek mimo 2 px (pravidlo s více hodnotami počítáno jednou)',
				'14 ×8, 18 ×3, 22 ×2, 28 ×5, větší 36 / 40 / 44 / 48 / 68 / 80',
				'rezerva semaforu 84 ×2 (cockpit, Run Context), 90 ×2 (Document Review); 84 i místo pro akce řádku fronty',
				'pozice semaforu se liší podle okna (x 14 / 14 / 16), proto 84 vs 90',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · vše do 32 na stupnici',
	render: () => (
		<Proposal
			decision="D17"
			variant="A · vše do 32 na stupnici (remíza nahoru)"
			note="14 → 16, 18 → 20, 22 → 24, 28 → 32, i u komponent: tlačítka o 4 px širší, šipka selectu dál od textu, seznam v docku a bublina Remote širší. Hodnoty nad 32 (36–90) stupnice nepokryje, ty zůstanou rozměrem komponenty."
			facts={[
				'md tlačítko 0 14 → 0 16 (Approve and queue 148 → 152 px)',
				'select 28 → 32, odsazení seznamu v docku 18 → 20',
				'bublina Remote 8 14 → 8 16',
				'sekce Signals 28 → 32, skupiny zkratek 14 → 16, editor Run Context 28 → 32',
				'mění §3.1 (tlačítko 0 14) a ruling 88 (widget)',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={ALL_SNAPPED} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · rozměry komponent v §3, mezery na stupnici (doporučuji)',
	render: () => (
		<Proposal
			decision="D17"
			variant="B · rozměry komponent v §3, mezery na stupnici (doporučuji)"
			note="Co patří k tvaru komponenty, zůstane a zapíše se do jejího §3: tlačítko 0 14, select 28, odsazení seznamu 18, bublina 8 14, studna 14, semafor 84 / 90, hlavička Remote 44 / 68. Mezery mezi částmi se zaokrouhlí: sekce Signals 32, skupiny zkratek 16, editor Run Context 32."
			facts={[
				'tlačítko, select, seznam v docku, bublina: beze změny',
				'sekce Signals 28 → 32, tečky prázdného seznamu 14 → 16, nápovědy kláves 14 → 16',
				'skupiny zkratek 14 → 16, dialog Run Context 22 → 24',
				'editor Run Context nahoře 28 → 32, sheet Remote 18 → 20',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={SPACING} />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · vše zapsat jako rozměry komponent',
	render: () => (
		<Proposal
			decision="D17"
			variant="C · vše zapsat jako rozměry komponent"
			note="Vypadá stejně jako Current, jen pravidlo: každá hodnota dostane řádek v §3 své komponenty, i mezery mezi sekcemi Signals nebo skupinami zkratek."
			facts={['žádný pixel se nemění', 'všech 30 výjimek přejde z D17 na §3 řádky']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}
