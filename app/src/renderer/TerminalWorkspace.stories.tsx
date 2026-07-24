import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CSSProperties, ReactNode } from 'react'
import { ActivityIndicator } from './activity-indicator'
import { IconBtn } from './icon-button'

interface TabFixture {
	label: string
	active?: boolean
	activity?: 'progress' | 'attention'
	rename?: boolean
}

function TerminalTab({ label, active, activity, rename }: TabFixture) {
	return (
		<div className={`tab${active ? ' active' : ''}`} role="tab" aria-selected={active} tabIndex={0}>
			{activity ? (
				<ActivityIndicator variant={activity} label={activity === 'attention' ? 'Run finished' : 'Running'} />
			) : null}
			{rename ? (
				<input className="tab-rename" aria-label="Rename terminal" defaultValue={label} />
			) : (
				<span className="tab-label">{label}</span>
			)}
			<button type="button" className="tab-close" aria-label={`Close ${label}`}>
				×
			</button>
		</div>
	)
}

function TerminalGroup({ name, collapsed, children }: { name: string; collapsed?: boolean; children?: ReactNode }) {
	return (
		<div className={`tab-group-section${collapsed ? ' collapsed' : ''}`}>
			<button type="button" className="tab-group-header tab-group-toggle" aria-expanded={!collapsed}>
				{name}
			</button>
			<div className="tab-group-members" role="tablist" aria-label={`${name} terminals`}>
				{children}
			</div>
		</div>
	)
}

function StackIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<polygon points="12 2 2 7 12 12 22 7 12 2" />
			<polyline points="2 12 12 17 22 12" />
			<polyline points="2 17 12 22 22 17" />
		</svg>
	)
}

function BackgroundRow({
	title,
	state,
	activity,
	active,
}: { title: string; state?: string; activity?: 'progress' | 'attention'; active?: boolean }) {
	return (
		<div className={`bg-row${active ? ' active' : ''}`}>
			<button type="button" className="bg-open" title="Open and keep in background">
				{activity ? (
					<ActivityIndicator variant={activity} label={activity === 'attention' ? 'Run finished' : 'Agent running'} />
				) : null}
				<span className="bg-open-copy">
					<span className={`bg-title${state ? ' exited' : ''}`}>{title}</span>
					{state ? <span className="bg-state">{state}</span> : null}
				</span>
			</button>
			<IconBtn label={`Move ${title} to tabs and open`}>
				<span className="icon-btn-glyph bg-action-glyph" aria-hidden="true">
					⇥
				</span>
			</IconBtn>
			<IconBtn label={`Close ${title}`}>
				<span className="icon-btn-glyph bg-kill-glyph" aria-hidden="true">
					×
				</span>
			</IconBtn>
		</div>
	)
}

function TerminalOutput() {
	return (
		<div className="term-holder active">
			<div
				className="term-mount"
				style={{
					color: 'var(--term-fg)',
					fontFamily: 'SFMono-Regular, Menlo, monospace',
					fontSize: 13,
					lineHeight: 1.45,
					whiteSpace: 'pre-wrap',
				}}
			>
				<span style={{ color: 'var(--ansi-green)' }}>➜</span> helm git:(
				<span style={{ color: 'var(--ansi-red)' }}>feat/storybook-views</span>) bun run storybook{'\n'}
				<span style={{ color: 'var(--text-2)' }}>storybook v10.5.0</span>
				{'\n\n'}
				Local: http://localhost:6006/{'\n'}
				Network: use --host to expose{'\n\n'}
				<span style={{ color: 'var(--ansi-green)' }}>✓</span> Storybook ready in 428 ms{'\n'}
				<span style={{ color: 'var(--text-2)' }}>Reviewing Views / Terminal workspace</span>
			</div>
			<div className="term-scrollbar" aria-hidden="true">
				<div className="term-scrollbar-thumb" style={{ height: '36%', transform: 'translateY(52px)' }} />
			</div>
		</div>
	)
}

function TerminalShell({
	children,
	popover,
	backgroundName,
	left = 0,
}: { children?: ReactNode; popover?: boolean; backgroundName?: string; left?: number }) {
	return (
		<div id="app" style={{ '--left-width': `${left}px` } as CSSProperties}>
			<header id="topbar">
				<div className="topbar-left" aria-hidden="true" />
				<div className="topbar-right">
					<div className="tab-strip-controls">
						<div id="tabs">
							{children ?? (
								<>
									<TerminalTab label="helm — storybook" active />
									<TerminalTab label="api tests" activity="progress" />
									<TerminalTab label="deployment watcher with a deliberately long title" activity="attention" />
								</>
							)}
						</div>
						<button id="new-tab" type="button" aria-label="New terminal">
							+
						</button>
					</div>
					<div id="topbar-drag-space" className="topbar-drag-space" aria-hidden="true" />
					<div id="bg-root">
						<button
							id="bg-toggle"
							type="button"
							aria-label="Background terminals"
							aria-haspopup="dialog"
							aria-expanded={popover}
						>
							<StackIcon />
							{backgroundName ? (
								<span id="bg-current" className="bg-current">
									{backgroundName}
								</span>
							) : null}
							<span id="bg-count" className="bg-count">
								4
							</span>
						</button>
						{popover ? (
							// Mirrors the production non-modal ARIA dialog.
							// biome-ignore lint/a11y/useSemanticElements: native <dialog> adds modal/top-layer semantics.
							<div id="bg-popover" className="menu-panel menu-end" role="dialog" aria-label="Background terminals">
								<div className="bg-header">Background terminals</div>
								<div id="bg-rows">
									<BackgroundRow title="okena" active />
									<BackgroundRow title="indexing workspace" activity="progress" />
									<BackgroundRow title="agent review" activity="attention" />
									<BackgroundRow title="completed tests" state="Exited (0)" />
								</div>
							</div>
						) : null}
					</div>
				</div>
			</header>
			<div id="content">
				<aside id="left" />
				<div id="divider" />
				<main id="right">
					<div id="terms">
						<TerminalOutput />
					</div>
				</main>
			</div>
		</div>
	)
}

const meta: Meta = {
	title: 'Views/Terminal workspace',
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj

export const FullWorkspace: Story = {
	render: () => <TerminalShell />,
}

export const TabStrip: Story = {
	render: () => (
		<TerminalShell>
			<TerminalTab label="active shell" active />
			<TerminalTab label="agent running" activity="progress" />
			<TerminalTab label="finished — needs attention" activity="attention" />
			<TerminalTab label="a very long terminal title that must truncate without moving controls" />
		</TerminalShell>
	),
}

export const BackgroundTerminals: Story = {
	render: () => <TerminalShell popover backgroundName="okena" />,
}

export const Rename: Story = {
	render: () => (
		<TerminalShell>
			<TerminalTab label="deploy watch" active rename />
			<TerminalTab label="api" />
		</TerminalShell>
	),
}

export const GroupedTabHeaders: Story = {
	render: () => (
		<TerminalShell>
			<TerminalGroup name="Build">
				<TerminalTab label="compile" active />
				<TerminalTab label="tests" activity="progress" />
			</TerminalGroup>
			<TerminalGroup name="Ungrouped">
				<TerminalTab label="scratch" />
			</TerminalGroup>
		</TerminalShell>
	),
}

export const CollapsedTabGroup: Story = {
	render: () => (
		<TerminalShell>
			<TerminalGroup name="Review" collapsed>
				<TerminalTab label="needs attention" activity="attention" />
			</TerminalGroup>
			<TerminalGroup name="Ungrouped">
				<TerminalTab label="shell" active />
			</TerminalGroup>
		</TerminalShell>
	),
}
