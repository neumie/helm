import { randomBytes, timingSafeEqual } from 'node:crypto'
import { type Stats, constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { dirname, join, parse, resolve, sep } from 'node:path'

export const LOCAL_CONTROL_TOKEN_REDACTION = '[REDACTED]'
const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** The local daemon-control token path, overridable only for isolated tests. */
export function localControlTokenPath(path = process.env.HELM_AUTH_FILE): string {
	return resolve(path ?? `${process.env.HOME ?? process.cwd()}/.helm/local-api-token`)
}

/**
 * Creates a per-user daemon-control token once, or reads the existing token.
 * The directory and token are deliberately checked on every read so a weakened
 * file is never silently used after installation.
 */
export async function loadOrCreateLocalControlToken(path?: string): Promise<string> {
	const tokenPath = localControlTokenPath(path)
	const parent = dirname(tokenPath)
	await mkdir(parent, { recursive: true, mode: 0o700 })
	const checkParent = await tokenParents(parent, true)
	await checkParent()

	try {
		const token = randomControlToken()
		const handle = await open(
			tokenPath,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
			0o600,
		)
		try {
			await handle.writeFile(token)
			await handle.sync()
		} finally {
			await handle.close()
		}
		return readLocalControlToken(tokenPath)
	} catch (error: unknown) {
		if (!isAlreadyExists(error)) throw error
		return readLocalControlToken(tokenPath)
	}
}

/** Reads and validates an existing local daemon-control token without creating it. */
export async function readLocalControlToken(path?: string): Promise<string> {
	const tokenPath = localControlTokenPath(path)
	const checkParents = await tokenParents(dirname(tokenPath))
	const handle = await open(tokenPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
	try {
		const stat = await handle.stat()
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			process.getuid?.() === undefined ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0 ||
			stat.size > 256
		) {
			throw new Error('Local control-token file must be a private regular file')
		}
		const bytes = Buffer.alloc(257)
		let length = 0
		while (length < bytes.length) {
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
			if (!bytesRead) break
			length += bytesRead
		}
		const after = await handle.stat()
		const current = await lstat(tokenPath)
		await checkParents()
		if (length > 256 || !sameTokenFile(stat, after) || !sameTokenFile(stat, current))
			throw new Error('Local control-token file changed or is oversized')
		const token = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).trim()
		if (!isLocalControlToken(token)) throw new Error('Local control-token file is invalid')
		return token
	} finally {
		await handle.close()
	}
}

/** Removes a known token from diagnostic text before it can be surfaced. */
export function redactLocalControlToken(value: string, token?: string): string {
	if (!token) return value
	return value.split(token).join(LOCAL_CONTROL_TOKEN_REDACTION)
}

export function isLocalControlToken(value: string): boolean {
	if (!TOKEN_PATTERN.test(value)) return false
	return Buffer.from(value, 'base64url').byteLength === TOKEN_BYTES
}

/** Constant-time comparison for the daemon-local control capability. */
export function verifyLocalControlToken(capability: string, expected: string): boolean {
	if (!isLocalControlToken(capability) || !isLocalControlToken(expected)) return false
	return timingSafeEqual(Buffer.from(capability), Buffer.from(expected))
}

function randomControlToken(): string {
	return randomBytes(TOKEN_BYTES).toString('base64url')
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

function sameTokenFile(a: Stats, b: Stats): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		a.mode === b.mode &&
		a.nlink === b.nlink &&
		a.uid === b.uid
	)
}

async function tokenParents(parent: string, harden = false): Promise<() => Promise<void>> {
	const entries: Array<{ path: string; stat: Stats; canonical: string }> = []
	let cursor = parse(parent).root
	for (const segment of parent.slice(cursor.length).split(sep).filter(Boolean)) {
		cursor = join(cursor, segment)
		const stat = await lstat(cursor)
		const canonical = await realpath(cursor)
		const alias =
			process.platform === 'darwin' &&
			stat.uid === 0 &&
			((cursor === '/tmp' && canonical === '/private/tmp') || (cursor === '/var' && canonical === '/private/var'))
		const target = alias ? await lstat(canonical) : stat
		if (
			(!alias && stat.isSymbolicLink()) ||
			!target.isDirectory() ||
			(target.uid !== 0 && target.uid !== process.getuid?.()) ||
			((target.mode & 0o022) !== 0 &&
				!(target.uid === 0 && (target.mode & 0o1000) !== 0) &&
				!(harden && cursor === parent && target.uid === process.getuid?.()))
		)
			throw new Error('Local control-token parent must be a real directory with safe canonical ownership')
		entries.push({ path: cursor, stat, canonical })
	}
	const handle = await open(
		parent,
		fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_DIRECTORY,
	)
	try {
		const stat = await handle.stat()
		if (!stat.isDirectory() || process.getuid?.() === undefined || stat.uid !== process.getuid?.())
			throw new Error('Local control-token parent must be owned')
		const last = entries.at(-1)
		if (!last || stat.dev !== last.stat.dev || stat.ino !== last.stat.ino)
			throw new Error('Local control-token parent changed')
		if (harden) await handle.chmod(0o700)
		if (((await handle.stat()).mode & 0o777) !== 0o700) throw new Error('Local control-token parent must be private')
		last.stat = await handle.stat()
	} finally {
		await handle.close()
	}
	return async () => {
		for (const entry of entries) {
			const now = await lstat(entry.path)
			if (
				now.dev !== entry.stat.dev ||
				now.ino !== entry.stat.ino ||
				now.mode !== entry.stat.mode ||
				now.uid !== entry.stat.uid ||
				(await realpath(entry.path)) !== entry.canonical
			)
				throw new Error('Local control-token parent changed')
		}
	}
}
