import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const owned = (stat: { uid: number; mode: number }) =>
	process.getuid !== undefined && stat.uid === process.getuid() && (stat.mode & 0o077) === 0
export async function privateDirectory(path: string): Promise<string> {
	const absolute = resolve(path)
	await mkdir(absolute, { recursive: true, mode: 0o700 })
	const canonical = await realpath(absolute)
	const stat = await lstat(absolute)
	if (canonical !== absolute || !stat.isDirectory() || stat.isSymbolicLink() || !owned(stat))
		throw new Error('Review state must use a canonical owner-private directory.')
	return canonical
}
export async function readPrivateJson(path: string, maxBytes = 8192): Promise<unknown> {
	const absolute = resolve(path)
	const parent = dirname(absolute)
	if ((await realpath(parent)) !== parent) throw new Error('Review state parent is not canonical.')
	const parentStat = await lstat(parent)
	if (!parentStat.isDirectory() || !owned(parentStat)) throw new Error('Review state parent is not private.')
	const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const before = await file.stat()
		if (!before.isFile() || before.nlink !== 1 || !owned(before) || before.size > maxBytes)
			throw new Error('Review state is unsafe or oversized.')
		const bytes = Buffer.alloc(maxBytes + 1)
		let count = 0
		while (count < bytes.length) {
			const result = await file.read(bytes, count, bytes.length - count, count)
			if (!result.bytesRead) break
			count += result.bytesRead
		}
		const after = await file.stat()
		const named = await lstat(absolute)
		if (
			count > maxBytes ||
			count !== before.size ||
			before.dev !== after.dev ||
			before.ino !== after.ino ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			after.nlink !== 1 ||
			!owned(after) ||
			named.isSymbolicLink() ||
			named.ino !== after.ino ||
			named.dev !== after.dev
		)
			throw new Error('Review state changed while reading.')
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)))
	} finally {
		await file.close()
	}
}
export async function writePrivateJson(path: string, value: unknown, maxBytes = 8192): Promise<void> {
	await privateDirectory(dirname(path))
	const bytes = Buffer.from(JSON.stringify(value))
	if (bytes.length > maxBytes) throw new Error('Review state is oversized.')
	const file = await open(path, 'wx', 0o600)
	try {
		await file.writeFile(bytes)
		await file.sync()
	} finally {
		await file.close()
	}
}
/**
 * Replace host-only state atomically: a fresh exclusive owner-private temp file, synced, then renamed over the
 * name. A reader sees the old or the new bytes, never a torn write; a crash leaves at most a stray temp file,
 * which {@link removeStrayTemps} collects. Never used for the singleton lock (that one must not be replaceable).
 */
export async function replacePrivateJson(path: string, value: unknown, maxBytes = 8192): Promise<void> {
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
	await writePrivateJson(temporary, value, maxBytes)
	try {
		await rename(temporary, path)
	} catch (error) {
		await unlink(temporary).catch(() => {})
		throw error
	}
}
/**
 * Unlink one owner-private, single-link regular file only. A symlink, another owner's file or a hard-linked one is
 * preserved (and reported): cleanup never follows or removes state it cannot prove is Helm's own.
 */
export async function removePrivateFile(path: string): Promise<void> {
	let before: Awaited<ReturnType<typeof lstat>>
	try {
		before = await lstat(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
		throw error
	}
	if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || !owned(before))
		throw new Error('Review state is unsafe; it was preserved.')
	const after = await lstat(path).catch(() => null)
	if (!after) return
	if (after.dev !== before.dev || after.ino !== before.ino) throw new Error('Review state changed; it was preserved.')
	await unlink(path).catch(error => {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	})
}
/** Names in a private directory matching `pattern` (the directory itself must already be canonical and private). */
export async function privateNames(directory: string, pattern: RegExp): Promise<string[]> {
	return (await readdir(directory)).filter(name => pattern.test(name)).sort()
}
/** Temp files a crash left behind mid-replace; only Helm's own owner-private single-link files go. */
export async function removeStrayTemps(directory: string): Promise<void> {
	for (const name of await privateNames(directory, /^\.[a-z]+-[a-f0-9-]{36}\.json\.[a-f0-9-]{36}\.tmp$/))
		await removePrivateFile(join(directory, name)).catch(() => {})
}
