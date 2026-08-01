import { type ShortcutChord, parseShortcut } from './shortcuts'

export interface RecorderInput {
	type?: string
	isAutoRepeat?: boolean
	key?: string
	code?: string
	meta?: boolean
	control?: boolean
	alt?: boolean
	shift?: boolean
	isComposing?: boolean
}

/** Pure recorder policy: main calls this before menu/native dispatch can observe a chord. */
export function recordedShortcutInput(
	input: RecorderInput,
	platform: NodeJS.Platform,
): {
	consume: boolean
	complete: boolean
	value: ShortcutChord | null
} {
	if (
		input.type !== 'keyDown' ||
		input.isAutoRepeat ||
		input.isComposing ||
		input.key === 'Dead' ||
		input.key === 'Process'
	)
		return { consume: false, complete: false, value: null }
	if (input.key === 'Escape') return { consume: true, complete: true, value: null }
	const primary = platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
	if (!primary) return { consume: false, complete: false, value: null }
	if (!input.code) return { consume: true, complete: true, value: null }
	const value = parseShortcut(
		['Primary', input.shift ? 'Shift' : null, input.alt ? 'Alt' : null, input.code].filter(Boolean).join('+'),
	)
	// Unsupported Primary combinations are consumed and complete as no-result;
	// they can never leak into a menu/terminal while settings is recording.
	return { consume: true, complete: true, value }
}

export default { recordedShortcutInput }
