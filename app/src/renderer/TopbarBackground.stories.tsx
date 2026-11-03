import type { Meta, StoryObj } from '@storybook/react-vite'
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef } from 'react'
import type { RestoredSession } from '../shared'
import { THEME_PRESETS } from '../theme-presets'
import {
	type TerminalWorkspaceFixtureOptions,
	TerminalWorkspaceFixtureView,
	backgroundRootNode,
} from './terminal-workspace-fixtures'

/**
 * The topbar's Background terminals control (§3.18 "Strip control"). While a parked terminal is
 * shown in the pane (`activeTab?.parked` unhides #bg-current), the strip has no active tab, so the
 * control takes the active tab's look: tab padding, --fill-raised, the name in 13px tab type, the
 * count as a dim tab-number. Closed it is the quiet ghost button with the count chip. The dialog
 * is `aria-expanded="true"`; drag affordances (.drag-ready/.drag-over) keep precedence.
 */

type LiveState = 'closed' | 'viewing' | 'viewing-long' | 'dialog' | 'dialog-closed'

const SHORT_NAME = 'okena'
const LONG_NAME = 'claude · terminal placement refactor and background groups'

function session(sessionId: string, name: string, parked: boolean): RestoredSession {
	return {
		sessionId,
		title: name,
		customName: name,
		parked,
		groupId: null,
		agentRunning: false,
		agentAttention: false,
		placementEligible: true,
	}
}

function liveSessions(): RestoredSession[] {
	return [
		session('helm', 'helm', false),
		session('dev', 'dev server', false),
		session('okena', SHORT_NAME, true),
		session('long', LONG_NAME, true),
		session('logs', 'release logs', true),
	]
}

interface LiveProps {
	/** closed: a strip tab is active · viewing: a parked terminal is shown · dialog: + dialog open. */
	state: LiveState
	theme: keyof typeof THEME_PRESETS
}

/** The real mount (one workspace): the dialog opens, its row shows the terminal, like a pointer. */
function LiveTopbar({ state, theme }: LiveProps) {
	const options = useMemo<TerminalWorkspaceFixtureOptions>(
		() => ({
			sessions: liveSessions(),
			groups: [],
			theme,
			...(state === 'closed' || state === 'dialog-closed'
				? {}
				: { viewBackground: state === 'viewing-long' ? 'long' : 'okena' }),
			openBackground: state === 'dialog' || state === 'dialog-closed',
		}),
		[state, theme],
	)
	return <TerminalWorkspaceFixtureView options={options} />
}

// ---------- states grid (every state side by side in both themes, no terminals mounted) ----------

type CellState =
	| 'closed'
	| 'closed-hover'
	| 'closed-dialog'
	| 'viewing'
	| 'viewing-long'
	| 'viewing-hover'
	| 'viewing-focus'
	| 'viewing-dialog'

const CELL_STATES: ReadonlyArray<{ id: CellState; note: string }> = [
	{ id: 'closed', note: 'Closed' },
	{ id: 'closed-hover', note: 'Closed · hover' },
	{ id: 'closed-dialog', note: 'Closed · dialog open' },
	{ id: 'viewing', note: 'Viewing “okena”' },
	{ id: 'viewing-long', note: 'Viewing · long name' },
	{ id: 'viewing-hover', note: 'Viewing · hover' },
	{ id: 'viewing-focus', note: 'Viewing · keyboard focus' },
	{ id: 'viewing-dialog', note: 'Viewing · dialog open' },
]

const THEMES: ReadonlyArray<keyof typeof THEME_PRESETS> = ['helm', 'high-contrast']

const CELL_WIDTH = 300

/** One topbar right end: the drag gutter and the production #bg-root markup in a given state. */
function ToggleCell({ state }: { state: CellState }) {
	const hostRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const host = hostRef.current
		if (!host) return
		const bgRoot = backgroundRootNode()
		const toggle = bgRoot.querySelector<HTMLButtonElement>('#bg-toggle')
		const current = bgRoot.querySelector<HTMLElement>('#bg-current')
		const count = bgRoot.querySelector<HTMLElement>('#bg-count')
		if (!toggle || !current || !count) return
		const name = state === 'viewing-long' ? LONG_NAME : state.startsWith('viewing') ? SHORT_NAME : null
		toggle.hidden = false
		toggle.tabIndex = -1
		current.hidden = name === null
		current.textContent = name ?? ''
		count.textContent = '3'
		toggle.title = name ? `Background terminals — viewing ${name}` : 'Background terminals'
		toggle.setAttribute('aria-expanded', String(state.endsWith('dialog')))
		const preview = state.endsWith('hover') ? 'hover' : state.endsWith('focus') ? 'focus' : null
		if (preview) toggle.dataset.bgPreview = preview
		host.replaceChildren(bgRoot)
		return () => host.replaceChildren()
	}, [state])
	return (
		<div
			className="topbar-right"
			style={{
				width: CELL_WIDTH,
				height: 38,
				background: 'var(--chrome)',
				borderBottom: '1px solid var(--hairline)',
			}}
		>
			<div className="topbar-drag-space" />
			<div ref={hostRef} style={{ display: 'contents' }} />
		</div>
	)
}

const Label = ({ children, strong = false }: { children: ReactNode; strong?: boolean }) => (
	<div
		style={{
			font: '11px/16px -apple-system, BlinkMacSystemFont, sans-serif',
			color: strong ? 'var(--text-1)' : 'var(--text-2)',
			fontWeight: strong ? 600 : 400,
			whiteSpace: 'nowrap',
		}}
	>
		{children}
	</div>
)

/** Story-scoped preset tokens (+ the derived soft fills, which compute where they are declared). */
function themeStyle(theme: keyof typeof THEME_PRESETS): CSSProperties {
	return {
		...(THEME_PRESETS[theme]?.tokens ?? {}),
		'--accent-soft': 'color-mix(in srgb, var(--accent) 15%, transparent)',
		'--neutral-soft': 'color-mix(in srgb, var(--neutral) 15%, transparent)',
		background: 'var(--pane)',
		padding: 20,
	} as CSSProperties
}

function ThemeColumn({ theme }: { theme: keyof typeof THEME_PRESETS }) {
	return (
		<section data-states-theme={theme} style={themeStyle(theme)}>
			<div style={{ marginBottom: 12 }}>
				<Label strong>{THEME_PRESETS[theme]?.name ?? theme}</Label>
			</div>
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: `150px ${CELL_WIDTH}px`,
					columnGap: 12,
					rowGap: 8,
					alignItems: 'center',
				}}
			>
				{CELL_STATES.map(state => (
					<div key={state.id} style={{ display: 'contents' }}>
						<Label>{state.note}</Label>
						<div data-cell={state.id}>
							<ToggleCell state={state.id} />
						</div>
					</div>
				))}
			</div>
		</section>
	)
}

/** Every state (closed, hover, dialog, short/long name, keyboard focus) in Helm and High contrast. */
function StatesView() {
	return (
		<div style={{ display: 'inline-flex', gap: 1, background: 'var(--hairline)' }}>
			{THEMES.map(theme => (
				<ThemeColumn key={theme} theme={theme} />
			))}
		</div>
	)
}

const meta: Meta<typeof LiveTopbar> = {
	title: 'Views/Topbar background terminals',
	component: LiveTopbar,
	globals: { viewport: { value: 'helm1280', isRotated: false } },
	parameters: {
		layout: 'fullscreen',
		viewport: { options: { helm1280: { name: 'Helm 1280×800', styles: { width: '1280px', height: '800px' } } } },
	},
	argTypes: {
		state: {
			control: 'inline-radio',
			options: ['closed', 'viewing', 'viewing-long', 'dialog', 'dialog-closed'] satisfies LiveState[],
		},
		theme: { control: 'inline-radio', options: Object.keys(THEME_PRESETS) },
	},
	args: { state: 'viewing', theme: 'helm' },
}

export default meta
type Story = StoryObj<typeof LiveTopbar>

/** The real workspace with a parked terminal shown in the pane; switch state/theme from the controls. */
export const BackgroundTerminals: Story = { name: 'Background terminals' }

/** Every state of the control in Helm and High contrast. */
export const States: Story = {
	render: () => <StatesView />,
	parameters: { controls: { disable: true } },
}
