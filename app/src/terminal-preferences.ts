// Global ordinary-terminal preferences. This module deliberately has no
// Electron imports so path validation and persistence remain headlessly tested.
// The renderer may ask main to open a folder picker, but it never supplies a
// cwd to pty:spawn.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
	type ShortcutAction,
	type ShortcutBindings,
	type ShortcutChord,
	effectiveShortcuts,
	shortcutDeviation,
	validateShortcutBindings,
} from './shortcuts'

const DOCUMENT_VERSION = 2
const MAX_DOCUMENT_BYTES = 16 * 1024
const MAX_PATH_LENGTH = 4096

interface TerminalPreferencesDocumentV1 {
	version: 1
	defaultCwd: string | null
}

interface TerminalPreferencesDocument {
	version: typeof DOCUMENT_VERSION
	revision: number
	defaultCwd: string | null
	optionAsMeta: boolean
	/** Only values which differ from the canonical shortcut registry. */
	shortcuts: ShortcutBindings
}

export interface TerminalPreferencesSnapshot {
	/** User-selected folder. Null means use the home folder. */
	defaultCwd: string | null
	/** Validated folder main will use for the next ordinary terminal. */
	effectiveCwd: string
	/** The selected folder is unavailable, so effectiveCwd is the home folder. */
	usingFallback: boolean
	revision: number
	/** Option sends Meta by default, matching Terminal.app. */
	optionAsMeta: boolean
	/** Effective shortcuts, with canonical defaults merged with deviations. */
	shortcuts: Record<ShortcutAction, ShortcutChord[]>
}

export interface TerminalPreferencesUpdate {
	revision: number
	defaultCwd?: string | null
	optionAsMeta?: boolean
	/** Effective bindings; defaults are stored as omitted deviations. */
	shortcuts?: Record<ShortcutAction, ShortcutChord[]>
}

function existingDirectory(value: string): string | null {
	if (value.length === 0 || value.length > MAX_PATH_LENGTH || !path.isAbsolute(value)) return null
	try {
		const canonical = fs.realpathSync.native(value)
		if (!fs.statSync(canonical).isDirectory()) return null
		fs.accessSync(canonical, fs.constants.R_OK | fs.constants.X_OK)
		return canonical
	} catch {
		return null
	}
}

export class TerminalPreferencesStore {
	readonly filePath: string
	readonly homeDirectory: string

	constructor(
		userDataDir: string,
		homeDirectory = os.homedir(),
		private readonly platform: NodeJS.Platform = process.platform,
	) {
		this.filePath = path.join(userDataDir, 'terminal-preferences.json')
		this.homeDirectory = homeDirectory
	}

	snapshot(): TerminalPreferencesSnapshot {
		return this.snapshotFor(this.readDocument())
	}

	/** Revisioned optimistic update for shortcut and keyboard settings. */
	update(input: TerminalPreferencesUpdate): TerminalPreferencesSnapshot {
		if (!Number.isSafeInteger(input.revision) || input.revision < 0)
			throw new Error('Invalid terminal preferences revision.')
		const current = this.readDocument()
		if (input.revision !== current.revision) throw new Error('Terminal preferences changed in another window.')
		let defaultCwd = current.defaultCwd
		if (input.defaultCwd !== undefined) {
			if (input.defaultCwd === null) defaultCwd = null
			else {
				const canonical = existingDirectory(input.defaultCwd)
				if (canonical === null) throw new Error('Choose an existing, accessible folder.')
				defaultCwd = canonical
			}
		}
		if (input.optionAsMeta !== undefined && typeof input.optionAsMeta !== 'boolean')
			throw new Error('Invalid Option key preference.')
		if (input.shortcuts !== undefined) validateShortcutBindings(input.shortcuts, this.platform)
		const next: TerminalPreferencesDocument = {
			version: DOCUMENT_VERSION,
			revision: current.revision + 1,
			defaultCwd,
			optionAsMeta: input.optionAsMeta ?? current.optionAsMeta,
			shortcuts: input.shortcuts === undefined ? current.shortcuts : deviationsFor(input.shortcuts, this.platform),
		}
		this.write(next)
		return this.snapshotFor(next)
	}

	setDefaultCwd(value: string): TerminalPreferencesSnapshot {
		const canonical = existingDirectory(value)
		if (canonical === null) throw new Error('Choose an existing, accessible folder.')
		const current = this.readDocument()
		return this.update({ revision: current.revision, defaultCwd: canonical })
	}

	resetDefaultCwd(): TerminalPreferencesSnapshot {
		const current = this.readDocument()
		return this.update({ revision: current.revision, defaultCwd: null })
	}

	resetShortcuts(revision: number): TerminalPreferencesSnapshot {
		return this.update({ revision, shortcuts: effectiveShortcuts({}, this.platform) })
	}

	private snapshotFor(document: TerminalPreferencesDocument): TerminalPreferencesSnapshot {
		const selected = document.defaultCwd === null ? null : existingDirectory(document.defaultCwd)
		return {
			defaultCwd: document.defaultCwd,
			effectiveCwd: selected ?? this.homeDirectory,
			usingFallback: document.defaultCwd !== null && selected === null,
			revision: document.revision,
			optionAsMeta: document.optionAsMeta,
			shortcuts: effectiveShortcuts(document.shortcuts, this.platform),
		}
	}

	private readDocument(): TerminalPreferencesDocument {
		try {
			const stat = fs.statSync(this.filePath)
			if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) return defaults()
			const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
			if (!parsed || typeof parsed !== 'object') return defaults()
			const document = parsed as Partial<TerminalPreferencesDocument> | Partial<TerminalPreferencesDocumentV1>
			if (document.version === 1) {
				const defaultCwd = validStoredPath(document.defaultCwd)
				return { ...defaults(), defaultCwd }
			}
			if (
				document.version !== DOCUMENT_VERSION ||
				!Number.isSafeInteger(document.revision) ||
				(document.revision as number) < 0
			)
				return defaults()
			if (typeof document.optionAsMeta !== 'boolean' || !isShortcutBindings(document.shortcuts)) return defaults()
			const defaultCwd = validStoredPath(document.defaultCwd)
			validateShortcutBindings(document.shortcuts, this.platform)
			const revision = document.revision as number
			const optionAsMeta = document.optionAsMeta as boolean
			const shortcuts = document.shortcuts as ShortcutBindings
			return { version: DOCUMENT_VERSION, revision, defaultCwd, optionAsMeta, shortcuts }
		} catch {
			return defaults()
		}
	}

	private write(document: TerminalPreferencesDocument): void {
		const directory = path.dirname(this.filePath)
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
		const temporary = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
		try {
			fs.writeFileSync(temporary, `${JSON.stringify(document, null, '\t')}\n`, { mode: 0o600 })
			fs.renameSync(temporary, this.filePath)
		} finally {
			try {
				fs.unlinkSync(temporary)
			} catch {
				/* rename consumed it */
			}
		}
	}
}

function defaults(): TerminalPreferencesDocument {
	return { version: DOCUMENT_VERSION, revision: 0, defaultCwd: null, optionAsMeta: true, shortcuts: {} }
}

function validStoredPath(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH && path.isAbsolute(value)
		? value
		: null
}

function isShortcutBindings(value: unknown): value is ShortcutBindings {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	return Object.values(value).every(
		bindings => Array.isArray(bindings) && bindings.every(chord => chord && typeof chord === 'object'),
	)
}

function deviationsFor(bindings: Record<ShortcutAction, ShortcutChord[]>, platform: NodeJS.Platform): ShortcutBindings {
	return shortcutDeviation(bindings, platform)
}

export default { TerminalPreferencesStore }
