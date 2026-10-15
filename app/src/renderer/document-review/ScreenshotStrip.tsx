import { GLYPH } from '../sidebar/ui'

export interface ReviewShot {
	id: string
	url: string
	mediaType: 'image/png' | 'image/jpeg'
	bytes: Uint8Array
}

/** Memory-only screenshot previews. Removal is local and never sends or saves. */
export function ScreenshotStrip({
	shots,
	onRemove,
}: {
	shots: readonly ReviewShot[]
	onRemove?: (id: string) => void
}) {
	if (shots.length === 0) return null
	return (
		<div className="review-screenshots" aria-label={onRemove ? 'Screenshots to send' : 'Attached screenshots'}>
			{shots.map((shot, index) => (
				<figure key={shot.id} className="review-screenshot">
					<img
						src={shot.url}
						alt={onRemove ? `Screenshot ${index + 1}` : `Attached screenshot ${index + 1}`}
						draggable={false}
					/>
					{onRemove ? (
						<button
							type="button"
							className="review-screenshot-remove"
							aria-label={`Remove screenshot ${index + 1}`}
							onClick={() => onRemove(shot.id)}
						>
							{GLYPH.close}
						</button>
					) : null}
				</figure>
			))}
		</div>
	)
}

export function screenshotBase64(bytes: Uint8Array): string {
	let binary = ''
	for (let index = 0; index < bytes.length; index += 0x8000) {
		const slice = bytes.subarray(index, index + 0x8000)
		binary += String.fromCharCode(...slice)
	}
	return btoa(binary)
}
