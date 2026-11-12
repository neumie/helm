// D11 — principle 1 allows one filled accent per surface, but `.toggle-on` (sidebar.css, §3.16) fills every on switch
// with --accent-fill, so a Settings section with several enabled options shows several filled accents next to its
// primary Save changes (docs/plans/design-system/proposals/D11.md). Every variant mounts the same real production
// surfaces: the production SettingsSectionPage with the daemon's real Signals controls and an unsaved draft, and the
// production Toggle in a StateGrid (off / on × rest, keyboard focus, disabled). Only the variant changes the on switch.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { type ReactNode, useState } from 'react'
import type { ConfigEditSection } from '../../../shared-helm'
import { SettingsSectionPage, type SettingsStore } from '../../sidebar/SettingsPage'
import { Toggle } from '../../sidebar/ui'
import { StateGrid } from '../../storybook/StateGrid'
import { ratio } from '../contrast'
import { Proposal } from '../proposal'
import { HELM, HIGH, offFacts, onFacts } from './values'

const meta: Meta = {
	title: 'Proposals/D11 Toggles',
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

// Framing only (same in every variant). The caption gets a fixed height so flipping variants never shifts the stage.
const FRAME_CSS = `
.proposal[data-decision="D11"] .proposal-caption { box-sizing: border-box; min-height: 116px; align-content: flex-start; }
.proposal-stage .d11-board { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; align-items: start; }
.proposal-stage .d11-cell { display: grid; gap: 6px; min-width: 0; align-content: start; }
.proposal-stage .d11-label { color: var(--text-1); font: 12px / 18px var(--font-ui); }
.proposal-stage .d11-sidebar { width: 340px; height: 640px; border: 1px solid var(--hairline); }
.proposal-stage .d11-primitives { display: grid; gap: 12px; padding: 16px; background: var(--pane); border: 1px solid var(--hairline); }
`

/** Variant B: a neutral on track (--text-1); the knob stays --on-accent and the accent is left to the focus ring. */
const NEUTRAL_TRACK_CSS = `
.proposal-stage .toggle-on { background: var(--text-1); }
`

/** Variant C: the on track goes neutral (--fill-strong) and only the knob carries the accent. */
const ACCENT_KNOB_CSS = `
.proposal-stage .toggle-on { background: var(--fill-strong); }
.proposal-stage .toggle-on .toggle-knob { background: var(--accent); }
`

/** The daemon's real Signals section (src/config-document.ts), through its last boolean-bearing row. */
const SIGNALS: ConfigEditSection = {
	id: 'signals',
	title: 'Signals',
	description:
		'What needs you from GitHub and Apple Mail, read-only. Mail asks once for permission to read Mail (Automation). Mail reads the inbox plus the mailboxes you list; listing All Mail makes every poll scan all of that account’s mail.',
	controls: [
		{ type: 'field', path: ['signals', 'enabled'], label: 'Enable signals', input: 'boolean' },
		{ type: 'field', path: ['signals', 'github', 'enabled'], label: 'Watch GitHub', input: 'boolean' },
		{ type: 'field', path: ['signals', 'github', 'pollSeconds'], label: 'GitHub poll (seconds)', input: 'number' },
		{
			type: 'field',
			path: ['signals', 'github', 'mentionDays'],
			label: 'Mentions from the last (days)',
			input: 'number',
		},
		{ type: 'field', path: ['signals', 'mail', 'enabled'], label: 'Watch Apple Mail', input: 'boolean' },
		{ type: 'field', path: ['signals', 'mail', 'pollSeconds'], label: 'Mail poll (seconds)', input: 'number' },
		{ type: 'field', path: ['signals', 'mail', 'unreadOnly'], label: 'Unread mail only', input: 'boolean' },
		{
			type: 'field',
			path: ['signals', 'mail', 'excludeBulk'],
			label: 'Skip mailing lists and bulk mail',
			input: 'boolean',
		},
		{ type: 'field', path: ['signals', 'mail', 'maxAgeDays'], label: 'Mail from the last (days)', input: 'number' },
	],
}

const INITIAL_DRAFT: Record<string, unknown> = {
	signals: {
		enabled: true,
		github: { enabled: true, pollSeconds: 120, mentionDays: 14 },
		mail: { enabled: true, pollSeconds: 60, unreadOnly: true, excludeBulk: false, maxAgeDays: 7 },
	},
}

function setAtPath(draft: Record<string, unknown>, path: readonly string[], value: unknown): Record<string, unknown> {
	const [head, ...rest] = path
	if (head === undefined) return draft
	const child = draft[head]
	return {
		...draft,
		[head]:
			rest.length === 0
				? value
				: setAtPath(typeof child === 'object' && child !== null ? (child as Record<string, unknown>) : {}, rest, value),
	}
}

const noop = () => {}

/** The production section page on a story-local store: the toggles answer clicks, the draft is unsaved, so the
 *  page shows its pinned primary Save changes beside the enabled switches. */
function SignalsSettings() {
	const [draft, setDraft] = useState(INITIAL_DRAFT)
	const store: SettingsStore = {
		doc: { config: INITIAL_DRAFT, dashboard: {}, edit: { sections: [SIGNALS] }, secretRedaction: '••••••••' },
		draft,
		dirty: true,
		saving: false,
		loadError: null,
		pendingRestart: null,
		restarting: false,
		update: (path, value) => setDraft(current => setAtPath(current, path, value)),
		updateAndSave: async () => null,
		addListItem: noop,
		removeListItem: noop,
		save: async () => {},
		restartNow: async () => true,
	}
	return (
		<div className="sidebar d11-sidebar">
			<div className="nav-viewport">
				<div className="nav-page">
					<SettingsSectionPage store={store} sectionId="signals" onBack={noop} />
				</div>
			</div>
		</div>
	)
}

function Surfaces() {
	return (
		<div className="d11-board">
			<Cell label="Settings → Signals · neuložená změna (SettingsSectionPage, skutečná pole z config-document.ts)">
				<SignalsSettings />
			</Cell>
			<Cell
				label="Primitives/Field · přepínač (StateGrid: klid, fokus z klávesnice, zakázaný)"
				className="d11-primitives"
			>
				<StateGrid
					states={['rest', 'focus-visible', 'disabled']}
					rows={[
						{
							label: 'off',
							element: <Toggle label="Skip mailing lists and bulk mail" value={false} onChange={noop} />,
						},
						{ label: 'on', element: <Toggle label="Watch Apple Mail" value onChange={noop} /> },
					]}
				/>
			</Cell>
		</div>
	)
}

function Cell({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
	return (
		<div className="d11-cell">
			<span className="d11-label">{label}</span>
			<div className={className}>{children}</div>
		</div>
	)
}

const accentFillTrack = onFacts(
	p => p.accentFill,
	p => p.onAccent,
	'--accent-fill',
)

export const Current: Story = {
	name: 'Current · accent na každém zapnutém',
	render: () => (
		<Proposal
			decision="D11"
			variant="Current · --accent-fill na každém zapnutém přepínači"
			note="Čtyři zapnuté přepínače a Save changes jsou pět plných accentů na jedné ploše; §1 a pravidlo 5 povolují jeden."
			facts={[...accentFillTrack, ...offFacts()]}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · výjimka pro stavové prvky (doporučuji)',
	render: () => (
		<Proposal
			decision="D11"
			variant="A · ponechat accent, §1 vyjme stavové prvky (doporučuji)"
			note="Pixelově stejné jako Current, mění se jen pravidlo: přepínač ukazuje stav, ne akci, takže se do „jednoho plného accentu“ nepočítá (jako macOS System Settings). Zapnuto/vypnuto je vidět na první pohled."
			facts={[...accentFillTrack, ...offFacts()]}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · neutrální dráha',
	render: () => (
		<Proposal
			decision="D11"
			variant="B · zapnutá dráha --text-1, accent jen ve fokusu"
			note={`Save changes zůstane jediný accent. Cena: modrá už neznamená „zapnuto“, bílý knoflík na šedé dráze je slabý a šedá připomíná zakázaný stav; --fill-strong místo --text-1 by dráhu proti pane nechal na ${ratio(HELM.fillStrong, HELM.pane)}.`}
			facts={[
				...onFacts(
					p => p.text1,
					p => p.onAccent,
					'--text-1',
				),
				...offFacts(),
			]}
			css={FRAME_CSS + NEUTRAL_TRACK_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · accent jen na knoflíku',
	render: () => (
		<Proposal
			decision="D11"
			variant="C · neutrální dráha --fill-strong, knoflík --accent"
			note={`Accent zmenší na 12px tečku, ale tečky jsou pořád čtyři. Cena: zapnutá a vypnutá dráha se skoro neliší (${ratio(HELM.fillStrong, HELM.fillSubtle)}), stav nese jen poloha a barva knoflíku; vzor, který jinde v Helmu ani v macOS není.`}
			facts={[
				...onFacts(
					p => p.fillStrong,
					p => p.accent,
					'--fill-strong',
				),
				`knoflík --accent vůči pane ${ratio(HELM.accent, HELM.pane)} (HC ${ratio(HIGH.accent, HIGH.pane)})`,
				...offFacts(),
			]}
			css={FRAME_CSS + ACCENT_KNOB_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}
