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
 * The topbar's Background terminals toggle while a parked terminal is shown in the pane: today it
 * only names it ("okena"); four candidate active looks. Each variant is the production CSS under a
 * story-only `data-bg-active-variant` ancestor, so the app stays unchanged until one is picked.
 *
 * "Open" in code: `activeTab?.parked` (a background terminal shown in the main area, opened from the
 * dialog's row) unhides #bg-current. The dialog itself is `aria-expanded="true"`, which already has
 * production's pressed look (fill-subtle). While a parked terminal is shown, no strip tab is active.
 */

type Variant = 'today' | 'fill' | 'accent' | 'tab' | 'rail'
type LiveState = 'closed' | 'viewing' | 'viewing-long' | 'dialog' | 'dialog-closed'

const VARIANTS: ReadonlyArray<{ id: Variant; label: string; note: string }> = [
	{ id: 'today', label: 'Today', note: 'production: name only' },
	{ id: 'fill', label: 'B1 fill', note: 'active-tab fill, --text-0' },
	{ id: 'accent', label: 'B2 accent', note: 'icon + name --accent' },
	{ id: 'tab', label: 'B3 tab-like', note: 'the toggle is the tab' },
	{ id: 'rail', label: 'B4 rail', note: 'quiet fill + accent rail' },
]

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
	variant: Variant
	state: LiveState
	theme: keyof typeof THEME_PRESETS
}

/** The real mount (one workspace): the dialog opens, its row shows the terminal, like a pointer. */
function LiveTopbar({ variant, state, theme }: LiveProps) {
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
	return (
		<div data-bg-active-variant={variant === 'today' ? undefined : variant}>
			<TerminalWorkspaceFixtureView options={options} />
		</div>
	)
}

// ---------- static matrix (every variant × state side by side, no terminals mounted) ----------

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

const CELL_WIDTH = 300

/** One topbar right end: a strip tab, the drag gutter, and the production #bg-root markup. */
function ToggleCell({ state }: { state: CellState }) {
	const hostRef = useRef<HTMLDivElement>(null)
	const viewing = state.startsWith('viewing')
	useEffect(() => {
		const host = hostRef.current
		if (!host) return
		const bgRoot = backgroundRootNode()
		const toggle = bgRoot.querySelector<HTMLButtonElement>('#bg-toggle')
		const current = bgRoot.querySelector<HTMLElement>('#bg-current')
		const count = bgRoot.querySelector<HTMLElement>('#bg-count')
		if (!toggle || !current || !count) return
		const name = state === 'viewing-long' ? LONG_NAME : viewing ? SHORT_NAME : null
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
	}, [state, viewing])
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
			<div className="tab-strip-controls">
				{/* While a parked terminal is shown, the strip has no active tab (activate() only marks strip tabs). */}
				<div className={`tab${viewing ? '' : ' active'}`}>
					<span className="tab-label">helm</span>
					<span className="tab-close" aria-hidden="true">
						×
					</span>
				</div>
			</div>
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

function MatrixSection({ theme }: { theme: keyof typeof THEME_PRESETS }) {
	return (
		<section data-matrix-theme={theme} style={themeStyle(theme)}>
			<div style={{ marginBottom: 12 }}>
				<Label strong>{THEME_PRESETS[theme]?.name ?? theme}</Label>
			</div>
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: `150px repeat(${VARIANTS.length}, ${CELL_WIDTH}px)`,
					columnGap: 12,
					rowGap: 8,
					alignItems: 'center',
				}}
			>
				<div />
				{VARIANTS.map(variant => (
					<div key={variant.id}>
						<Label strong>{variant.label}</Label>
						<Label>{variant.note}</Label>
					</div>
				))}
				{CELL_STATES.map(state => (
					<div key={state.id} style={{ display: 'contents' }}>
						<Label>{state.note}</Label>
						{VARIANTS.map(variant => (
							<div key={variant.id} data-bg-active-variant={variant.id} data-cell={`${variant.id}-${state.id}`}>
								<ToggleCell state={state.id} />
							</div>
						))}
					</div>
				))}
			</div>
		</section>
	)
}

/** Variants (columns) × states (rows) in both shipped themes; each cell is the topbar's right end. */
function MatrixView() {
	return (
		<div style={{ display: 'inline-flex', flexDirection: 'column', gap: 1, background: 'var(--hairline)' }}>
			<MatrixSection theme="helm" />
			<MatrixSection theme="high-contrast" />
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
		variant: { control: 'inline-radio', options: VARIANTS.map(variant => variant.id) },
		state: {
			control: 'inline-radio',
			options: ['closed', 'viewing', 'viewing-long', 'dialog', 'dialog-closed'] satisfies LiveState[],
		},
		theme: { control: 'inline-radio', options: Object.keys(THEME_PRESETS) },
	},
	args: { variant: 'today', state: 'viewing', theme: 'helm' },
}

export default meta
type Story = StoryObj<typeof LiveTopbar>

/** Production today: "okena" is named, but the control looks like any idle button. */
export const Today: Story = { args: { variant: 'today' } }

/** B1: the active tab's --fill-raised (the dock's open entry uses the same), name --text-0; hover/dialog step to --fill-strong. */
export const B1Fill: Story = { name: 'B1 fill', args: { variant: 'fill' } }

/** B2: no fill; icon and name in --accent, the count stays neutral; hover/dialog add production's fill-subtle. */
export const B2Accent: Story = { name: 'B2 accent', args: { variant: 'accent' } }

/** B3: the toggle becomes the shown terminal's tab: active-tab fill, 13px tab type, the count as a dim tab-number. */
export const B3TabLike: Story = { name: 'B3 tab-like', args: { variant: 'tab' } }

/** B4: quiet --fill-subtle plus a 2px --accent rail along the bottom edge; hover/dialog step to --fill-raised. */
export const B4Rail: Story = { name: 'B4 rail', args: { variant: 'rail' } }

/** Every variant × state (closed, hover, dialog, short/long name, keyboard focus) in Helm and High contrast. */
export const Matrix: Story = {
	render: () => <MatrixView />,
	parameters: { controls: { disable: true } },
}
