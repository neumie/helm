const ACTIVE = '\x1b]9;4;3\x07'
const CLEAR = '\x1b]9;4;0;\x07'
const MARKER_TAIL_LENGTH = Math.max(ACTIVE.length, CLEAR.length) - 1

type Marker = { index: number; active: boolean }

function markerOffsets(text: string, marker: string, active: boolean): Marker[] {
	let cursor = 0
	return text
		.split(marker)
		.slice(0, -1)
		.map(part => {
			cursor += part.length
			const result = { index: cursor, active }
			cursor += marker.length
			return result
		})
}

export interface TerminalProgressTracker {
	feed(data: string): void
	clear(): void
}

/** A clear marker needs acknowledgement only when a real active run ended
 * outside the tab the user was currently viewing. */
export function shouldMarkTerminalCompletion(input: {
	wasRunning: boolean
	closed: boolean
	tabSelected: boolean
	windowFocused: boolean
}): boolean {
	return input.wasRunning && !input.closed && !(input.tabSelected && input.windowFocused)
}

/** Incrementally observes Pi's OSC 9;4 active/clear protocol without consuming
 * or changing PTY bytes. State changes are explicit—ordinary output is never
 * treated as evidence that an agent started or finished. */
export function createTerminalProgressTracker(onChange: (active: boolean) => void): TerminalProgressTracker {
	let active = false
	let markerTail = ''

	const update = (next: boolean): void => {
		if (active === next) return
		active = next
		onChange(active)
	}

	return {
		feed(data): void {
			const scan = markerTail + data
			const markers = [...markerOffsets(scan, ACTIVE, true), ...markerOffsets(scan, CLEAR, false)].sort(
				(a, b) => a.index - b.index,
			)
			for (const marker of markers) update(marker.active)
			markerTail = scan.slice(-MARKER_TAIL_LENGTH)
		},
		clear(): void {
			markerTail = ''
			update(false)
		},
	}
}

export default { createTerminalProgressTracker, shouldMarkTerminalCompletion }
