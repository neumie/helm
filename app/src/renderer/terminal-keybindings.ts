import { type ShortcutChord, matchesShortcut } from '../shortcuts'

export interface TerminalKeyEvent {
	key: string
	code: string
	metaKey: boolean
	ctrlKey: boolean
	altKey: boolean
	shiftKey: boolean
	repeat?: boolean
	isComposing?: boolean
}

export interface TerminalShortcut {
	/** Bytes written through xterm's normal user-input path. */
	input: string
	/** Prevent xterm from also emitting the original key. */
	suppress: boolean
}

/**
 * Fixed macOS Ctrl reliability rule. This is deliberately not configurable:
 * Chromium/xterm can lose plain Ctrl+Z before the terminal sees it.
 */
export function terminalShortcut(platform: string, event: TerminalKeyEvent): TerminalShortcut | null {
	if (
		platform === 'darwin' &&
		event.key.toLowerCase() === 'z' &&
		event.ctrlKey &&
		!event.metaKey &&
		!event.altKey &&
		!event.shiftKey
	)
		return { input: '\x1a', suppress: true }
	return null
}

/** Terminal-scoped configurable aliases. Call only at an xterm boundary. */
export function terminalInputShortcut(
	platform: NodeJS.Platform,
	event: TerminalKeyEvent,
	bindings: { deleteLineStart: ShortcutChord[]; sendInterrupt: ShortcutChord[] },
): TerminalShortcut | null {
	const fixed = terminalShortcut(platform, event)
	if (fixed) return fixed
	if (event.repeat || event.isComposing || event.key === 'Dead' || event.key === 'Process') return null
	if (bindings.deleteLineStart.some(chord => matchesShortcut(event, chord, platform)))
		return { input: '\x15', suppress: true }
	if (bindings.sendInterrupt.some(chord => matchesShortcut(event, chord, platform)))
		return { input: '\x03', suppress: true }
	return null
}

export default { terminalShortcut, terminalInputShortcut }
