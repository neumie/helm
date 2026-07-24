import { randomBytes, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

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
	const parentStat = await lstat(parent)
	if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
		throw new Error('Local control-token parent must be a real directory')
	}
	await chmod(parent, 0o700)

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
		return token
	} catch (error: unknown) {
		if (!isAlreadyExists(error)) throw error
		return readLocalControlToken(tokenPath)
	}
}

/** Reads and validates an existing local daemon-control token without creating it. */
export async function readLocalControlToken(path?: string): Promise<string> {
	const tokenPath = localControlTokenPath(path)
	const handle = await open(tokenPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
	try {
		const stat = await handle.stat()
		if (!stat.isFile() || stat.nlink > 1 || (stat.mode & 0o077) !== 0) {
			throw new Error('Local control-token file must be a private regular file')
		}
		const token = (await handle.readFile({ encoding: 'utf8' })).trim()
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
