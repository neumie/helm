export function EmptyState({ taskCount, activeCount }: { taskCount: number; activeCount: number }) {
	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				justifyContent: 'center',
				height: '100%',
				gap: 8,
			}}
		>
			{taskCount === 0 ? (
				<>
					<p style={{ fontSize: 14, color: 'var(--text-3)', fontWeight: 500 }}>No tasks yet</p>
					<p style={{ fontSize: 13, color: 'var(--text-4)' }}>Waiting for new tasks to arrive.</p>
				</>
			) : activeCount > 0 ? (
				<>
					<p style={{ fontSize: 14, color: 'var(--text-3)', fontWeight: 500 }}>
						{activeCount} task{activeCount > 1 ? 's' : ''} processing
					</p>
					<p style={{ fontSize: 13, color: 'var(--text-4)' }}>Select a task to view details.</p>
				</>
			) : (
				<>
					<p style={{ fontSize: 14, color: 'var(--text-3)', fontWeight: 500 }}>Select a task</p>
					<p style={{ fontSize: 13, color: 'var(--text-4)' }}>Pick one from the sidebar to see details and output.</p>
				</>
			)}
		</div>
	)
}
