// Global ordinary-terminal preferences. This module deliberately has no
// Electron imports so path validation and persistence remain headlessly tested.
// The renderer may ask main to open a folder picker, but it never supplies a
// cwd to pty:spawn.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const DOCUMENT_VERSION = 1
const MAX_DOCUMENT_BYTES = 16 * 1024
const MAX_PATH_LENGTH = 4096

interface TerminalPreferencesDocument {
	version: typeof DOCUMENT_VERSION
	defaultCwd: string | null
}

export interface TerminalPreferencesSnapshot {
	/** User-selected folder. Null means use the home folder. */
	defaultCwd: string | null
	/** Validated folder main will use for the next ordinary terminal. */
	effectiveCwd: string
	/** The selected folder is unavailable, so effectiveCwd is the home folder. */
	usingFallback: boolean
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

	constructor(userDataDir: string, homeDirectory = os.homedir()) {
		this.filePath = path.join(userDataDir, 'terminal-preferences.json')
		this.homeDirectory = homeDirectory
	}

	snapshot(): TerminalPreferencesSnapshot {
		const defaultCwd = this.readDefaultCwd()
		const selected = defaultCwd === null ? null : existingDirectory(defaultCwd)
		return {
			defaultCwd,
			effectiveCwd: selected ?? this.homeDirectory,
			usingFallback: defaultCwd !== null && selected === null,
		}
	}

	setDefaultCwd(value: string): TerminalPreferencesSnapshot {
		const canonical = existingDirectory(value)
		if (canonical === null) throw new Error('Choose an existing, accessible folder.')
		this.write({ version: DOCUMENT_VERSION, defaultCwd: canonical })
		return this.snapshot()
	}

	resetDefaultCwd(): TerminalPreferencesSnapshot {
		this.write({ version: DOCUMENT_VERSION, defaultCwd: null })
		return this.snapshot()
	}

	private readDefaultCwd(): string | null {
		try {
			const stat = fs.statSync(this.filePath)
			if (!stat.isFile() || stat.size > MAX_DOCUMENT_BYTES) return null
			const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
			if (!parsed || typeof parsed !== 'object') return null
			const document = parsed as Partial<TerminalPreferencesDocument>
			if (document.version !== DOCUMENT_VERSION) return null
			if (document.defaultCwd === null) return null
			if (
				typeof document.defaultCwd !== 'string' ||
				document.defaultCwd.length === 0 ||
				document.defaultCwd.length > MAX_PATH_LENGTH ||
				!path.isAbsolute(document.defaultCwd)
			)
				return null
			return document.defaultCwd
		} catch {
			return null
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
				// Rename consumed it, or the write failed before a file existed.
			}
		}
	}
}

// app/package.json is CommonJS; root Node tests import app modules through tsx's
// default interop and destructure named exports from this object.
export default { TerminalPreferencesStore }
