export function EmptyState({ itemCount, activeCount }: { itemCount: number; activeCount: number }) {
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
			{itemCount === 0 ? (
				<>
					<p style={{ fontSize: 14, color: 'var(--text-3)', fontWeight: 500 }}>No items yet</p>
					<p style={{ fontSize: 13, color: 'var(--text-4)' }}>Waiting for new items to arrive.</p>
				</>
			) : activeCount > 0 ? (
				<>
					<p style={{ fontSize: 14, color: 'var(--text-3)', fontWeight: 500 }}>
						{activeCount} item{activeCount > 1 ? 's' : ''} processing
					</p>
					<p style={{ fontSize: 13, color: 'var(--text-4)' }}>Select an item to view details.</p>
				</>
			) : (
				<>
					<p style={{ fontSize: 14, color: 'var(--text-3)', fontWeight: 500 }}>Select an item</p>
					<p style={{ fontSize: 13, color: 'var(--text-4)' }}>Pick one from the sidebar to see details and output.</p>
				</>
			)}
		</div>
	)
}
