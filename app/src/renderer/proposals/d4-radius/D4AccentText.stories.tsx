// D4 (second question) — `--accent-text` is used once (sidebar.css `.shortcut-recording`) but never defined and has no
// fallback, so the "Recording …" line inherits its parent's colour (docs/plans/design-system/proposals/D4.md).
// Every variant mounts the real Settings → Terminal page and starts a real shortcut recording.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { composeStories } from '@storybook/react-vite'
import * as SidebarStories from '../../sidebar/SidebarViews.stories'
import { ratio } from '../contrast'
import { Proposal, type TokenOverrides } from '../proposal'

const { TerminalSettings } = composeStories(SidebarStories)

// Production values (styles.css :root): the sidebar pane behind the Shortcuts card (--pane), the accent and the inherited --text-0 (measured).
const PANE = '#141517'
const ACCENT = '#4c9aff'
const TEXT_0 = '#ececee'

const DEFINED: TokenOverrides = { '--accent-text': 'var(--accent)' }

/** Variant B rules "no accent": the use becomes the colour it inherits today. */
const INHERIT_CSS = `
.proposal-stage .shortcut-recording { color: var(--text-0); }
`

async function waitFor<T extends Element>(find: () => T | null | undefined, what: string): Promise<T> {
	const deadline = Date.now() + 8000
	for (;;) {
		const found = find()
		if (found) return found
		if (Date.now() > deadline) throw new Error(`D4 accent text story: ${what} did not appear`)
		await new Promise(resolve => setTimeout(resolve, 50))
	}
}

/** Starts a real recording: the story bridge answers at once, so hold the recorder open for this story. */
async function startRecording({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> {
	const change = await waitFor(
		() => canvasElement.querySelector<HTMLButtonElement>('.shortcut-alias button[aria-label^="Change"]:not(:disabled)'),
		'shortcut Change button',
	)
	window.helm.terminalPreferences.recordShortcut = () => new Promise(() => {})
	change.click()
	await waitFor(() => canvasElement.querySelector('.shortcut-recording'), 'recording line')
}

const meta: Meta = {
	title: 'Proposals/D4 Accent text',
	parameters: { layout: 'fullscreen' },
	play: startRecording,
}

export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · zděděná barva (token nedefinovaný)',
	render: () => (
		<Proposal
			decision="D4"
			variant="Current · zděděná barva"
			note="Dnes: --accent-text není definovaný a nemá fallback, takže řádek „Recording …“ v Settings → Terminal → Shortcuts dědí barvu textu karty."
			facts={[
				'--accent-text: nedefinováno',
				`.shortcut-recording = --text-0 ${TEXT_0}`,
				`na pane ${ratio(TEXT_0, PANE)}`,
			]}
		>
			<TerminalSettings />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · --accent-text = --accent (doporučuji)',
	render: () => (
		<Proposal
			decision="D4"
			variant="A · definovat --accent-text jako --accent (doporučuji)"
			note="Řádek nahrávání dostane akcentovou barvu, jak autor CSS zamýšlel: je vidět, že klávesy teď jdou do nahrávání. Splňuje AA."
			facts={[`--accent-text: var(--accent) ${ACCENT}`, `na pane ${ratio(ACCENT, PANE)}`]}
			overrides={DEFINED}
		>
			<TerminalSettings />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · bez akcentu pravidlem',
	render: () => (
		<Proposal
			decision="D4"
			variant="B · bez akcentu pravidlem"
			note="Použití přepsat na color: var(--text-0) a token nezavádět. Vypadá stejně jako Current; mění se jen kód."
			facts={[`.shortcut-recording = --text-0 ${TEXT_0}`, `na pane ${ratio(TEXT_0, PANE)}`]}
			css={INHERIT_CSS}
		>
			<TerminalSettings />
		</Proposal>
	),
}
