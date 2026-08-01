// Canonical Helm-owned keyboard shortcuts. Chords use physical KeyboardEvent.code
// values so a binding survives keyboard layouts; Primary is Cmd on macOS and Ctrl
// elsewhere. Standard terminal Ctrl semantics are intentionally not represented.

export type ShortcutAction =
	| 'newTerminal'
	| 'closeFocused'
	| 'moveTerminalToBackground'
	| 'previousTerminal'
	| 'nextTerminal'
	| 'fontBigger'
	| 'fontSmaller'
	| 'fontReset'
	| 'sidebarBack'
	| 'sidebarForward'
	| 'selectTerminal1'
	| 'selectTerminal2'
	| 'selectTerminal3'
	| 'selectTerminal4'
	| 'selectTerminal5'
	| 'selectTerminal6'
	| 'selectTerminal7'
	| 'selectTerminal8'
	| 'selectTerminal9'
	| 'deleteLineStart'
	| 'sendInterrupt'
	| 'runContextSave'

/** Every consumer must deliberately opt into a shortcut surface. */
export type ShortcutScope = 'menu' | 'terminal-selection' | 'terminal-input' | 'run-context'

export interface ShortcutChord {
	code: string
	shift?: boolean
	alt?: boolean
}
export interface ShortcutDefinition {
	action: ShortcutAction
	label: string
	bindings: readonly ShortcutChord[]
	scope: ShortcutScope
}

const codes = [
	...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
	...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
	'Equal',
	'Minus',
	'BracketLeft',
	'BracketRight',
	'Backslash',
	'Semicolon',
	'Quote',
	'Comma',
	'Period',
	'Slash',
	'Backquote',
	'ArrowLeft',
	'ArrowRight',
	'ArrowUp',
	'ArrowDown',
	'Home',
	'End',
	'PageUp',
	'PageDown',
	'Backspace',
	'Delete',
	'Enter',
	'Space',
	'Tab',
	...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
] as const
export type ShortcutCode = (typeof codes)[number]
const supportedCodes = new Set<string>(codes)
const primary = (code: ShortcutCode, modifiers: Omit<ShortcutChord, 'code'> = {}): ShortcutChord => ({
	code,
	...modifiers,
})
const selectBindings = Array.from({ length: 9 }, (_, i) => primary(`Digit${i + 1}` as ShortcutCode))

export const SHORTCUTS: readonly ShortcutDefinition[] = [
	{ action: 'newTerminal', label: 'New terminal', bindings: [primary('KeyT')], scope: 'menu' },
	{ action: 'closeFocused', label: 'Close focused Helm surface', bindings: [primary('KeyW')], scope: 'menu' },
	{
		action: 'moveTerminalToBackground',
		label: 'Move terminal to background',
		bindings: [primary('KeyB', { shift: true })],
		scope: 'menu',
	},
	{
		action: 'previousTerminal',
		label: 'Previous terminal',
		bindings: [primary('ArrowLeft', { alt: true }), primary('BracketLeft', { shift: true })],
		scope: 'menu',
	},
	{
		action: 'nextTerminal',
		label: 'Next terminal',
		bindings: [primary('ArrowRight', { alt: true }), primary('BracketRight', { shift: true })],
		scope: 'menu',
	},
	{
		action: 'fontBigger',
		label: 'Bigger text',
		bindings: [primary('Equal'), primary('Equal', { shift: true })],
		scope: 'menu',
	},
	{ action: 'fontSmaller', label: 'Smaller text', bindings: [primary('Minus')], scope: 'menu' },
	{ action: 'fontReset', label: 'Reset text size', bindings: [primary('Digit0')], scope: 'menu' },
	{ action: 'sidebarBack', label: 'Sidebar back', bindings: [primary('BracketLeft')], scope: 'menu' },
	{ action: 'sidebarForward', label: 'Sidebar forward', bindings: [primary('BracketRight')], scope: 'menu' },
	...selectBindings.map((bindings, i) => ({
		action: `selectTerminal${i + 1}` as ShortcutAction,
		label: `Select terminal ${i + 1}`,
		bindings: [bindings],
		scope: 'terminal-selection' as const,
	})),
	{
		action: 'deleteLineStart',
		label: 'Delete to line start',
		bindings: [primary('Backspace')],
		scope: 'terminal-input',
	},
	{ action: 'sendInterrupt', label: 'Send interrupt', bindings: [primary('Period')], scope: 'terminal-input' },
	{ action: 'runContextSave', label: 'Save run context', bindings: [primary('KeyS')], scope: 'run-context' },
]
export const shortcutActions = SHORTCUTS.map(entry => entry.action) as readonly ShortcutAction[]
const definitions = new Map(SHORTCUTS.map(entry => [entry.action, entry]))

/** Native roles not represented by the editable registry, with the visible menu owner. */
export interface NativeShortcutReservation {
	chord: ShortcutChord
	owner: string
	/** Omitted for Electron roles whose Primary accelerator exists on every platform. */
	platforms?: readonly NodeJS.Platform[]
}
const native = (code: ShortcutCode, modifiers: Omit<ShortcutChord, 'code'> = {}): ShortcutChord => ({
	code,
	...modifiers,
})
const darwinOnly = ['darwin'] as const satisfies readonly NodeJS.Platform[]
const nonDarwinDesktop = ['linux', 'win32'] as const satisfies readonly NodeJS.Platform[]
export const NATIVE_SHORTCUT_RESERVATIONS: readonly NativeShortcutReservation[] = [
	{ chord: native('KeyQ'), owner: 'Helm > Quit', platforms: darwinOnly },
	{ chord: native('KeyH'), owner: 'Helm > Hide Helm', platforms: darwinOnly },
	{ chord: native('KeyH', { alt: true }), owner: 'Helm > Hide Others', platforms: darwinOnly },
	{ chord: native('KeyM'), owner: 'Window > Minimize', platforms: darwinOnly },
	{ chord: native('Backquote'), owner: 'Window > Cycle Windows', platforms: darwinOnly },
	{ chord: native('Backquote', { shift: true }), owner: 'Window > Cycle Windows', platforms: darwinOnly },
	{ chord: native('Space'), owner: 'macOS > Spotlight', platforms: darwinOnly },
	{ chord: native('Tab'), owner: 'macOS > Switch Applications', platforms: darwinOnly },
	{ chord: native('Tab', { shift: true }), owner: 'macOS > Switch Applications', platforms: darwinOnly },
	{ chord: native('KeyC'), owner: 'Edit > Copy' },
	{ chord: native('KeyX'), owner: 'Edit > Cut' },
	{ chord: native('KeyV'), owner: 'Edit > Paste' },
	{ chord: native('KeyV', { shift: true }), owner: 'Edit > Paste and Match Style' },
	{ chord: native('KeyA'), owner: 'Edit > Select All' },
	{ chord: native('KeyZ'), owner: 'Edit > Undo' },
	{ chord: native('KeyZ', { shift: true }), owner: 'Edit > Redo' },
	{ chord: native('KeyR'), owner: 'View > Reload' },
	{ chord: native('KeyR', { shift: true }), owner: 'View > Force Reload' },
	{ chord: native('KeyI', { alt: true }), owner: 'View > Toggle Developer Tools', platforms: darwinOnly },
	{
		chord: native('KeyI', { shift: true }),
		owner: 'View > Toggle Developer Tools',
		platforms: nonDarwinDesktop,
	},
]

export type ShortcutConflict =
	| { kind: 'native'; chord: ShortcutChord; owner: string }
	| { kind: 'helm'; chord: ShortcutChord; owner: ShortcutAction; ownerLabel: string }
	| { kind: 'invalid'; message: string }

export function isShortcutCode(value: unknown): value is ShortcutCode {
	return typeof value === 'string' && supportedCodes.has(value)
}
export function serializeShortcut(chord: ShortcutChord): string {
	validateChord(chord)
	return ['Primary', chord.shift ? 'Shift' : null, chord.alt ? 'Alt' : null, chord.code].filter(Boolean).join('+')
}
export function parseShortcut(value: unknown): ShortcutChord | null {
	if (typeof value !== 'string') return null
	const parts = value.split('+')
	if (parts.length < 2 || parts[0] !== 'Primary') return null
	const code = parts.at(-1)
	if (!code || !isShortcutCode(code)) return null
	const modifiers = new Set(parts.slice(1, -1))
	if ([...modifiers].some(part => part !== 'Shift' && part !== 'Alt') || modifiers.size !== parts.length - 2)
		return null
	return { code, ...(modifiers.has('Shift') ? { shift: true } : {}), ...(modifiers.has('Alt') ? { alt: true } : {}) }
}
export function shortcutDisplay(chord: ShortcutChord, platform: NodeJS.Platform): string {
	validateChord(chord)
	const label = codeLabel(chord.code)
	return platform === 'darwin'
		? `${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}⌘${label}`
		: `${chord.alt ? 'Alt+' : ''}${chord.shift ? 'Shift+' : ''}Ctrl+${label}`
}
export function electronAccelerator(chord: ShortcutChord): string {
	validateChord(chord)
	return ['CommandOrControl', chord.alt ? 'Alt' : null, chord.shift ? 'Shift' : null, electronKey(chord.code)]
		.filter(Boolean)
		.join('+')
}
export interface ShortcutInput {
	code: string
	metaKey: boolean
	ctrlKey: boolean
	altKey: boolean
	shiftKey: boolean
}

export function matchesShortcut(event: ShortcutInput, chord: ShortcutChord, platform: NodeJS.Platform): boolean {
	return (
		event.code === chord.code &&
		(platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
		event.altKey === !!chord.alt &&
		event.shiftKey === !!chord.shift
	)
}
export type ShortcutBindings = Partial<Record<ShortcutAction, ShortcutChord[]>>
export function effectiveShortcuts(
	deviations: ShortcutBindings = {},
	platform: NodeJS.Platform = 'darwin',
): Record<ShortcutAction, ShortcutChord[]> {
	const result = {} as Record<ShortcutAction, ShortcutChord[]>
	for (const definition of SHORTCUTS)
		result[definition.action] = [...(deviations[definition.action] ?? definition.bindings)]
	validateShortcutBindings(result, platform)
	return result
}
export function shortcutDeviation(
	bindings: Record<ShortcutAction, ShortcutChord[]>,
	platform: NodeJS.Platform = 'darwin',
): ShortcutBindings {
	validateShortcutBindings(bindings, platform)
	const result: ShortcutBindings = {}
	for (const definition of SHORTCUTS)
		if (!sameBindings(bindings[definition.action], definition.bindings))
			result[definition.action] = bindings[definition.action].map(chord => ({ ...chord }))
	return result
}
/** Structured validation for editor conflict UI. Empty arrays deliberately disable an action. */
export function shortcutConflicts(
	bindings: ShortcutBindings | Record<ShortcutAction, ShortcutChord[]>,
	platform: NodeJS.Platform = 'darwin',
): ShortcutConflict[] {
	const conflicts: ShortcutConflict[] = []
	const seen = new Map<string, ShortcutAction>()
	for (const action of Object.keys(bindings))
		if (!definitions.has(action as ShortcutAction))
			conflicts.push({ kind: 'invalid', message: `Unknown shortcut action: ${action}` })
	for (const definition of SHORTCUTS) {
		const values = bindings[definition.action] ?? definition.bindings
		if (!Array.isArray(values)) {
			conflicts.push({ kind: 'invalid', message: `${definition.label} has invalid shortcuts.` })
			continue
		}
		for (const chord of values) {
			try {
				validateChord(chord)
			} catch (error) {
				conflicts.push({ kind: 'invalid', message: error instanceof Error ? error.message : 'Unsupported shortcut.' })
				continue
			}
			const key = serializeShortcut(chord)
			const reserved = NATIVE_SHORTCUT_RESERVATIONS.find(
				entry =>
					(entry.platforms === undefined || entry.platforms.includes(platform)) &&
					serializeShortcut(entry.chord) === key,
			)
			// Close is the intentional registry ownership of Cmd+W.
			if (reserved && !(definition.action === 'closeFocused' && key === serializeShortcut(native('KeyW'))))
				conflicts.push({ kind: 'native', chord, owner: reserved.owner })
			const owner = seen.get(key)
			if (owner) {
				const ownerDefinition = definitionForShortcut(owner)
				conflicts.push({ kind: 'helm', chord, owner, ownerLabel: ownerDefinition.label })
			} else seen.set(key, definition.action)
		}
	}
	return conflicts
}
export function validateShortcutBindings(
	bindings: ShortcutBindings | Record<ShortcutAction, ShortcutChord[]>,
	platform: NodeJS.Platform = 'darwin',
): void {
	const conflict = shortcutConflicts(bindings, platform)[0]
	if (!conflict) return
	if (conflict.kind === 'native')
		throw new Error(`${shortcutDisplay(conflict.chord, platform)} is reserved by ${conflict.owner}.`)
	if (conflict.kind === 'helm')
		throw new Error(`${shortcutDisplay(conflict.chord, platform)} conflicts with ${conflict.ownerLabel}.`)
	throw new Error(conflict.message)
}
/** Explicit move operation; it never silently displaces another action. */
export function moveShortcut(
	bindings: Record<ShortcutAction, ShortcutChord[]>,
	chord: ShortcutChord,
	from: ShortcutAction,
	to: ShortcutAction,
	platform: NodeJS.Platform = 'darwin',
): Record<ShortcutAction, ShortcutChord[]> {
	const candidate = Object.fromEntries(
		Object.entries(bindings).map(([action, values]) => [action, values.map(value => ({ ...value }))]),
	) as Record<ShortcutAction, ShortcutChord[]>
	const replacementIndex = candidate[to].length
	candidate[to].push({ ...chord })
	return moveShortcutCandidate(candidate, chord, from, to, replacementIndex, platform)
}

/** Retain an edited candidate's replacement slot while removing its prior owner. */
export function moveShortcutCandidate(
	candidate: Record<ShortcutAction, ShortcutChord[]>,
	chord: ShortcutChord,
	from: ShortcutAction,
	to: ShortcutAction,
	replacementIndex: number,
	platform: NodeJS.Platform = 'darwin',
): Record<ShortcutAction, ShortcutChord[]> {
	validateChord(chord)
	const key = serializeShortcut(chord)
	const next = Object.fromEntries(
		Object.entries(candidate).map(([action, values]) => [action, values.map(value => ({ ...value }))]),
	) as Record<ShortcutAction, ShortcutChord[]>
	if (!next[to][replacementIndex] || serializeShortcut(next[to][replacementIndex]) !== key)
		throw new Error('The shortcut edit is no longer current.')
	if (from !== to) next[from] = next[from].filter(value => serializeShortcut(value) !== key)
	next[to] = next[to].filter((value, index) => serializeShortcut(value) !== key || index === replacementIndex)
	validateShortcutBindings(next, platform)
	return next
}

/** Pure physical-code lookup used by the main-process menu dispatcher. */
export function matchingShortcutAction(
	bindings: Record<ShortcutAction, ShortcutChord[]>,
	scope: ShortcutScope,
	event: ShortcutInput,
	platform: NodeJS.Platform,
): ShortcutAction | null {
	for (const definition of SHORTCUTS) {
		if (definition.scope !== scope) continue
		if (bindings[definition.action].some(chord => matchesShortcut(event, chord, platform))) return definition.action
	}
	return null
}
export function definitionForShortcut(action: ShortcutAction): ShortcutDefinition {
	const definition = definitions.get(action)
	if (!definition) throw new Error(`Unknown shortcut action: ${action}`)
	return definition
}
export function shortcutsForScope(
	bindings: Record<ShortcutAction, ShortcutChord[]>,
	scope: ShortcutScope,
	platform: NodeJS.Platform = 'darwin',
): ShortcutDefinition[] {
	validateShortcutBindings(bindings, platform)
	return SHORTCUTS.filter(definition => definition.scope === scope)
}
function validateChord(chord: ShortcutChord): void {
	if (
		!chord ||
		typeof chord !== 'object' ||
		!isShortcutCode(chord.code) ||
		(chord.shift !== undefined && typeof chord.shift !== 'boolean') ||
		(chord.alt !== undefined && typeof chord.alt !== 'boolean')
	)
		throw new Error('Unsupported shortcut.')
}
function codeLabel(code: ShortcutCode): string {
	if (code.startsWith('Key')) return code.slice(3)
	if (code.startsWith('Digit')) return code.slice(5)
	if (/^F\d+$/.test(code)) return code
	return (
		(
			{
				Equal: '=',
				Minus: '−',
				BracketLeft: '[',
				BracketRight: ']',
				Backslash: '\\',
				Semicolon: ';',
				Quote: "'",
				Comma: ',',
				Period: '.',
				Slash: '/',
				Backquote: '`',
				ArrowLeft: '←',
				ArrowRight: '→',
				ArrowUp: '↑',
				ArrowDown: '↓',
				Home: 'Home',
				End: 'End',
				PageUp: 'PgUp',
				PageDown: 'PgDn',
				Backspace: '⌫',
				Delete: '⌦',
				Enter: '↵',
				Space: 'Space',
				Tab: '⇥',
			} as Record<string, string>
		)[code] ?? code
	)
}
function electronKey(code: ShortcutCode): string {
	if (code.startsWith('Key')) return code.slice(3)
	if (code.startsWith('Digit')) return code.slice(5)
	if (/^F\d+$/.test(code)) return code
	return (
		(
			{
				Equal: '=',
				Minus: '-',
				BracketLeft: '[',
				BracketRight: ']',
				Backslash: '\\',
				Semicolon: ';',
				Quote: "'",
				Comma: ',',
				Period: '.',
				Slash: '/',
				Backquote: '`',
				ArrowLeft: 'Left',
				ArrowRight: 'Right',
				ArrowUp: 'Up',
				ArrowDown: 'Down',
				Home: 'Home',
				End: 'End',
				PageUp: 'PageUp',
				PageDown: 'PageDown',
				Backspace: 'Backspace',
				Delete: 'Delete',
				Enter: 'Enter',
				Space: 'Space',
				Tab: 'Tab',
			} as Record<string, string>
		)[code] ?? code
	)
}
function sameBindings(left: readonly ShortcutChord[], right: readonly ShortcutChord[]): boolean {
	return (
		left.length === right.length &&
		left.every(
			(chord, index) => right[index] !== undefined && serializeShortcut(chord) === serializeShortcut(right[index]),
		)
	)
}
export default {
	SHORTCUTS,
	NATIVE_SHORTCUT_RESERVATIONS,
	effectiveShortcuts,
	shortcutDeviation,
	parseShortcut,
	serializeShortcut,
	shortcutDisplay,
	electronAccelerator,
	matchesShortcut,
	shortcutConflicts,
	moveShortcut,
	moveShortcutCandidate,
	matchingShortcutAction,
	validateShortcutBindings,
}
