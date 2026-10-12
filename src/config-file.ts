import { randomUUID } from 'node:crypto'
import {
	constants,
	type Stats,
	closeSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join, parse, resolve, sep } from 'node:path'

export const MAX_CONFIG_FILE_BYTES = 1024 * 1024

function sameIdentity(a: Stats, b: Stats): boolean {
	return a.dev === b.dev && a.ino === b.ino
}
function unchanged(a: Stats, b: Stats): boolean {
	return (
		sameIdentity(a, b) &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		a.mode === b.mode &&
		a.nlink === b.nlink &&
		a.uid === b.uid
	)
}
function assertOwnedFile(stat: Stats): void {
	if (!stat.isFile() || stat.nlink !== 1 || process.getuid?.() === undefined || stat.uid !== process.getuid?.())
		throw new Error('Helm config must be an owned, single-link regular file')
}

/** Pin each parent, accepting only the OS-owned macOS temporary-directory aliases. */
function configParents(path: string): () => void {
	const parent = dirname(resolve(path))
	const entries: Array<{ path: string; stat: Stats; canonical: string }> = []
	let cursor = parse(parent).root
	for (const segment of parent.slice(cursor.length).split(sep).filter(Boolean)) {
		cursor = join(cursor, segment)
		const stat = lstatSync(cursor)
		const canonical = realpathSync(cursor)
		const alias =
			process.platform === 'darwin' &&
			stat.uid === 0 &&
			((cursor === '/tmp' && canonical === '/private/tmp') || (cursor === '/var' && canonical === '/private/var'))
		const target = alias ? lstatSync(canonical) : stat
		if (
			(!alias && stat.isSymbolicLink()) ||
			!target.isDirectory() ||
			(target.uid !== 0 && target.uid !== process.getuid?.()) ||
			((target.mode & 0o022) !== 0 && !(target.uid === 0 && (target.mode & 0o1000) !== 0))
		)
			throw new Error('Helm config parent must be canonical and safely owned')
		entries.push({ path: cursor, stat, canonical })
	}
	const immediate = lstatSync(realpathSync(parent))
	if (process.getuid?.() === undefined || immediate.uid !== process.getuid?.() || (immediate.mode & 0o022) !== 0)
		throw new Error('Helm config parent must be owner-owned and not writable by others')
	return () => {
		for (const entry of entries) {
			const now = lstatSync(entry.path)
			if (
				!sameIdentity(entry.stat, now) ||
				entry.stat.mode !== now.mode ||
				entry.stat.uid !== now.uid ||
				realpathSync(entry.path) !== entry.canonical
			)
				throw new Error('Helm config parent changed during IO')
		}
	}
}

/** Reads and hardens the same bounded descriptor; never reopens a validated pathname. */
export function readConfigFile(inputPath: string): string {
	const path = resolve(inputPath)
	const checkParents = configParents(path)
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const initial = fstatSync(fd)
		assertOwnedFile(initial)
		if (!sameIdentity(initial, lstatSync(path))) throw new Error('Helm config changed during open')
		checkParents()
		fchmodSync(fd, 0o600)
		const before = fstatSync(fd)
		if (before.size > MAX_CONFIG_FILE_BYTES) throw new Error('Helm config is too large')
		const bytes = Buffer.alloc(MAX_CONFIG_FILE_BYTES + 1)
		let length = 0
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, length)
			if (count === 0) break
			length += count
		}
		if (length > MAX_CONFIG_FILE_BYTES) throw new Error('Helm config is too large')
		if (!unchanged(before, fstatSync(fd)) || !unchanged(before, lstatSync(path)))
			throw new Error('Helm config changed during read')
		checkParents()
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
	} finally {
		closeSync(fd)
	}
}

/** Publish without truncating any pre-existing inode. Missing destinations use exclusive link publication. */
export function writeConfigFile(inputPath: string, text: string): void {
	const path = resolve(inputPath)
	const bytes = Buffer.from(text, 'utf8')
	if (bytes.length > MAX_CONFIG_FILE_BYTES) throw new Error('Helm config is too large')
	if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== text)
		throw new Error('Helm config is not valid UTF-8')
	const checkParents = configParents(path)
	let previous: Stats | undefined
	try {
		previous = lstatSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	if (previous) assertOwnedFile(previous)
	const temporary = join(dirname(resolve(path)), `.helm-config-${randomUUID()}.tmp`)
	const fd = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	)
	const owned = fstatSync(fd)
	const cleanup = () => {
		let closeFailed = false
		let closeError: unknown
		try {
			closeSync(fd)
		} catch (error) {
			closeFailed = true
			closeError = error
		}
		try {
			if (sameIdentity(owned, lstatSync(temporary))) unlinkSync(temporary)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !closeFailed) throw error
		}
		if (closeFailed) throw closeError
	}
	try {
		fchmodSync(fd, 0o600)
		writeFileSync(fd, bytes)
		fsyncSync(fd)
		checkParents()
		assertOwnedFile(fstatSync(fd))
		const published = lstatSync(temporary)
		assertOwnedFile(published)
		if ((published.mode & 0o777) !== 0o600 || !sameIdentity(owned, published))
			throw new Error('Helm config temporary changed')
		if (previous) {
			const current = lstatSync(path)
			assertOwnedFile(current)
			if (!unchanged(previous, current)) throw new Error('Helm config changed during write')
			renameSync(temporary, path)
		} else {
			linkSync(temporary, path)
		}
	} catch (error) {
		// Preserve the operation refusal even if owned temporary cleanup also fails.
		try {
			cleanup()
		} catch {
			/* The original failure remains authoritative. */
		}
		throw error
	}
	cleanup()
}
