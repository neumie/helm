import type { Meta, StoryObj } from '@storybook/react-vite'
import { type ReactNode, useEffect } from 'react'
import { Btn } from '../../button'
import { type TerminalWorkspaceFixture, TerminalWorkspaceFixtureView } from '../../terminal-workspace-fixtures'
import { over, ratio } from '../contrast'
import { Proposal } from '../proposal'
import { HELM, HIGH_CONTRAST } from './surfaces'

/** The 10 tokens added to the presets after the operator's theme files were seeded (2026-07-13, 44 of 54). */
const MISSING = [
	'--fill-strong',
	'--group-blue',
	'--group-purple',
	'--group-pink',
	'--group-red',
	'--group-orange',
	'--group-green',
	'--group-cyan',
	'--term-scroll-thumb',
	'--term-scroll-thumb-hover',
] as const

/**
 * resolveTokens() lays Helm under a theme file, so a seeded high-contrast.json without these keys resolves them to
 * Helm values. Runs after the fixture's own preset effect (parent passive effects follow the child's), removed on
 * unmount; nothing persists.
 */
function InstalledFallback({ children }: { children: ReactNode }) {
	useEffect(() => {
		const style = document.documentElement.style
		for (const name of MISSING) style.setProperty(name, HELM[name] ?? '')
		return () => {
			for (const name of MISSING) style.removeProperty(name)
		}
	}, [])
	return children
}

const pane = '#0c0d0f'
const restRaised = over('#ffffff', 0.16, pane)
const hoverInstalled = over('#ffffff', 0.13, pane)
const hoverBundled = over('#ffffff', 0.22, pane)
const thumbInstalled = ratio(over('#ffffff', 0.22, '#000000'), '#000000')
const thumbBundled = ratio(over('#ffffff', 0.35, '#000000'), '#000000')
/** The tab-group folder icon paints the pure group colour on its band: 15% of that colour over the topbar's HC chrome. */
const groupIcon = (hex: string) => ratio(hex, over(hex, 0.15, '#16181b'))

const OPTIONS = { theme: 'high-contrast', openBackground: true, expose: true } as const

/** 160 lines of real-looking PTY output through the production write path, so the overlay scrollbar shows. */
const SCROLLBACK = Array.from(
	{ length: 160 },
	(_, index) =>
		`\x1b[90m${String(index + 1).padStart(3, ' ')}\x1b[0m  \x1b[32m✓\x1b[0m tests/helm-appearance.test.ts \x1b[90m(${(index % 9) + 2} ms)\x1b[0m`,
).join('\r\n')

/** :hover cannot be pinned in a screenshot; button.css's own data-force-state hook paints the production hover. */
const forceHover = (button: HTMLButtonElement | null) => button?.setAttribute('data-force-state', 'hover')

function Workspace() {
	useEffect(() => {
		let frame = 0
		const write = () => {
			const fixture = (window as Window & { __helmWorkspaceFixture?: TerminalWorkspaceFixture }).__helmWorkspaceFixture
			if (fixture) fixture.emitData('shell', SCROLLBACK)
			else frame = requestAnimationFrame(write)
		}
		frame = requestAnimationFrame(write)
		return () => cancelAnimationFrame(frame)
	}, [])
	return (
		<>
			<div className="d10-buttons">
				<span>Quiet tlačítko</span>
				<Btn>Klid</Btn>
				<Btn ref={forceHover}>Hover</Btn>
			</div>
			<TerminalWorkspaceFixtureView options={OPTIONS} />
		</>
	)
}

const STAGE_CSS = `
.proposal-stage .d10-buttons {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 16px;
	background: var(--pane);
	color: var(--text-1);
	font: 12px / 18px var(--font-ui);
}
.proposal-stage #app.terminal-workspace-fixture { height: 760px; }
`

const workspace = <Workspace />

const meta = {
	title: 'Proposals/D10 Theme files',
	parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D10"
			variant="Current · High contrast, jak ho dnes vidí nainstalovaný Helm"
			note="themes/high-contrast.json se zapsal jednou (44 tokenů) a nikdy se neaktualizuje. 10 novějších tokenů proto bere hodnoty Helmu: barvy skupin, hover quiet tlačítka, palec scrollbaru v terminálu."
			facts={[
				`--fill-strong .13 → hover ${hoverInstalled} je tmavší než klid ${restRaised}`,
				`--group-blue #4c9aff (ikona skupiny na svém pásu) ${groupIcon('#4c9aff')}`,
				`--term-scroll-thumb .22 na #000 ${thumbInstalled}`,
			]}
			css={STAGE_CSS}
		>
			<InstalledFallback>{workspace}</InstalledFallback>
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · jak je přibalený (doporučuji)',
	render: () => (
		<Proposal
			decision="D10"
			variant="A · High contrast, jak je přibalený (doporučuji)"
			note="Výsledek kterékoli opravy (znovu zapsat presety při upgradu, nebo doplnit chybějící tokeny ze stejného presetu). Skupiny dostanou světlejší HC barvy, hover quiet tlačítka je zase světlejší než klid."
			facts={[
				`--fill-strong .22 → hover ${hoverBundled} (klid ${restRaised})`,
				`--group-blue ${HIGH_CONTRAST['--group-blue']} (ikona skupiny na svém pásu) ${groupIcon('#6fb1ff')}`,
				`--term-scroll-thumb .35 na #000 ${thumbBundled}`,
			]}
			css={STAGE_CSS}
		>
			{workspace}
		</Proposal>
	),
}
