/** One cell of an xterm viewport, reduced to the text the serializer would keep. */
export interface ViewportCell {
	getChars(): string
}

export interface ViewportLine {
	getCell(column: number): ViewportCell | undefined
}

/** The active xterm buffer, as far as a blank-screen check needs to see it. */
export interface ViewportBuffer {
	type: string
	length: number
	getLine(row: number): ViewportLine | undefined
}

/**
 * A fullscreen app lives on the alternate screen. An empty one cannot be
 * repaired by later differential output: the app redraws the whole screen
 * only when it believes the size changed. A normal buffer is never treated
 * as this case.
 */
export function alternateViewportIsBlank(buffer: ViewportBuffer, rows: number, cols: number): boolean {
	if (buffer.type !== 'alternate' || rows <= 0 || cols <= 0) return false
	const limit = Math.min(rows, buffer.length)
	for (let row = 0; row < limit; row++) {
		const line = buffer.getLine(row)
		if (!line) continue
		for (let column = 0; column < cols; column++) {
			if (line.getCell(column)?.getChars().trim()) return false
		}
	}
	return true
}
