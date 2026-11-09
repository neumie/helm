// Apple Mail Signals reader: one read-only `osascript -l JavaScript` call per poll (mail-jxa.ts),
// then pure filtering/threading (mail-filter.ts). Needs only the one-time macOS Automation
// permission (node → Mail): no Full Disk Access, no Mail rules, never launches Mail.

import { z } from 'zod'
import { oneLine } from '../agent-dock/text.js'
import type { HelmConfig } from '../config.js'
import { SIGNAL_LIMITS, type SignalSourceStatus } from './contract.js'
import {
	type SignalCommandRunner,
	type SignalSourceRead,
	commandFailure,
	defaultSignalCommandRunner,
	firstLine,
	isAbort,
} from './github-source.js'
import {
	MAIL_BULK_REASONS,
	type MailFilterOptions,
	type MailMessageHead,
	dedupeMailMessages,
	globToRegExpSource,
	mailGoneReason,
	mailMessageKey,
	mapFilteredMail,
	mapMailThreads,
	parseGlobList,
	parseMailboxList,
	partitionMail,
} from './mail-filter.js'
import {
	MAIL_MAX_CANDIDATES,
	MAIL_MAX_MAILBOXES,
	MAIL_MAX_MAILBOX_CANDIDATES,
	MAIL_MAX_MAILBOX_ENTRIES,
	MAIL_MAX_MESSAGES,
	MAIL_SCRIPT_BUDGET_MS,
	mailOsascriptArgs,
} from './mail-jxa.js'
import type { SignalReader } from './watcher.js'

/**
 * Hard stop for one poll. The script itself stops starting reads after MAIL_SCRIPT_BUDGET_MS and
 * answers with what it has; the remaining 35 s are room for the Apple event in flight then (one
 * event stalled 20-40 s on real Mail while it synced). The
 * watcher arms the next poll only after this one settled, so polls never overlap.
 */
export const OSASCRIPT_TIMEOUT_MS = 60_000
const OSASCRIPT_MAX_BUFFER = 4 * 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000

export const MAIL_PERMISSION_DETAIL = 'Allow node to control Mail in System Settings › Privacy & Security › Automation'
export const MAIL_NOT_RUNNING_DETAIL = 'Mail is not running'

const messageSchema = z.object({
	messageId: z.string().trim().min(1).max(2000),
	subject: z.string(),
	senderName: z.string(),
	senderAddress: z.string(),
	dateReceived: z.string().datetime({ offset: true }),
	read: z.boolean(),
	flagged: z.boolean(),
	bulkReason: z.enum(MAIL_BULK_REASONS).nullable(),
	root: z.string(),
	mailbox: z.string().max(200).nullable().optional(),
})

const mailboxNames = z.array(z.string().max(1000)).max(1000).optional()

const outputSchema = z.union([
	z.object({ running: z.literal(false) }),
	z.object({
		running: z.literal(true),
		truncated: z.boolean(),
		/** The script ran out of its reading budget and answered with part of the mail. */
		slow: z.boolean().optional(),
		myAddresses: z.array(z.string()).max(1000),
		messages: z.array(z.unknown()).max((MAIL_MAX_CANDIDATES + MAIL_MAX_MAILBOX_CANDIDATES) * 2),
		/** Configured mailboxes no account has (a typo, a renamed label). */
		missingMailboxes: mailboxNames,
		/** Configured mailboxes (or mailbox lists) Mail failed to list or read this time. */
		unreadableMailboxes: mailboxNames,
		/** Extra mailboxes holding more mail than one poll reads (All Mail, a busy label). */
		cappedMailboxes: mailboxNames,
		/** Matching mailboxes beyond the bound, not read. */
		skippedMailboxes: mailboxNames,
	}),
])

type MailHealth = { status: SignalSourceStatus; detail: string | null }

function classifyOsascriptFailure(error: unknown): MailHealth {
	const failure = commandFailure(error)
	if (failure.code === 'ENOENT') return { status: 'unavailable', detail: 'osascript is not available' }
	const stderr = typeof failure.stderr === 'string' ? failure.stderr : ''
	if (/-1743|Not authorized to send Apple events/i.test(stderr)) {
		return { status: 'needs_permission', detail: MAIL_PERMISSION_DETAIL }
	}
	// -600: Mail quit between the running() check and the reads.
	if (/\(-600\)|isn.t running/i.test(stderr)) return { status: 'unavailable', detail: MAIL_NOT_RUNNING_DETAIL }
	if (failure.killed === true || failure.code === 'ETIMEDOUT') {
		return { status: 'error', detail: 'Mail did not answer in time' }
	}
	const line = firstLine(stderr)
	return {
		status: 'error',
		detail: line ? oneLine(`Mail read failed: ${line}`, SIGNAL_LIMITS.detail) : 'Mail read failed',
	}
}

function quoted(names: string[]): string {
	return names.map(name => `"${oneLine(name, 60)}"`).join(', ')
}

export const MAIL_SLOW_DETAIL = 'Mail answered slowly; this poll read only part of the mail'

interface MailboxTrouble {
	slow: boolean
	missing: string[]
	unreadable: string[]
	capped: string[]
	skipped: string[]
	ignored: string[]
}

/**
 * Partial reads as health: Mail answered, so the poll still counts (as incomplete), but some mail
 * was not read (Mail too slow for the reading budget, a configured mailbox missing, unreadable or
 * over the bounds) and the footer says so, never silently. Incomplete polls never auto-close Mail
 * threads.
 */
function mailboxHealth(trouble: MailboxTrouble): MailHealth {
	const parts: string[] = []
	if (trouble.slow) parts.push(MAIL_SLOW_DETAIL)
	if (trouble.missing.length > 0) parts.push(`no mailbox named ${quoted(trouble.missing)}`)
	if (trouble.unreadable.length > 0) parts.push(`could not read ${quoted(trouble.unreadable)}`)
	if (trouble.capped.length > 0) parts.push(`more mail than one poll reads in ${quoted(trouble.capped)}`)
	if (trouble.skipped.length > 0) parts.push(`only ${MAIL_MAX_MAILBOXES} matching mailboxes are read`)
	if (trouble.ignored.length > 0) parts.push(`only the first ${MAIL_MAX_MAILBOX_ENTRIES} listed mailboxes are read`)
	if (parts.length === 0) return { status: 'ok', detail: null }
	return { status: 'error', detail: oneLine(parts.join('; '), SIGNAL_LIMITS.detail) }
}

function parseMessages(raw: unknown[]): { messages: MailMessageHead[]; dropped: boolean } {
	const messages: MailMessageHead[] = []
	let dropped = false
	for (const item of raw) {
		const parsed = messageSchema.safeParse(item)
		if (parsed.success) messages.push(parsed.data)
		else dropped = true
	}
	return { messages, dropped }
}

export interface MailSignalReaderDeps {
	run?: SignalCommandRunner
	now?: () => Date
}

/** Reader for the Signals watcher's Mail loop. */
export function createMailSignalReader(config: HelmConfig, deps: MailSignalReaderDeps = {}): SignalReader {
	const run = deps.run ?? defaultSignalCommandRunner
	const now = deps.now ?? (() => new Date())
	return {
		source: 'mail',
		async read(signal): Promise<SignalSourceRead> {
			const cancelled: SignalSourceRead = { result: null, health: { status: 'error', detail: 'Poll was cancelled' } }
			if (signal.aborted) return cancelled
			const settings = config.signals.mail
			const at = now()
			const includeSenders = parseGlobList(settings.includeSenders)
			const configuredMailboxes = parseMailboxList(settings.mailboxes)
			const mailboxes = configuredMailboxes.slice(0, MAIL_MAX_MAILBOX_ENTRIES)
			const ignoredMailboxes = configuredMailboxes.slice(MAIL_MAX_MAILBOX_ENTRIES)
			const goneReason = mailGoneReason(mailboxes)
			let stdout: string
			try {
				const answer = await run(
					'osascript',
					mailOsascriptArgs({
						since: new Date(at.getTime() - settings.maxAgeDays * DAY_MS).toISOString(),
						mailboxes,
						include: includeSenders.map(globToRegExpSource),
						unreadOnly: settings.unreadOnly,
						maxMessages: MAIL_MAX_MESSAGES,
						maxCandidates: MAIL_MAX_CANDIDATES,
						maxMailboxCandidates: MAIL_MAX_MAILBOX_CANDIDATES,
						budgetMs: MAIL_SCRIPT_BUDGET_MS,
					}),
					{
						signal,
						timeout: OSASCRIPT_TIMEOUT_MS,
						maxBuffer: OSASCRIPT_MAX_BUFFER,
						env: process.env,
						// osascript waiting on an Apple event may not stop at SIGTERM; the script only reads,
						// so killing it outright loses nothing and the poll always settles.
						killSignal: 'SIGKILL',
					},
				)
				stdout = answer.stdout
			} catch (error) {
				if (isAbort(error, signal)) return cancelled
				return { result: null, health: classifyOsascriptFailure(error) }
			}

			let output: z.infer<typeof outputSchema>
			try {
				const parsed = outputSchema.safeParse(JSON.parse(stdout))
				if (!parsed.success) throw new Error('unexpected shape')
				output = parsed.data
			} catch {
				return { result: null, health: { status: 'error', detail: 'Mail returned an unreadable answer' } }
			}
			if (!output.running) {
				return {
					result: { source: 'mail', observations: [], complete: false, goneReason },
					health: { status: 'unavailable', detail: MAIL_NOT_RUNNING_DETAIL },
				}
			}

			const { messages, dropped } = parseMessages(output.messages)
			const trouble: MailboxTrouble = {
				slow: output.slow === true,
				missing: output.missingMailboxes ?? [],
				unreadable: output.unreadableMailboxes ?? [],
				capped: output.cappedMailboxes ?? [],
				skipped: output.skippedMailboxes ?? [],
				ignored: ignoredMailboxes,
			}
			const options: MailFilterOptions = {
				unreadOnly: settings.unreadOnly,
				excludeBulk: settings.excludeBulk,
				maxAgeDays: settings.maxAgeDays,
				includeSenders,
				excludeSenders: parseGlobList(settings.excludeSenders),
				myAddresses: output.myAddresses,
			}
			const { kept, filtered } = partitionMail(dedupeMailMessages(messages), options, at)
			return {
				result: {
					source: 'mail',
					observations: mapMailThreads(kept),
					filtered: { entries: mapFilteredMail(filtered), keptKeys: kept.map(mailMessageKey) },
					// A configured mailbox that was not read could still hold a listed thread.
					complete: !output.truncated && !dropped && trouble.missing.length === 0 && trouble.unreadable.length === 0,
					goneReason,
				},
				health: mailboxHealth(trouble),
			}
		},
	}
}
