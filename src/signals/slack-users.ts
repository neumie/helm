// Edits signals.slack.includeUsers / excludeUsers from the Signals column: `x` on a Slack row mutes
// its latest sender (exclude), `i` on a filtered Slack entry shows a sender again (unmute, or add to
// include). Writes the config file through the same guarded strict-save path as Settings, then
// updates the running daemon's config in place so the next poll uses it without a restart. Entries
// are exact lowercased Slack user ids or @handles (no globs); the two lists never both hold one id.

import { parseConfigUpdate, parseConfigWithFallback } from '../config-document.js'
import { type HelmConfig, readConfigFile, writeConfigFile } from '../config.js'
import { IncludeSenderError } from './include-sender.js'

const USER_LIST_MAX = 4000

/** A Slack user id or @handle normalized for the lists: lowercase, no @, no whitespace. */
export function normalizeSlackUser(value: string): string {
	return value.trim().toLowerCase().replace(/^@/, '')
}

function parseList(raw: string): string[] {
	return raw
		.split('\n')
		.map(normalizeSlackUser)
		.filter(line => line !== '')
}

interface Lists {
	current: HelmConfig
	include: string[]
	exclude: string[]
}

function readLists(configPath: string, config: HelmConfig): Lists {
	const current = (() => {
		try {
			return parseConfigWithFallback(JSON.parse(readConfigFile(configPath)), config)
		} catch {
			return config
		}
	})()
	return {
		current,
		include: parseList(current.signals.slack.includeUsers),
		exclude: parseList(current.signals.slack.excludeUsers),
	}
}

function saveLists(
	configPath: string,
	config: HelmConfig,
	lists: Lists,
	include: string[] | null,
	exclude: string[] | null,
): void {
	const slack = lists.current.signals.slack
	const includeUsers = include === null ? slack.includeUsers : include.join('\n')
	const excludeUsers = exclude === null ? slack.excludeUsers : exclude.join('\n')
	if (includeUsers.length > USER_LIST_MAX || excludeUsers.length > USER_LIST_MAX) {
		throw new IncludeSenderError('The Slack sender lists are full. Remove entries in Settings › Signals first')
	}
	if (include !== null || exclude !== null) {
		const next = structuredClone(lists.current)
		next.signals.slack.includeUsers = includeUsers
		next.signals.slack.excludeUsers = excludeUsers
		const parsed = parseConfigUpdate(next, lists.current)
		if (!parsed.success) throw new IncludeSenderError('The Slack sender lists could not be saved')
		writeConfigFile(configPath, JSON.stringify(parsed.data, null, '\t'))
	}
	config.signals.slack.includeUsers = includeUsers
	config.signals.slack.excludeUsers = excludeUsers
}

export interface SlackMuteResult {
	userId: string
	/** False when the id was already excluded. */
	added: boolean
	/** True when the id left the include list. */
	unincluded: boolean
}

export type MuteSlackUser = (userId: string) => SlackMuteResult

/** Never show this Slack user: add to excludeUsers, drop from includeUsers. */
export function createMuteSlackUser(configPath: string, config: HelmConfig): MuteSlackUser {
	return rawId => {
		const userId = normalizeSlackUser(rawId)
		if (userId === '') throw new IncludeSenderError('No Slack user to mute')
		const lists = readLists(configPath, config)
		const include = lists.include.filter(id => id !== userId)
		const unincluded = include.length !== lists.include.length
		const added = !lists.exclude.includes(userId)
		saveLists(configPath, config, lists, unincluded ? include : null, added ? [...lists.exclude, userId] : null)
		return { userId, added, unincluded }
	}
}

export interface SlackIncludeResult {
	userId: string
	added: boolean
	unmuted?: boolean
}

export type IncludeSlackUser = (userId: string, reason?: string) => SlackIncludeResult

/** Show this Slack user again: an excluded entry is unmuted; otherwise add to includeUsers. */
export function createIncludeSlackUser(configPath: string, config: HelmConfig): IncludeSlackUser {
	return (rawId, reason) => {
		const userId = normalizeSlackUser(rawId)
		if (userId === '') throw new IncludeSenderError('No Slack user to include')
		const lists = readLists(configPath, config)
		const exclude = lists.exclude.filter(id => id !== userId)
		const unmuted = exclude.length !== lists.exclude.length
		// An `excluded` (muted) entry: dropping the exclude is the whole undo, add nothing.
		const needsInclude = reason !== 'excluded'
		const added = needsInclude && !lists.include.includes(userId)
		saveLists(configPath, config, lists, added ? [...lists.include, userId] : null, unmuted ? exclude : null)
		return { userId, added, ...(unmuted ? { unmuted: true } : {}) }
	}
}

export type CanUnmuteSlackUser = (userId: string) => boolean

/** Whether only a mute keeps this Slack user out (an exact exclude entry). */
export function createCanUnmuteSlackUser(config: HelmConfig): CanUnmuteSlackUser {
	return userId => parseList(config.signals.slack.excludeUsers).includes(normalizeSlackUser(userId))
}
