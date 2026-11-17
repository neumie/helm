// D15/1 Meta text on fills — `--text-2` (and the dock's `--dock-dim`) on a hovered, pressed or open row, on the
// active or hovered tab and in a field's placeholder. See docs/plans/design-system/proposals/D15.md.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameSpec, mark, waitFor } from './frame'
import { META_LIFT, S, dockDim, helm, high, ratio, rootTokens, surface } from './values'

/** Rows: 1 rest, 2 hover, 3 pressed, 4 hover (the rows' own `data-force-state`, as StateGrid sets it). */
const rowStates = async ({ doc }: { doc: Document }) => {
	await mark(doc, '.item-row', 'data-force-state', 'hover', [1, 3])
	await mark(doc, '.item-row', 'data-force-state', 'active', [2])
}

/** Dock: opens the entry with a young (dim) wait and hovers the next one, so both show `--dock-dim` on a fill. */
const dockStates = async ({ doc }: { doc: Document }) => {
	const entry = (name: string) =>
		waitFor(
			() => [...doc.querySelectorAll<HTMLElement>('.agent-dock-entry')].find(e => e.textContent?.includes(name)),
			name,
		)
	;(await entry('ios-release')).click()
	;(await entry('ios-sync')).setAttribute('data-d15-hover', '')
}

const FRAMES: readonly FrameSpec[] = [
	{
		id: 'compositions-list-row--verdict-rows',
		label: 'Seznam práce · řádek 1 klid, 2 a 4 hover, 3 stisk; čas „12m“ je --text-2',
		width: 380,
		height: 340,
		zoom: 2,
		crop: { selector: '.list-scroll', pad: 0 },
		setup: rowStates,
	},
	{
		id: 'views-tab-numbers--build-expanded',
		label: 'Lišta terminálů · číslo ⌘N (--text-2) na aktivní kartě a na kartě „dev server“ v hoveru',
		width: 1100,
		height: 160,
		zoom: 2,
		crop: { selector: '#tabs', pad: 4 },
		setup: async ({ doc }) => mark(doc, '.tab:not(.active)', 'data-d15-hover', '', [1]),
	},
	{
		id: 'views-terminal-workspace--agent-dock-question',
		label: 'Agent dock · otevřená „ios-release“ (--fill-raised) a „ios-sync“ v hoveru; čekání je --dock-dim',
		width: 1280,
		height: 760,
		zoom: 2,
		crop: { selector: '.agent-dock-queue', pad: 6 },
		setup: dockStates,
	},
	{
		id: 'views-signals-column--column',
		label: 'Signals · první řádek vybraný (--fill-raised); stáří „8m“ a jméno agenta jsou --dock-dim',
		width: 520,
		height: 560,
		zoom: 2,
		crop: { selector: '.signals-section', pad: 0 },
		// The column lays out its sections after mount; measure the selected row once it has settled.
		setup: async ({ doc }) => {
			await waitFor(() => doc.querySelector('.signals-tr[data-selected="true"]'), 'selected signal')
			await new Promise(resolve => setTimeout(resolve, 1500))
		},
	},
	{
		id: 'primitives-field--text-inputs',
		label: 'Pole · placeholder (--text-2 na --fill-subtle)',
		width: 420,
		height: 240,
		zoom: 1.6,
	},
	{
		id: 'views-helm-remote--row-density',
		label: 'Helm Remote · první řádek v hoveru; popisky Group / Project / Branch jsou --text-2',
		width: 1100,
		height: 700,
		zoom: 1.4,
		crop: { selector: '.remote-session-entry', pad: 4 },
		setup: async ({ doc }) => mark(doc, '.remote-session-entry', 'data-d15-hover', '', [0]),
	},
	{
		id: 'compositions-list-row--verdict-rows',
		label: 'Seznam práce · stejné stavy',
		palette: 'high',
		width: 380,
		height: 340,
		zoom: 2,
		crop: { selector: '.list-scroll', pad: 0 },
		setup: rowStates,
	},
	{
		id: 'views-terminal-workspace--agent-dock-question',
		label: 'Agent dock · otevřená položka a hover',
		palette: 'high',
		width: 1280,
		height: 760,
		zoom: 2,
		crop: { selector: '.agent-dock-queue', pad: 6 },
		setup: dockStates,
	},
]

/** A: on a fill, a row's dim text steps up one rung (`--text-2` and `--dock-dim` become `--text-1`), the way the
 *  selected segment's count already does (`.segment-active .segment-count`); placeholders are `--text-1`. */
const STEP_UP = `
.item-row:is(:hover, :active, [data-force-state~="hover"], [data-force-state~="active"]),
.tab:is(:hover, .active, [data-d15-hover]),
:is(.agent-dock-entry, .agent-dock-more, .agent-dock-agents-entry):is(:hover, :focus, [data-open="true"], [data-d15-hover]),
.remote-session-entry:is(:hover, [data-d15-hover], :has(.remote-session-row[aria-current="page"])),
.signals-tr:is(:hover, [data-selected="true"]),
.bg-row:is(:hover, .active) {
	--text-2: var(--text-1);
	--dock-dim: var(--text-1);
}
.input::placeholder { color: var(--text-1); }
`

const LIFT = `${rootTokens({ '--text-2': META_LIFT.helm })}
:root[data-d15-palette="high"] { --text-2: ${META_LIFT.high} !important; }
`

const h = S.helm
const hc = S.high
const CURRENT_FACTS = [
	`hover řádek ${ratio(helm('--text-2'), h.input)}`,
	`stisk ${ratio(helm('--text-2'), h.selected)}`,
	`aktivní karta / otevřená položka docku ${ratio(helm('--text-2'), h.dockSelected)}`,
	`hover karta ${ratio(helm('--text-2'), h.chromeHover)}`,
	`--dock-dim na otevřené položce ${ratio(dockDim(helm('--text-1'), helm('--text-2')), h.dockSelected)}`,
	`placeholder ${ratio(helm('--text-2'), h.input)}`,
	`HC: stisk ${ratio(high('--text-2'), hc.selected)}, otevřená položka ${ratio(high('--text-2'), hc.dockSelected)}`,
]

const meta: Meta = { title: 'Proposals/D15 Contrast/Meta text on fills', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D15/1"
			variant="Current"
			note="Šedý meta text (časy, čísla karet, čekání v docku, popisky, placeholdery) má 4.5:1 jen na holé ploše. Na výplni řádku v hoveru, stisku nebo výběru klesne pod."
			facts={CURRENT_FACTS}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · na výplni o stupeň světlejší (doporučuji)',
	render: () => (
		<Proposal
			decision="D15/1"
			variant="A · na výplni o stupeň světlejší (doporučuji)"
			note="Řádek s výplní (hover, stisk, otevřená položka docku, aktivní karta) přepne svůj --text-2 a --dock-dim na --text-1; placeholder je --text-1. Stejně už to dělá počet ve vybraném segmentu. Klidový vzhled se nemění."
			facts={[
				`hover řádek ${ratio(helm('--text-1'), h.input)}`,
				`stisk ${ratio(helm('--text-1'), h.selected)}`,
				`aktivní karta / otevřená položka ${ratio(helm('--text-1'), h.dockSelected)}`,
				`hover karta ${ratio(helm('--text-1'), h.chromeHover)}`,
				`placeholder ${ratio(helm('--text-1'), h.input)} (hodnota --text-0 ${ratio(helm('--text-0'), h.input)})`,
				`HC: stisk ${ratio(high('--text-1'), hc.selected)}, otevřená položka ${ratio(high('--text-1'), hc.dockSelected)}`,
				'tokeny beze změny, jedno pravidlo pro řádky; popup rozšíření dostane stejný placeholder ve svém CSS (bez rámečku)',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={STEP_UP} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · zesvětlit --text-2 všude',
	render: () => (
		<Proposal
			decision="D15/1"
			variant="B · zesvětlit --text-2 všude"
			note={`Nejmenší posun stejného odstínu, se kterým projde i otevřená položka docku: Helm ${META_LIFT.helm}, High contrast ${META_LIFT.high}. Cena: --text-2 skoro splyne s --text-1, dvoustupňový šedý žebříček zmizí.`}
			facts={[
				`hover řádek ${ratio(META_LIFT.helm, h.input)}`,
				`stisk ${ratio(META_LIFT.helm, h.selected)}`,
				`otevřená položka ${ratio(META_LIFT.helm, h.dockSelected)}`,
				`--dock-dim tamtéž ${ratio(dockDim(helm('--text-1'), META_LIFT.helm), h.dockSelected)}`,
				`odstup od --text-1 ${ratio(helm('--text-1'), surface(META_LIFT.helm))} (dnes ${ratio(helm('--text-1'), surface(helm('--text-2')))})`,
				`HC odstup ${ratio(high('--text-1'), surface(META_LIFT.high))} (dnes ${ratio(high('--text-1'), surface(high('--text-2')))})`,
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
			decision="D15/1"
			variant="C · ponechat, výjimka"
			note="Vypadá stejně jako Current, jen pravidlo: meta na výplni řádku a placeholdery se vyjmou z 4.5:1. WCAG placeholdery nevyjímá; hover a výběr nejsou chvilkové (vybraný řádek Signals, otevřená položka docku)."
			facts={CURRENT_FACTS}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}
