import type { DaemonStatus } from '../api'

interface Props {
	status: DaemonStatus | null
	onPoll: () => void
	onRefresh: () => void
	onTogglePause: () => void
}

export function Header({ status, onPoll, onRefresh, onTogglePause }: Props) {
	const paused = status?.queue.paused ?? true

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
			<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
				<h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)', letterSpacing: '-0.02em' }}>vigil</h1>
			</div>
			<div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
				<button
					type="button"
					style={{
						color: 'var(--text-4)',
						fontSize: 12,
						cursor: 'pointer',
						background: 'none',
						border: 'none',
						padding: 0,
						fontFamily: 'inherit',
					}}
					onClick={onPoll}
				>
					Poll now
				</button>
				{/* Processing toggle */}
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<span style={{ fontSize: 11, color: paused ? 'var(--text-4)' : 'var(--green)', fontWeight: 500 }}>
						{paused ? 'Paused' : 'Running'}
					</span>
					<button
						type="button"
						aria-label={paused ? 'Resume processing' : 'Pause processing'}
						onClick={onTogglePause}
						style={{
							width: 36,
							height: 20,
							borderRadius: 10,
							border: 'none',
							cursor: 'pointer',
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
