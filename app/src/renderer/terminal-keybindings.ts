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

/**
 * Bytes for Shift+Enter: LF (Ctrl+J). xterm.js sends a plain CR for
 * Shift+Enter, so Claude Code submitted instead of starting a new line.
 *
 * LF is what Okena sends for Shift+Enter outside kitty mode. Claude Code, Pi
 * and Codex read it as "new line". zsh, bash and vim treat it like Enter, so
 * a shell prompt runs the command as before. ESC CR (what Claude's
 * `/terminal-setup` binds in VS Code) was rejected: Pi reads it as Alt+Enter
 * and submits or queues the message, and vim leaves insert mode. CSI-u
 * (`ESC [13;2u`) types `3;2u` into shell prompts, since xterm.js has no
 * kitty keyboard mode an app could have asked for.
 */
export const SHIFT_ENTER_INPUT = '\n'

/**
 * Fixed Shift+Enter newline rule. Only the plain Shift chord: Enter, and Enter
 * with any other modifier, keep xterm's own encoding. Repeats are allowed, as
 * they are for Enter; IME composition keeps its own Enter.
 */
export function shiftEnterInput(event: TerminalKeyEvent): TerminalShortcut | null {
	if (event.key !== 'Enter' || event.isComposing) return null
	if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return null
	return { input: SHIFT_ENTER_INPUT, suppress: true }
}

/** Terminal-scoped configurable aliases. Call only at an xterm boundary. */
export function terminalInputShortcut(
	platform: NodeJS.Platform,
	event: TerminalKeyEvent,
	bindings: { deleteLineStart: ShortcutChord[]; sendInterrupt: ShortcutChord[] },
): TerminalShortcut | null {
	const fixed = terminalShortcut(platform, event)
	if (fixed) return fixed
	if (event.isComposing || event.key === 'Dead' || event.key === 'Process') return null
	if (!event.repeat) {
		if (bindings.deleteLineStart.some(chord => matchesShortcut(event, chord, platform)))
			return { input: '\x15', suppress: true }
		if (bindings.sendInterrupt.some(chord => matchesShortcut(event, chord, platform)))
			return { input: '\x03', suppress: true }
	}
	return shiftEnterInput(event)
}

export default { terminalShortcut, terminalInputShortcut, shiftEnterInput, SHIFT_ENTER_INPUT }
