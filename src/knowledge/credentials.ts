import { constants as fsConstants } from 'node:fs'
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path'
import { KnowledgeProviderError } from './provider.js'

const HOLD_CAPABILITY_PATTERN = /^(cap_[A-Za-z0-9_-]{1,160})\.([A-Za-z0-9_-]{43})$/

export interface HoldCapability {
	id: string
	token: string
}

export async function readPrivateHoldCapability(path: string): Promise<HoldCapability> {
	const absolute = requireAbsolute(path, 'capability')
	await assertPrivateAncestorChain(dirname(absolute), 'capability')
	let handle: FileHandle
	try {
		handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
	} catch {
		throw new KnowledgeProviderError('configuration', 'Knowledge provider credential is unavailable', false)
	}
	try {
		const stat = await handle.stat()
		const uid = currentUid()
		if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > 256) {
			throw new KnowledgeProviderError('configuration', 'Knowledge provider credential file is unsafe', false)
		}
		const token = (await handle.readFile({ encoding: 'utf8' })).trim()
		const match = HOLD_CAPABILITY_PATTERN.exec(token)
		if (!match || Buffer.from(match[2], 'base64url').byteLength !== 32) {
			throw new KnowledgeProviderError('configuration', 'Knowledge provider credential is invalid', false)
		}
		return { id: match[1], token }
	} finally {
		await handle.close()
	}
}

export async function assertPrivateUnixSocket(path: string): Promise<string> {
	const absolute = requireAbsolute(path, 'socket')
	await assertPrivateAncestorChain(dirname(absolute), 'socket')
	const stat = await lstat(absolute).catch(() => undefined)
	if (!stat || !stat.isSocket() || stat.isSymbolicLink() || stat.uid !== currentUid() || (stat.mode & 0o077) !== 0) {
		throw new KnowledgeProviderError('unavailable', 'Knowledge provider endpoint is unavailable', true)
	}
	return absolute
}

function requireAbsolute(path: string, label: string): string {
	if (!isAbsolute(path) || path.includes('\0')) {
		throw new KnowledgeProviderError('configuration', `Knowledge provider ${label} configuration is invalid`, false)
	}
	return resolve(path)
}

async function assertPrivateAncestorChain(path: string, label: string): Promise<void> {
	const root = parse(path).root
	const segments = relative(root, path).split(sep).filter(Boolean)
	let cursor = root
	for (const segment of segments) {
		cursor = resolve(cursor, segment)
		const stat = await lstat(cursor).catch(() => undefined)
		if (!stat) {
			throw new KnowledgeProviderError('configuration', `Knowledge provider ${label} parent is unsafe`, false)
		}
		if (stat.isSymbolicLink()) {
			if (await isTrustedDarwinSystemAlias(cursor, stat.uid)) continue
			throw new KnowledgeProviderError('configuration', `Knowledge provider ${label} parent is unsafe`, false)
		}
		if (!stat.isDirectory()) {
			throw new KnowledgeProviderError('configuration', `Knowledge provider ${label} parent is unsafe`, false)
		}
		const uid = currentUid()
		const ownedAppropriately = stat.uid === uid || stat.uid === 0
		const writableByOthers = (stat.mode & 0o022) !== 0
		const protectedSystemTemporary = stat.uid === 0 && (stat.mode & 0o1000) !== 0
		if (!ownedAppropriately || (writableByOthers && !protectedSystemTemporary)) {
			throw new KnowledgeProviderError('configuration', `Knowledge provider ${label} parent is unsafe`, false)
		}
	}
	const immediate = await lstat(path)
	if (immediate.uid !== currentUid() || (immediate.mode & 0o077) !== 0) {
		throw new KnowledgeProviderError('configuration', `Knowledge provider ${label} parent must be owner-private`, false)
	}
}

async function isTrustedDarwinSystemAlias(path: string, uid: number): Promise<boolean> {
	if (process.platform !== 'darwin' || uid !== 0 || path !== '/var') return false
	return realpath(path)
		.then(value => value === '/private/var')
		.catch(() => false)
}

function currentUid(): number {
	const uid = process.getuid?.()
	if (uid === undefined)
		throw new KnowledgeProviderError('configuration', 'Knowledge provider ownership checks are unsupported', false)
	return uid
}
