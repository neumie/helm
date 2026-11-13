// The theme files in <userData>/themes (docs/design-system.md §2.8, §9 ruling 97). Main lists them for the
// Appearance picker and keeps the bundled presets' own files current:
//
// - a missing preset file is written from the bundled preset;
// - an untouched preset file is rewritten with the current preset: every token in it equals the current preset
//   (or a value the preset carried in an earlier release, `PRESET_EARLIER_VALUES`), or its bytes equal the
//   fingerprint main recorded in `.seeded.json` when it last wrote it;
// - a preset file the user changed is never overwritten (the renderer fills its missing tokens from the same
//   preset, `resolveTokens`), and any other `*.json` is a user theme main never writes.
//
// Writes are atomic (exclusive owner-private temp file, fsync, rename) and never follow a symlink: a preset path
// that is not a regular file, or a themes directory that is a symlink, is left alone. Node-only, no Electron.
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ThemeDefinition } from './theme-presets'

/** Fingerprints of the preset files main wrote: `{ "version": 1, "files": { "<id>": "<sha256 hex>" } }`. */
export const SEED_RECORD = '.seeded.json'

/** Theme and record files above this size are not read (a theme is a few KiB). */
const MAX_FILE_BYTES = 256 * 1024

export interface ThemeFileEntry {
	id: string
	name: string
	tokens: Record<string, string>
}

export interface SeedReport {
	/** Preset ids whose file was written (missing or untouched). */
	written: string[]
	/** Preset ids whose file was kept as the user left it. */
	kept: string[]
}

/** The exact bytes main writes for a preset file. */
export function presetFileContent(preset: ThemeDefinition): string {
	return `${JSON.stringify({ name: preset.name, tokens: preset.tokens }, null, '\t')}\n`
}

export function fingerprint(content: string | Buffer): string {
	return createHash('sha256').update(content).digest('hex')
}

/** A regular file's bytes, opened without following a symlink; null when missing, not regular or too large. */
function readNoFollow(file: string): Buffer | null {
	let fd: number
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	} catch {
		return null
	}
	try {
		const stat = fs.fstatSync(fd)
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
		const content = fs.readFileSync(fd)
		return content.length > MAX_FILE_BYTES ? null : content
	} catch {
		return null
	} finally {
		fs.closeSync(fd)
	}
}

/** Replace `dir/name` with `content`: exclusive 0600 temp file, fsync, rename (a rename never follows a link). */
function writeAtomic(dir: string, name: string, content: string): void {
	const temporary = path.join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
	const fd = fs.openSync(
		temporary,
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
		0o600,
	)
	try {
		try {
			fs.writeSync(fd, content)
			fs.fsyncSync(fd)
		} finally {
			fs.closeSync(fd)
		}
		fs.renameSync(temporary, path.join(dir, name))
	} catch (error) {
		fs.rmSync(temporary, { force: true })
		throw error
	}
}

function readRecord(dir: string): Record<string, string> {
	const content = readNoFollow(path.join(dir, SEED_RECORD))
	if (content === null) return {}
	try {
		const raw = JSON.parse(content.toString('utf8')) as { version?: unknown; files?: unknown }
		if (raw.version !== 1 || typeof raw.files !== 'object' || raw.files === null || Array.isArray(raw.files)) return {}
		const files: Record<string, string> = {}
		for (const [id, value] of Object.entries(raw.files))
			if (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)) files[id] = value
		return files
	} catch {
		return {}
	}
}

/**
 * True when `content` is a preset file Helm wrote and nobody edited: its bytes match the recorded fingerprint, or
 * it holds only `name` (the preset's) and `tokens`, each token equal to the current preset or an earlier release.
 */
export function isUntouchedPresetFile(
	content: Buffer,
	preset: ThemeDefinition,
	earlier: Readonly<Record<string, readonly string[]>> = {},
	recorded?: string,
): boolean {
	if (recorded !== undefined && fingerprint(content) === recorded) return true
	let raw: unknown
	try {
		raw = JSON.parse(content.toString('utf8'))
	} catch {
		return false
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
	const file = raw as Record<string, unknown>
	if (Object.keys(file).some(key => key !== 'name' && key !== 'tokens')) return false
	if (file.name !== preset.name) return false
	const tokens = file.tokens
	if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) return false
	const entries = Object.entries(tokens)
	if (entries.length === 0) return false
	return entries.every(
		([key, value]) =>
			typeof value === 'string' && (preset.tokens[key] === value || (earlier[key]?.includes(value) ?? false)),
	)
}

/**
 * Write missing preset files and rewrite untouched ones with the current presets; record what was written.
 * Throws only when the themes directory cannot be created or is not a real directory.
 */
export function seedPresetFiles(
	dir: string,
	presets: Readonly<Record<string, ThemeDefinition>>,
	earlier: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {},
): SeedReport {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
	if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`)
	const record = readRecord(dir)
	const next = { ...record }
	const report: SeedReport = { written: [], kept: [] }
	for (const [id, preset] of Object.entries(presets)) {
		const name = `${id}.json`
		const file = path.join(dir, name)
		const desired = presetFileContent(preset)
		const desiredPrint = fingerprint(desired)
		let stat: fs.Stats | null = null
		try {
			stat = fs.lstatSync(file)
		} catch {
			stat = null
		}
		if (stat !== null) {
			// A symlink, directory or other non-regular entry belongs to the user.
			const content = stat.isFile() ? readNoFollow(file) : null
			if (content === null) {
				report.kept.push(id)
				continue
			}
			if (content.toString('utf8') === desired) {
				next[id] = desiredPrint
				continue
			}
			if (!isUntouchedPresetFile(content, preset, earlier[id], record[id])) {
				report.kept.push(id)
				continue
			}
		}
		writeAtomic(dir, name, desired)
		next[id] = desiredPrint
		report.written.push(id)
	}
	const changed =
		Object.keys(next).length !== Object.keys(record).length ||
		Object.entries(next).some(([id, value]) => record[id] !== value)
	if (changed) writeAtomic(dir, SEED_RECORD, `${JSON.stringify({ version: 1, files: next }, null, '\t')}\n`)
	return report
}

/** One theme file: `{ name?, tokens }` with `--*` string tokens; null when unreadable or tokenless. */
export function readThemeFile(file: string): ThemeFileEntry | null {
	try {
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
		const tokens: Record<string, string> = {}
		if (typeof raw.tokens === 'object' && raw.tokens !== null) {
			for (const [key, value] of Object.entries(raw.tokens)) {
				if (key.startsWith('--') && typeof value === 'string') tokens[key] = value
			}
		}
		if (Object.keys(tokens).length === 0) return null
		const id = path.basename(file, '.json')
		return {
			id,
			name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
			tokens,
		}
	} catch {
		return null // unreadable/invalid file — skip, never break the list
	}
}

/**
 * The Appearance picker list: presets in preset order (a preset's file wins over the bundled copy, a corrupt one
 * falls back to it), then the user's own themes alphabetically. Never throws.
 */
export function listThemes(dir: string, presets: Readonly<Record<string, ThemeDefinition>>): ThemeFileEntry[] {
	let files: string[] = []
	try {
		files = fs.readdirSync(dir).filter(name => name.endsWith('.json') && name !== SEED_RECORD)
	} catch {
		// dir unreadable — fall through to bundled presets only
	}
	const fromDisk = new Map<string, ThemeFileEntry>()
	for (const name of files) {
		const entry = readThemeFile(path.join(dir, name))
		if (entry) fromDisk.set(entry.id, entry)
	}
	const list: ThemeFileEntry[] = Object.entries(presets).map(
		([id, preset]) => fromDisk.get(id) ?? { id, name: preset.name, tokens: preset.tokens },
	)
	const custom = [...fromDisk.values()].filter(entry => !presets[entry.id]).sort((a, b) => a.name.localeCompare(b.name))
	return [...list, ...custom]
}
