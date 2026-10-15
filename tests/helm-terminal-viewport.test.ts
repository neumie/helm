import assert from 'node:assert/strict'
import test from 'node:test'
import * as viewportModule from '../app/src/renderer/terminal-viewport.ts'

const { alternateViewportIsBlank } = ((viewportModule as { default?: typeof viewportModule }).default ??
	viewportModule) as typeof viewportModule

function buffer(type: string, lines: string[]) {
	return {
		type,
		length: lines.length,
		getLine(row: number) {
			const text = lines[row]
			if (text === undefined) return undefined
			return {
				getCell(column: number) {
					return { getChars: () => text[column] ?? '' }
				},
			}
		},
	}
}

test('a normal buffer is not a blank fullscreen screen', () => {
	assert.equal(alternateViewportIsBlank(buffer('normal', ['', '']), 2, 2), false)
})

test('an alternate screen with no cells needs an application redraw', () => {
	assert.equal(alternateViewportIsBlank(buffer('alternate', ['', '  ']), 2, 2), true)
	assert.equal(alternateViewportIsBlank(buffer('alternate', ['']), 1, 2), true)
})

test('an alternate screen that still has text does not need a redraw', () => {
	assert.equal(alternateViewportIsBlank(buffer('alternate', ['', 'Pi']), 2, 2), false)
})
