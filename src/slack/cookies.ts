// Reads and decrypts Slack.app's `d` session cookie from its Chromium cookie store. The cookie is
// AES-128-CBC encrypted (prefix `v10`) with a key derived from the "Slack Safe Storage" macOS
// Keychain password (reading that password is the user's consent prompt — see keychain.ts). The
// decrypted value and the password never leave memory and are never logged.

import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import Database from 'better-sqlite3'

/** Chromium macOS cookie-encryption constants (stable across Chromium versions). */
const SALT = 'saltysalt'
const ITERATIONS = 1003
const KEY_LENGTH = 16
const IV = Buffer.alloc(16, 0x20) // 16 spaces
const V10_PREFIX = Buffer.from('v10', 'utf8')

export class SlackCookieError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'SlackCookieError'
	}
}

/**
 * Decrypt one Chromium `v10` cookie value. Newer Chromium prepends a 32-byte SHA256(host) hash to
 * the plaintext; `expectedPrefix` (here `xoxd-`) lets us detect and strip it without guessing. The
 * password is the raw "Slack Safe Storage" Keychain string.
 */
export function decryptChromiumCookie(encrypted: Buffer, password: string, expectedPrefix: string): string {
	if (encrypted.length <= V10_PREFIX.length || !encrypted.subarray(0, 3).equals(V10_PREFIX)) {
		throw new SlackCookieError('cookie is not v10-encrypted')
	}
	const key = pbkdf2Sync(password, SALT, ITERATIONS, KEY_LENGTH, 'sha1')
	const decipher = createDecipheriv('aes-128-cbc', key, IV)
	decipher.setAutoPadding(false)
	const ciphertext = encrypted.subarray(V10_PREFIX.length)
	let plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
	// Strip PKCS7 padding manually (a bad key yields a bad pad byte → clear error, not garbage).
	const pad = plain.length > 0 ? (plain[plain.length - 1] as number) : 0
	if (pad < 1 || pad > KEY_LENGTH || pad > plain.length) throw new SlackCookieError('bad cookie padding (wrong key?)')
	plain = plain.subarray(0, plain.length - pad)
	let text = plain.toString('utf8')
	if (!text.startsWith(expectedPrefix) && plain.length > 32) {
		// Drop the 32-byte domain-hash prefix newer Chromium adds, then re-check.
		text = plain.subarray(32).toString('utf8')
	}
	if (!text.startsWith(expectedPrefix)) throw new SlackCookieError('decrypted cookie has an unexpected shape')
	return text
}

export interface CookieRow {
	encrypted_value: Buffer
	host_key: string
}

export interface ReadSlackCookieOptions {
	/** Test seam: return the stored rows for the `d` cookie instead of opening the real DB. */
	queryRows?: (dbPath: string) => CookieRow[]
}

/**
 * Read the decrypted `d` (`xoxd-`) cookie from a Chromium cookie SQLite file. The caller passes a
 * path to a private copy of the store (so a live Slack writing it is never read half-way) and the
 * Safe Storage password. Returns the cookie string; throws SlackCookieError when it is absent.
 */
export function readSlackCookie(
	dbPath: string,
	safeStoragePassword: string,
	options: ReadSlackCookieOptions = {},
): string {
	const rows = options.queryRows ? options.queryRows(dbPath) : defaultQueryRows(dbPath)
	const slackRows = rows.filter(row => row.host_key.endsWith('slack.com'))
	// Prefer the most specific host (the base-domain cookie is what the API uses).
	slackRows.sort((a, b) => a.host_key.length - b.host_key.length)
	for (const row of slackRows) {
		try {
			return decryptChromiumCookie(row.encrypted_value, safeStoragePassword, 'xoxd-')
		} catch {
			// Try the next candidate row.
		}
	}
	throw new SlackCookieError('no decryptable d cookie for slack.com')
}

function defaultQueryRows(dbPath: string): CookieRow[] {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true })
	try {
		return db
			.prepare("SELECT encrypted_value, host_key FROM cookies WHERE name = 'd' AND host_key LIKE '%slack.com'")
			.all() as CookieRow[]
	} finally {
		db.close()
	}
}
