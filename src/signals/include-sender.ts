// Edits `signals.mail.includeSenders` / `excludeSenders` from the Signals column: `i` on a filtered
// mail (`POST /api/signals/filtered/:id/include`) shows its sender again, `x` on a mail row
// (`POST /api/signals/:id/mute`) never shows it. Writes the config file through the same guarded
// strict-save path as Settings, then updates the running daemon's config object in place: the
// Mail reader reads `config.signals.mail` on every poll, so the change applies from the next poll
// without a daemon restart. Nothing else in the config changes.
//
// The two lists never fight over one address: muting drops the address's exact include entry, and
// showing a sender again drops its exact exclude entry. A glob Jakub wrote himself is never edited:
// when one still decides the outcome, muting refuses (an include glob wins over every exclude) and
// showing adds the exact address to the include list.

import { parseConfigUpdate, parseConfigWithFallback } from '../config-document.js'
import { type HelmConfig, readConfigFile, writeConfigFile } from '../config.js'
import type { SignalFilterReason } from './contract.js'
import { isSentrySender, matchesGlob, parseGlobList } from './mail-filter.js'

/** Same bound as the config schema's `includeSenders` / `excludeSenders` (characters). */
const SENDER_LIST_MAX = 4000
/** An address the lists can hold as an exact entry: no glob, no whitespace. */
const PLAIN_ADDRESS = /^[^\s@*]+@[^\s@*]+$/
const ADDRESS_MAX = 254

export class IncludeSenderError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'IncludeSenderError'
	}
}

export interface IncludeSenderOutcome {
	address: string
	/** True when the address went onto the include list (false: not needed, or a glob already has it). */
	added: boolean
	/** Present when the address's exact entry left the exclude list (it was muted). */
	unmuted?: true
}

export interface IncludeSenderOptions {
	/** The raw From address when it differs from `address` (a Hide My Email relay): its exact exclude entry goes too. */
	raw?: string
	/**
	 * Why the mail was kept out. For `excluded`, dropping the exact exclude entry is the whole undo
	 * when no other exclude glob still matches: the sender is not added to the include list (which
	 * would also show its read mail). Any other reason (or none) adds the address to the include list.
	 */
	reason?: SignalFilterReason
}

export type IncludeSender = (address: string, options?: IncludeSenderOptions) => IncludeSenderOutcome

export interface MuteSenderOutcome {
	address: string
	/** False when an exclude glob already matched the address. */
	added: boolean
	/** True when the address's exact entry left the include list. */
	unincluded: boolean
}

export type MuteSender = (address: string) => MuteSenderOutcome

function plainAddress(raw: string, what: string): string {
	const address = raw.trim().toLowerCase()
	if (address.length > ADDRESS_MAX || !PLAIN_ADDRESS.test(address))
		throw new IncludeSenderError(`This sender has no plain address to ${what}`)
	return address
}

interface SenderLists {
	/** The config as the file has it now (another client may have edited it since startup). */
	current: HelmConfig
	include: string[]
	exclude: string[]
}

function readLists(configPath: string, config: HelmConfig): SenderLists {
	const current = (() => {
		try {
			return parseConfigWithFallback(JSON.parse(readConfigFile(configPath)), config)
		} catch {
			return config
		}
	})()
	return {
		current,
		include: parseGlobList(current.signals.mail.includeSenders),
		exclude: parseGlobList(current.signals.mail.excludeSenders),
	}
}

/**
 * Writes the lists that changed (null = unchanged, kept exactly as written) to the file and the
 * live config. With nothing changed it writes nothing, but still makes this daemon use the file's
 * lists (another client may have edited them).
 */
function saveLists(
	configPath: string,
	config: HelmConfig,
	lists: SenderLists,
	include: string[] | null,
	exclude: string[] | null,
): void {
	const mail = lists.current.signals.mail
	const includeSenders = include === null ? mail.includeSenders : include.join('\n')
	const excludeSenders = exclude === null ? mail.excludeSenders : exclude.join('\n')
	if (includeSenders.length > SENDER_LIST_MAX)
		throw new IncludeSenderError('The include list is full. Remove senders in Settings › Signals first')
	if (excludeSenders.length > SENDER_LIST_MAX)
		throw new IncludeSenderError('The exclude list is full. Remove senders in Settings › Signals first')
	if (include !== null || exclude !== null) {
		const next = structuredClone(lists.current)
		next.signals.mail.includeSenders = includeSenders
		next.signals.mail.excludeSenders = excludeSenders
		const parsed = parseConfigUpdate(next, lists.current)
		if (!parsed.success) throw new IncludeSenderError('The sender lists could not be saved')
		writeConfigFile(configPath, JSON.stringify(parsed.data, null, '\t'))
	}
	config.signals.mail.includeSenders = includeSenders
	config.signals.mail.excludeSenders = excludeSenders
}

/** Writer bound to the daemon's config file and its live config object: show this sender again. */
export function createIncludeSender(configPath: string, config: HelmConfig): IncludeSender {
	return (rawAddress, options = {}) => {
		const address = plainAddress(rawAddress, 'include')
		const aliases = new Set([address])
		if (options.raw !== undefined && options.raw.trim() !== '') aliases.add(options.raw.trim().toLowerCase())
		const lists = readLists(configPath, config)
		const exclude = lists.exclude.filter(entry => !aliases.has(entry.toLowerCase()))
		const unmuted = exclude.length !== lists.exclude.length
		const stillExcluded = [...aliases].some(alias => matchesGlob(alias, exclude))
		const needsInclude = options.reason !== 'excluded' || stillExcluded
		const added = needsInclude && !matchesGlob(address, lists.include)
		saveLists(configPath, config, lists, added ? [...lists.include, address] : null, unmuted ? exclude : null)
		return { address, added, ...(unmuted ? { unmuted: true as const } : {}) }
	}
}

/** Writer bound to the daemon's config file and its live config object: never show this sender. */
export function createMuteSender(configPath: string, config: HelmConfig): MuteSender {
	return rawAddress => {
		const address = plainAddress(rawAddress, 'mute')
		// mail-filter keeps Sentry in whatever the lists say.
		if (isSentrySender(address)) throw new IncludeSenderError('Sentry alerts always show; they cannot be muted')
		const lists = readLists(configPath, config)
		const include = lists.include.filter(entry => entry.toLowerCase() !== address)
		const unincluded = include.length !== lists.include.length
		// An include glob wins over every exclude entry; Jakub's own glob is his to change.
		const glob = include.find(entry => matchesGlob(address, [entry]))
		if (glob !== undefined)
			throw new IncludeSenderError(`${glob} always shows this sender. Change it in Settings › Signals first`)
		const added = !matchesGlob(address, lists.exclude)
		saveLists(configPath, config, lists, unincluded ? include : null, added ? [...lists.exclude, address] : null)
		return { address, added, unincluded }
	}
}
