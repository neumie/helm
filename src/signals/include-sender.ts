// Adds one exact sender address to `signals.mail.includeSenders` from the Signals filtered log
// (`POST /api/signals/filtered/:id/include`). Writes the config file through the same guarded
// strict-save path as Settings, then updates the running daemon's config object in place: the
// Mail reader reads `config.signals.mail` on every poll, so the change applies from the next poll
// without a daemon restart. Nothing else in the config changes.

import { parseConfigUpdate, parseConfigWithFallback } from '../config-document.js'
import { type HelmConfig, readConfigFile, writeConfigFile } from '../config.js'
import { matchesGlob, parseGlobList } from './mail-filter.js'

/** Same bound as the config schema's `includeSenders` (characters). */
const INCLUDE_SENDERS_MAX = 4000
/** An address the include list can hold as an exact entry: no glob, no whitespace. */
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
	/** False when a glob on the list already matched the address. */
	added: boolean
}

export type IncludeSender = (address: string) => IncludeSenderOutcome

/** Writer bound to the daemon's config file and its live config object. */
export function createIncludeSender(configPath: string, config: HelmConfig): IncludeSender {
	return rawAddress => {
		const address = rawAddress.trim().toLowerCase()
		if (address.length > ADDRESS_MAX || !PLAIN_ADDRESS.test(address))
			throw new IncludeSenderError('This sender has no plain address to include')
		const current = (() => {
			try {
				return parseConfigWithFallback(JSON.parse(readConfigFile(configPath)), config)
			} catch {
				return config
			}
		})()
		const entries = parseGlobList(current.signals.mail.includeSenders)
		if (matchesGlob(address, entries)) {
			// The file already has it (another client added it): make sure this daemon uses it too.
			config.signals.mail.includeSenders = current.signals.mail.includeSenders
			return { address, added: false }
		}
		const includeSenders = [...entries, address].join('\n')
		if (includeSenders.length > INCLUDE_SENDERS_MAX)
			throw new IncludeSenderError('The include list is full. Remove senders in Settings › Signals first')
		const next = structuredClone(current)
		next.signals.mail.includeSenders = includeSenders
		const parsed = parseConfigUpdate(next, current)
		if (!parsed.success) throw new IncludeSenderError('The include list could not be saved')
		writeConfigFile(configPath, JSON.stringify(parsed.data, null, '\t'))
		config.signals.mail.includeSenders = includeSenders
		return { address, added: true }
	}
}
