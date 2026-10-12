import { type Stats, constants as fsConstants } from 'node:fs'
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
	const checkParents = await assertPrivateAncestorChain(dirname(absolute), 'capability')
	let handle: FileHandle
	try {
		handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
	} catch {
		throw new KnowledgeProviderError('configuration', 'Knowledge provider credential is unavailable', false)
	}
	try {
		const stat = await handle.stat()
		const uid = currentUid()
		if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > 256) {
			throw new KnowledgeProviderError('configuration', 'Knowledge provider credential file is unsafe', false)
		}
		const bytes = Buffer.alloc(257)
		let length = 0
		while (length < bytes.length) {
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
			if (bytesRead === 0) break
			length += bytesRead
		}
		const after = await handle.stat()
		const current = await lstat(absolute)
		await checkParents()
		if (length > 256 || !sameCredential(stat, after) || !sameCredential(stat, current)) {
			throw new KnowledgeProviderError('configuration', 'Knowledge provider credential changed or is oversized', false)
		}
		let token: string
		try {
			token = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).trim()
		} catch {
			throw new KnowledgeProviderError('configuration', 'Knowledge provider credential is invalid', false)
		}
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

async function assertPrivateAncestorChain(path: string, label: string): Promise<() => Promise<void>> {
	const entries: Array<{ path: string; stat: Stats; canonical: string }> = []
	const root = parse(path).root
	const segments = relative(root, path).split(sep).filter(Boolean)
	let cursor = root
	for (const segment of segments) {
		cursor = resolve(cursor, segment)
		const stat = await lstat(cursor).catch(() => undefined)
		if (!stat) {
			throw new KnowledgeProviderError('configuration', `Knowledge provider ${label} parent is unsafe`, false)
		}
		entries.push({ path: cursor, stat, canonical: await realpath(cursor) })
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
				throw new KnowledgeProviderError('configuration', `Knowledge provider ${label} parent changed`, false)
		}
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

function sameCredential(a: Stats, b: Stats): boolean {
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
