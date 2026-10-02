import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

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
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
	await privateDirectory(dirname(path))
	const bytes = Buffer.from(JSON.stringify(value))
	if (bytes.length > 8192) throw new Error('Review state is oversized.')
	const file = await open(path, 'wx', 0o600)
	try {
		await file.writeFile(bytes)
		await file.sync()
	} finally {
		await file.close()
	}
}
