import type { DaemonStatus } from '../api'

interface Props {
	status: DaemonStatus | null
	connected: boolean
	onNewItem: () => void
	onPoll: () => void
	onTogglePause: () => void
}

export function queueLaneSummaries(status: DaemonStatus | null): string[] {
	const lanes = status?.queue.lanes
	if (!lanes) return []
	return [
		`Solve ${lanes.solve.active}/${lanes.solve.maxConcurrency}, ${lanes.solve.pending} queued`,
		`Loop ${lanes.loop.active}/${lanes.loop.maxConcurrency}, ${lanes.loop.pending} queued`,
	]
}

const ghostButton: React.CSSProperties = {
	color: 'var(--text-2)',
	fontSize: 12,
	cursor: 'pointer',
	background: 'transparent',
	border: '1px solid var(--border)',
	borderRadius: 'var(--radius-sm)',
	padding: '5px 10px',
	fontFamily: 'inherit',
	fontWeight: 500,
}

export function Header({ status, connected, onNewItem, onPoll, onTogglePause }: Props) {
	const paused = status?.queue.paused ?? true
	const laneSummaries = queueLaneSummaries(status)
	const stateLabel = !connected ? 'Offline' : paused ? 'Paused' : 'Running'
	const stateColor = !connected ? 'var(--red)' : paused ? 'var(--text-4)' : 'var(--green)'

	return (
		<header
			style={{
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				padding: '10px 24px',
				borderBottom: '1px solid var(--border)',
				background: 'var(--bg-1)',
				flexShrink: 0,
			}}
		>
			{/* Counts live in the list tabs (and the browser title) — the header stays quiet. */}
			<h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)', letterSpacing: '-0.02em' }}>vigil</h1>
			<div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end' }}>
				<button type="button" title={laneSummaries.join('\n')} style={ghostButton} onClick={onPoll}>
					Poll
				</button>
				<button
					type="button"
					style={{
						color: 'var(--text-0)',
						fontSize: 12,
						cursor: 'pointer',
						background: 'var(--accent-fill)',
						border: 'none',
						borderRadius: 'var(--radius-sm)',
						padding: '6px 10px',
						fontFamily: 'inherit',
						fontWeight: 600,
					}}
					onClick={onNewItem}
				>
					New Item
				</button>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<span style={{ fontSize: 11, color: stateColor, fontWeight: 600 }}>{stateLabel}</span>
					<button
						type="button"
						aria-label={paused ? 'Resume processing' : 'Pause processing'}
						disabled={!connected}
						onClick={onTogglePause}
						style={{
							width: 36,
							height: 20,
							borderRadius: 10,
							border: 'none',
							cursor: connected ? 'pointer' : 'not-allowed',
							opacity: connected ? 1 : 0.5,
							background: paused ? 'var(--bg-3)' : 'var(--green)',
							position: 'relative',
							transition: 'background 150ms',
						}}
					>
						<span
							style={{
								position: 'absolute',
								top: 2,
								left: paused ? 2 : 18,
								width: 16,
								height: 16,
								borderRadius: '50%',
								background: '#fff',
								transition: 'left 150ms',
							}}
						/>
					</button>
				</div>
			</div>
		</header>
	)
}
