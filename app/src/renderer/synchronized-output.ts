const START = '\x1b[?2026h'
const END = '\x1b[?2026l'
const MARKER_TAIL_LENGTH = Math.max(START.length, END.length) - 1

type Marker = { index: number; mode: 'h' | 'l' }

function markerOffsets(text: string, marker: string, mode: Marker['mode']): Marker[] {
	let cursor = 0
	return text
		.split(marker)
		.slice(0, -1)
		.map(part => {
			cursor += part.length
			const result = { index: cursor, mode }
			cursor += marker.length
			return result
		})
}

interface SynchronizedOutputHooks {
	onFreeze(): void
	onUnfreeze(): void
	/** Injectable for the missing-end-marker regression test. */
	scheduleIdleRelease?(release: () => void): () => void
}

type TerminalWrite = (data: string, onParsed?: () => void) => void

export interface SynchronizedOutputGuard {
	write(data: string, write: TerminalWrite): void
	abort(): void
}

/**
 * Keeps the last complete terminal frame visible while xterm parses a large
 * DEC synchronized-output redraw. xterm intentionally breaks synchronization
 * after one second; long Pi histories can exceed that guard and otherwise
 * expose the clear + partial replay behind the final frame.
 */
export function createSynchronizedOutputGuard(hooks: SynchronizedOutputHooks): SynchronizedOutputGuard {
	let sequenceActive = false
	let frozen = false
	let generation = 0
	let markerTail = ''
	let cancelIdleRelease: (() => void) | null = null
	const scheduleIdleRelease =
		hooks.scheduleIdleRelease ??
		((release: () => void): (() => void) => {
			const timer = setTimeout(release, 30_000)
			return () => clearTimeout(timer)
		})

	const release = (): void => {
		cancelIdleRelease?.()
		cancelIdleRelease = null
		sequenceActive = false
		markerTail = ''
		generation += 1
		if (!frozen) return
		frozen = false
		hooks.onUnfreeze()
	}

	return {
		write(data, write): void {
			const scan = markerTail + data
			let closesGeneration: number | null = null
			const markers = [...markerOffsets(scan, START, 'h'), ...markerOffsets(scan, END, 'l')].sort(
				(a, b) => a.index - b.index,
			)
			for (const marker of markers) {
				if (marker.mode === 'h') {
					if (sequenceActive) continue
					sequenceActive = true
					generation += 1
					if (frozen) continue
					frozen = true
					hooks.onFreeze()
					continue
				}
				if (!sequenceActive) continue
				sequenceActive = false
				closesGeneration = generation
			}
			markerTail = scan.slice(-MARKER_TAIL_LENGTH)

			cancelIdleRelease?.()
			cancelIdleRelease = null
			if (sequenceActive) cancelIdleRelease = scheduleIdleRelease(release)
			if (closesGeneration === null) {
				write(data)
				return
			}
			write(data, () => {
				if (sequenceActive || generation !== closesGeneration || !frozen) return
				frozen = false
				hooks.onUnfreeze()
			})
		},

		abort: release,
	}
}

export default { createSynchronizedOutputGuard }
