import type { Meta, StoryObj } from '@storybook/react-vite'
import { type CSSProperties, Children, type ReactNode } from 'react'
import { type TabGroupColor, tabGroupColorCssVar } from '../tab-group-colors'
import { ActivityIndicator } from './activity-indicator'
import { IconBtn } from './icon-button'

interface TabFixture {
	label: string
	active?: boolean
	activity?: 'progress' | 'attention'
	rename?: boolean
	placeholder?: boolean
}

function TerminalTab({ label, active, activity, rename, placeholder }: TabFixture) {
	return (
		<div
			className={`tab${active ? ' active' : ''}${placeholder ? ' background-tab-drop-placeholder' : ''}`}
			role="tab"
			aria-selected={active}
			aria-hidden={placeholder || undefined}
			inert={placeholder || undefined}
			tabIndex={placeholder ? -1 : 0}
		>
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

function GroupIcon() {
	return (
		<svg className="group-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			{/* Heroicons “Folder”, 16px solid (MIT). See THIRD_PARTY_NOTICES.md. */}
			<path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h2.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H12.5A1.5 1.5 0 0 1 14 5.5v1.401a2.986 2.986 0 0 0-1.5-.401h-9c-.546 0-1.059.146-1.5.401V3.5ZM2 9.5v3A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3A1.5 1.5 0 0 0 12.5 8h-9A1.5 1.5 0 0 0 2 9.5Z" />
		</svg>
	)
}

function TerminalGroup({
	name,
	color,
	collapsed,
	placeholder,
	children,
}: { name: string; color: TabGroupColor; collapsed?: boolean; placeholder?: boolean; children?: ReactNode }) {
	return (
		<div
			className={`tab-group-section${collapsed ? ' collapsed' : ''}${placeholder ? ' group-drop-placeholder' : ''}`}
			style={{ '--group-color': tabGroupColorCssVar(color) } as CSSProperties}
			aria-hidden={placeholder || undefined}
			inert={placeholder || undefined}
		>
			<button
				type="button"
				className="tab-group-header tab-group-toggle"
				aria-expanded={!collapsed}
				tabIndex={placeholder ? -1 : 0}
			>
				<span className="tab-group-summary">
					<GroupIcon />
					<span>{name}</span>
				</span>
				{collapsed ? <span className="tab-group-count">{Children.count(children)}</span> : null}
			</button>
			<div className="tab-group-members" role="tablist" aria-label={`${name} terminals`} hidden={collapsed}>
				{children}
			</div>
		</div>
	)
}

function BackgroundGroup({
	name,
	color,
	collapsed,
	children,
}: { name: string; color: TabGroupColor; collapsed?: boolean; children?: ReactNode }) {
	return (
		<section
			className={`bg-group-section${collapsed ? ' collapsed' : ''}`}
			style={{ '--group-color': tabGroupColorCssVar(color) } as CSSProperties}
		>
			<div className="bg-group-header-row">
				<button type="button" className="tab-group-header tab-group-toggle" aria-expanded={!collapsed}>
					<span className="tab-group-summary">
						<GroupIcon />
						<span>{name}</span>
					</span>
					<span className="tab-group-count">{Children.count(children)}</span>
				</button>
				<IconBtn label={`Restore ${name} group to tabs`} className="bg-group-restore">
					<span className="bg-action-glyph">⇥</span>
				</IconBtn>
				<span className="bg-group-close-slot" aria-hidden="true" />
			</div>
			<div className="bg-group-members" hidden={collapsed}>
				{children}
			</div>
		</section>
	)
}

function TerminalMenu({ group = false }: { group?: boolean }) {
	const items = group
		? ['Rename…', 'Color…', 'Delete', 'Move group to Background']
		: ['Rename…', 'Move to existing group', 'Move to new group…', 'Move to profile…', 'Move to background', 'Close']
	return (
		<div
			className="menu-panel menu-fixed"
			role="menu"
			aria-label={group ? 'Build group actions' : 'compile terminal actions'}
			style={{ position: 'absolute', top: 40, right: 8 }}
		>
			{items.map((item, index) => (
				<button
					key={item}
					type="button"
					className={`menu-item${item === 'Delete' || item === 'Close' ? ' menu-item-danger' : ''}`}
					role="menuitem"
				>
					<span
						className={`menu-item-icon${item === 'Color…' ? ' menu-item-color' : ''}`}
						style={item === 'Color…' ? ({ '--group-color': 'var(--group-orange)' } as CSSProperties) : undefined}
						aria-hidden="true"
					>
						{item === 'Rename…'
							? '✎'
							: item === 'Color…'
								? '●'
								: item === 'Close' || item === 'Delete'
									? '×'
									: item === 'Move to profile…'
										? '→'
										: '›'}
					</span>
					<span className="menu-item-label">{item}</span>
					{index === 4 && !group ? <span className="menu-hint">⇧⌘B</span> : null}
				</button>
			))}
		</div>
	)
}

function BackgroundIcon() {
	return (
		<svg className="background-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			{/* Heroicons “Arrow Down on Square Stack”, 16px solid (MIT). See THIRD_PARTY_NOTICES.md. */}
			<path d="M7 1a.75.75 0 0 1 .75.75V6h-1.5V1.75A.75.75 0 0 1 7 1ZM6.25 6v2.94L5.03 7.72a.75.75 0 0 0-1.06 1.06l2.5 2.5a.75.75 0 0 0 1.06 0l2.5-2.5a.75.75 0 1 0-1.06-1.06L7.75 8.94V6H10a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.25Z" />
			<path d="M4.268 14A2 2 0 0 0 6 15h6a2 2 0 0 0 2-2v-3a2 2 0 0 0-1-1.732V11a3 3 0 0 1-3 3H4.268Z" />
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
			<button type="button" className="bg-open" title="Open and keep in background · Drag to tabs">
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
	backgroundChildren,
	restoreOver,
	left = 0,
}: {
	children?: ReactNode
	popover?: boolean
	backgroundName?: string
	backgroundChildren?: ReactNode
	restoreOver?: boolean
	left?: number
}) {
	return (
		<div id="app" style={{ '--left-width': `${left}px` } as CSSProperties}>
			<header id="topbar">
				<div className="topbar-left" aria-hidden="true" />
				<div
					id="tab-strip-region"
					className={`topbar-right${restoreOver ? ' background-restore-ready background-restore-over' : ''}`}
				>
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
							<BackgroundIcon />
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
									{backgroundChildren ?? (
										<>
											<BackgroundRow title="okena" active />
											<BackgroundRow title="indexing workspace" activity="progress" />
											<BackgroundRow title="agent review" activity="attention" />
											<BackgroundRow title="completed tests" state="Exited (0)" />
										</>
									)}
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
	render: () => (
		<TerminalShell
			popover
			backgroundName="indexing workspace"
			backgroundChildren={
				<>
					<BackgroundGroup name="General" color="cyan">
						<BackgroundRow title="indexing workspace" activity="progress" active />
						<BackgroundRow title="agent review" activity="attention" />
					</BackgroundGroup>
					<BackgroundRow title="completed tests" state="Exited (0)" />
				</>
			}
		/>
	),
}

export const CollapsedBackgroundGroup: Story = {
	render: () => (
		<TerminalShell
			popover
			backgroundChildren={
				<>
					<BackgroundGroup name="Review" color="purple" collapsed>
						<BackgroundRow title="needs attention" activity="attention" />
						<BackgroundRow title="finished checks" state="Exited (0)" />
					</BackgroundGroup>
					<BackgroundRow title="ordinary shell" />
				</>
			}
		/>
	),
}

export const TerminalRestoreTarget: Story = {
	render: () => (
		<TerminalShell restoreOver>
			<TerminalTab label="zsh" />
			<TerminalTab label="background deploy" active activity="progress" placeholder />
		</TerminalShell>
	),
}

export const GroupRestoreTarget: Story = {
	render: () => (
		<TerminalShell restoreOver>
			<TerminalTab label="zsh" active />
			<TerminalGroup name="Delivery" color="cyan" placeholder>
				<TerminalTab label="release logs" />
				<TerminalTab label="deploy agent" activity="progress" />
			</TerminalGroup>
		</TerminalShell>
	),
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
			<TerminalGroup name="Build" color="blue">
				<TerminalTab label="compile" active />
				<TerminalTab label="tests" activity="progress" />
			</TerminalGroup>
			<TerminalTab label="scratch" />
		</TerminalShell>
	),
}

export const CollapsedTabGroup: Story = {
	render: () => (
		<TerminalShell>
			<TerminalGroup name="Review" color="purple" collapsed>
				<TerminalTab label="needs attention" activity="attention" />
			</TerminalGroup>
			<TerminalTab label="shell" active />
		</TerminalShell>
	),
}

export const TabActions: Story = {
	render: () => (
		<TerminalShell>
			<TerminalGroup name="Build" color="green">
				<TerminalTab label="compile" active />
			</TerminalGroup>
			<TerminalMenu />
		</TerminalShell>
	),
}

export const GroupActions: Story = {
	render: () => (
		<TerminalShell>
			<TerminalGroup name="Build" color="orange">
				<TerminalTab label="compile" active />
				<TerminalTab label="tests" />
			</TerminalGroup>
			<TerminalMenu group />
		</TerminalShell>
	),
}
