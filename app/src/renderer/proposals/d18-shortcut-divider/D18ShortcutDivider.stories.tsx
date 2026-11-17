// D18 · Shortcut alias divider (docs/plans/design-system/spec.md § Open decisions). Settings → Terminal draws every
// shortcut alias as a key well with two targets (change, remove ×); `sidebar.css` separates them with a 1px
// `--hairline` border-left on the second button, which §9 ruling 4 (no button borders) forbids. Frames are the real
// Views / Sidebar / Terminal settings story; each variant appends only its own rules.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { HELM_TOKENS, HIGH_CONTRAST_TOKENS } from '../../../design-tokens.generated'
import { over, ratio } from '../contrast'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameSpec, row } from './frame'

const token = (tokens: Readonly<Record<string, string>>, name: string) => {
	const value = tokens[name]
	if (value === undefined) throw new Error(`D18: missing token ${name}`)
	return value
}

/** A white rgba(…) token composited over the pane, as #rrggbb. */
const onPane = (tokens: Readonly<Record<string, string>>, name: string) => {
	const alpha = Number(/rgba\(255, 255, 255, ([\d.]+)\)/.exec(token(tokens, name))?.[1])
	if (!Number.isFinite(alpha)) throw new Error(`D18: ${name} is not a white rgba`)
	return over('#ffffff', alpha, token(tokens, '--pane'))
}

const HAIRLINE = `čára --hairline na --pane ${ratio(onPane(HELM_TOKENS, '--hairline'), token(HELM_TOKENS, '--pane'))} (High contrast ${ratio(onPane(HIGH_CONTRAST_TOKENS, '--hairline'), token(HIGH_CONTRAST_TOKENS, '--pane'))})`
const HOVER_FILL = `hover --fill-subtle na --pane ${ratio(onPane(HELM_TOKENS, '--fill-subtle'), token(HELM_TOKENS, '--pane'))}`

const alias = (doc: Document) => row(doc, 'Previous terminal')?.querySelector('.shortcut-alias')

const FRAMES: readonly FrameSpec[] = [
	{
		label: 'Řádek Previous terminal · dva aliasy, Add, Reset',
		pick: doc => row(doc, 'Previous terminal'),
		pad: 6,
		zoom: 2,
	},
	{ label: 'Jeden alias ⌥⌘← · v klidu', pick: alias, pad: 4, zoom: 5 },
	{ label: 'Jeden alias ⌥⌘← · kurzor na ×', pick: alias, pad: 4, zoom: 5, hoverRemove: true },
	{
		label: 'Settings → Terminal · tři řádky v okně',
		pick: doc =>
			['Previous terminal', 'Next terminal', 'Bigger text']
				.map(label => row(doc, label))
				.filter((element): element is Element => element !== null),
		pad: 8,
		zoom: 1,
	},
]

/** Pixel-identical replacement of the border: a 1px flex item between the two buttons (the group's ::before). */
const SEPARATOR_CSS = `
.shortcut-alias button + button { border-left: 0; order: 2; }
.shortcut-alias button:first-child { order: 0; }
.shortcut-alias::before { content: ''; order: 1; flex: none; align-self: stretch; width: 1px; background: var(--hairline); }
`

const NO_DIVIDER_CSS = `
.shortcut-alias button + button { border-left: 0; }
.shortcut-alias button:hover:not(:disabled),
.shortcut-alias button[data-d18-hover] { background: var(--fill-subtle); }
`

const meta: Meta = { title: 'Proposals/D18 Shortcut alias divider', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D18"
			variant="Current · border-left na tlačítku ×"
			note="Jamka zkratky má dva cíle: změnit zkratku a odebrat ×. Čára mezi nimi je 1px okraj (border-left) tlačítka ×, a to §9 ruling 4 zakazuje. Najetí kurzorem dnes nic nemění, tlačítka nemají hover."
			facts={[
				HAIRLINE,
				'jamka 28px (tlačítka 26 + rámeček), rádius 4, padding tlačítek 0 6',
				'cíl × 20×26px (19 + čára 1)',
				'lint: 1 položka button-border v baseline (D18)',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · oddělovač jako samostatný prvek (doporučuji)',
	render: () => (
		<Proposal
			decision="D18"
			variant="A · oddělovač jako samostatný prvek (doporučuji)"
			note="Vypadá stejně. Čáru nekreslí okraj tlačítka, ale samostatný 1px prvek mezi tlačítky. Doporučuji: vzhled i dva oddělené cíle zůstanou a ruling 4 platí bez výjimky."
			facts={[
				HAIRLINE,
				'pixely shodné s Current',
				'kód: +1 span (aria-hidden) v TerminalSettingsPage.tsx, pravidlo v sidebar.css; v příběhu jako ::before jamky',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={SEPARATOR_CSS} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · výjimka v ruling 4 pro skupinu tlačítek',
	render: () => (
		<Proposal
			decision="D18"
			variant="B · výjimka v ruling 4 pro skupinu tlačítek"
			note="Vypadá stejně, jen pravidlo. Ruling 4 dostane výjimku: čára mezi tlačítky jedné skupiny smí být border. Lint by se musel naučit, co je skupina (dnes pozná jen tlačítko)."
			facts={[HAIRLINE, 'pixely shodné s Current', 'kód beze změny; lint pravidlo button-border + výjimka']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · bez čáry, hover na každém cíli',
	render: () => (
		<Proposal
			decision="D18"
			variant="C · bez čáry, hover na každém cíli"
			note="Čára zmizí, jamka je jeden klidný tvar jako token v macOS. Aby šly dva cíle poznat, dostane každé tlačítko hover výplň --fill-subtle (dnes nemají žádný hover). V klidu nejde poznat, kde končí cíl změny a začíná ×."
			facts={[HOVER_FILL, 'mezera mezi zkratkou a × 12px (2 × padding 6)', 'cíl × 19×26px', 'kód: jen sidebar.css']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={NO_DIVIDER_CSS} />
		</Proposal>
	),
}
