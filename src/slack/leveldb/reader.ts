// Read-only LevelDB directory reader: merge every `.ldb` SSTable and `.log` write-ahead entry and,
// for a user-key predicate, return the value with the highest sequence number (the live value).
// A deletion at a higher sequence hides earlier puts. Enough to read a single well-known key
// (`localConfig_v2`) out of Slack.app's Local Storage without a native LevelDB dependency.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readLog } from './log.js'
import { type SsTableEntry, readSsTable } from './sstable.js'

export interface LevelDbReaderOptions {
	/** Injected for tests; defaults to reading the real directory. */
	listFiles?: (dir: string) => string[]
	readFile?: (path: string) => Uint8Array
}

/**
 * The newest value for the first user key matching `keyMatches`, or null if none (or it was
 * deleted at the highest sequence). Unreadable individual files are skipped, not fatal: Slack may
 * rewrite them while we read.
 */
export function readNewestValue(
	dir: string,
	keyMatches: (userKey: Uint8Array) => boolean,
	options: LevelDbReaderOptions = {},
): Uint8Array | null {
	const list = options.listFiles ?? ((d: string) => readdirSync(d))
	const read = options.readFile ?? ((p: string) => new Uint8Array(readFileSync(p)))
	let best: SsTableEntry | null = null
	for (const name of list(dir)) {
		const isLdb = name.endsWith('.ldb')
		const isLog = name.endsWith('.log')
		if (!isLdb && !isLog) continue
		let entries: SsTableEntry[]
		try {
			const bytes = read(join(dir, name))
			entries = isLdb ? readSsTable(bytes) : readLog(bytes)
		} catch {
			continue
		}
		for (const entry of entries) {
			if (!keyMatches(entry.userKey)) continue
			if (best === null || entry.sequence > best.sequence) best = entry
		}
	}
	if (best === null || best.type !== 1) return null
	return best.value
}

/**
 * Chromium Local Storage stores each value with a 1-byte encoding prefix: 0 = UTF-16LE,
 * 1 = Latin-1/UTF-8. Decode to a JS string. An empty value is the empty string.
 */
export function decodeLocalStorageValue(value: Uint8Array): string {
	if (value.length === 0) return ''
	const prefix = value[0]
	const body = value.subarray(1)
	if (prefix === 0) return Buffer.from(body).toString('utf16le')
	// Prefix 1 is Latin-1 in Chromium, but Slack's config is ASCII/UTF-8 JSON; utf-8 is safe here.
	return Buffer.from(body).toString('utf8')
}

/**
 * Chromium Local Storage keys are `_<origin>\x00\x01<script key>`. Match an entry whose script key
 * equals `scriptKey` for any origin (Slack uses `https://app.slack.com`).
 */
export function localStorageKeyMatcher(scriptKey: string): (userKey: Uint8Array) => boolean {
	const needle = `\u0000\u0001${scriptKey}`
	return userKey => {
		if (userKey.length === 0 || userKey[0] !== 0x5f /* _ */) return false
		const text = Buffer.from(userKey).toString('latin1')
		return text.endsWith(needle)
	}
}
