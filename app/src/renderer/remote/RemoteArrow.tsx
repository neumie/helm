// Heroicons v2.2.0, 16px solid arrow-up/arrow-down. Exact upstream geometry.
// MIT © Tailwind Labs, Inc. See THIRD_PARTY_NOTICES.md.
export function RemoteArrow({ direction }: { direction: 'up' | 'down' }) {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
			<path
				fillRule="evenodd"
				clipRule="evenodd"
				d={
					direction === 'up'
						? 'M8 14a.75.75 0 0 1-.75-.75V4.56L4.03 7.78a.75.75 0 0 1-1.06-1.06l4.5-4.5a.75.75 0 0 1 1.06 0l4.5 4.5a.75.75 0 0 1-1.06 1.06L8.75 4.56v8.69A.75.75 0 0 1 8 14Z'
						: 'M8 2a.75.75 0 0 1 .75.75v8.69l3.22-3.22a.75.75 0 1 1 1.06 1.06l-4.5 4.5a.75.75 0 0 1-1.06 0l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.22 3.22V2.75A.75.75 0 0 1 8 2Z'
				}
			/>
		</svg>
	)
}
