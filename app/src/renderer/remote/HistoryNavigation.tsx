import { Btn } from '../button.js'
import type { HistoryReadingState, RemoteHistoryController } from './history-controller.js'

const COPY: Record<string, string> = {
	unsupported:
		'Earlier messages need a history-compatible Remote host and Pi bridge. Live conversation remains available.',
	expired: 'This reading view expired. Start again from the current conversation.',
	gap: 'This range could not be recovered. Restart history or jump to latest.',
	stale: 'The conversation owner changed. Jump to latest and check the current session.',
	busy: 'Another history read is in progress. Retry when it finishes.',
	cancelled: 'History search cancelled. Your previous reading range is unchanged.',
	disconnected: 'History is unavailable while disconnected.',
	'access-ended': 'Access ended. Earlier messages have been cleared.',
	unavailable: 'History could not be loaded. Retry without sending a message.',
	invalid_history: 'This history request is unavailable. Restart history.',
}
export function HistoryNavigation({
	reader,
	state,
	available,
	open,
	latest,
	move,
	question,
}: {
	reader: RemoteHistoryController
	state: HistoryReadingState
	available: boolean
	question: boolean
	open: () => void
	latest: () => void
	move: (direction: 'older' | 'newer') => void
}) {
	const page = state.current?.page
	const busy = state.phase === 'loading' || state.phase === 'progress'
	const restart = ['expired', 'gap', 'stale', 'invalid_history'].includes(state.issue ?? '')
	const recover = available && state.issue && !['unsupported', 'access-ended', 'disconnected'].includes(state.issue)
	const recoveredDisconnect = available && state.issue === 'disconnected'
	if (!busy && (!state.issue || recoveredDisconnect) && !page && !state.browsing) return null
	return (
		<div className="remote-history" aria-label="Message history" aria-busy={state.phase === 'loading'}>
			{(busy || state.issue) && (
				<output
					// biome-ignore lint/a11y/noNoninteractiveTabindex: long status copy is a bounded keyboard-scrollable region.
					tabIndex={0}
					aria-label="History read status"
				>
					{busy
						? state.examined
							? `Searching history · ${state.examined} entries examined`
							: 'Loading earlier messages…'
						: (COPY[state.issue ?? ''] ?? COPY.unavailable)}
				</output>
			)}
			<nav className="remote-history-actions" aria-label="Message history pages">
				{busy ? (
					<>
						{state.phase === 'progress' && (
							<Btn tone="ghost" ariaLabel="Continue search" onClick={reader.continue}>
								Continue
							</Btn>
						)}
						<Btn tone="ghost" ariaLabel="Cancel search" onClick={reader.cancel}>
							Cancel
						</Btn>
					</>
				) : recover ? (
					<Btn tone="ghost" onClick={restart ? open : reader.retry}>
						{restart ? 'Restart history' : 'Retry history'}
					</Btn>
				) : (
					<>
						{page && (
							<Btn tone="ghost" ariaDisabled={!available || !page.older} onClick={() => move('older')}>
								Older
							</Btn>
						)}
						{state.browsing && (
							<Btn tone="ghost" ariaDisabled={!available || !page?.newer} onClick={() => move('newer')}>
								Newer
							</Btn>
						)}
					</>
				)}
				{state.browsing && question && (
					<Btn tone="ghost" onClick={latest}>
						Jump to latest
					</Btn>
				)}
			</nav>
		</div>
	)
}
export function HistoryRangeNote({ state }: { state: HistoryReadingState }) {
	const page = state.current?.page
	if (!page || state.phase === 'loading' || state.phase === 'progress' || state.issue) return null
	return (
		<p className="remote-note">
			{!page.older ? 'Beginning of this conversation.' : 'Earlier conversation range.'}
			{!page.newer && ' At the captured head; Jump to latest includes later replies.'}
			{page.omissions.clipped > 0 && ' Some content was clipped.'}
			{page.omissions.images > 0 && ' Images are not loaded.'}
			{page.omissions.unsupported > 0 && ' Unsupported or private content was omitted.'}
		</p>
	)
}
