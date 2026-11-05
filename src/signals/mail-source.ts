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
	MAIL_GONE_REASON,
	type MailFilterOptions,
	type MailMessageHead,
	filterMail,
	globToRegExpSource,
	mapMailThreads,
	parseGlobList,
} from './mail-filter.js'
import { MAIL_MAX_CANDIDATES, MAIL_MAX_MESSAGES, mailOsascriptArgs } from './mail-jxa.js'
import type { SignalReader } from './watcher.js'

const OSASCRIPT_TIMEOUT_MS = 45_000
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
	bulk: z.boolean(),
	root: z.string(),
})

const outputSchema = z.union([
	z.object({ running: z.literal(false) }),
	z.object({
		running: z.literal(true),
		truncated: z.boolean(),
		myAddresses: z.array(z.string()).max(1000),
		messages: z.array(z.unknown()).max(MAIL_MAX_CANDIDATES * 2),
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
			let stdout: string
			try {
				const answer = await run(
					'osascript',
					mailOsascriptArgs({
						since: new Date(at.getTime() - settings.maxAgeDays * DAY_MS).toISOString(),
						include: includeSenders.map(globToRegExpSource),
						unreadOnly: settings.unreadOnly,
						maxMessages: MAIL_MAX_MESSAGES,
						maxCandidates: MAIL_MAX_CANDIDATES,
					}),
					{ signal, timeout: OSASCRIPT_TIMEOUT_MS, maxBuffer: OSASCRIPT_MAX_BUFFER, env: process.env },
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
					result: { source: 'mail', observations: [], complete: false, goneReason: MAIL_GONE_REASON },
					health: { status: 'unavailable', detail: MAIL_NOT_RUNNING_DETAIL },
				}
			}

			const { messages, dropped } = parseMessages(output.messages)
			const options: MailFilterOptions = {
				unreadOnly: settings.unreadOnly,
				excludeBulk: settings.excludeBulk,
				maxAgeDays: settings.maxAgeDays,
				includeSenders,
				excludeSenders: parseGlobList(settings.excludeSenders),
				myAddresses: output.myAddresses,
			}
			return {
				result: {
					source: 'mail',
					observations: mapMailThreads(filterMail(messages, options, at)),
					complete: !output.truncated && !dropped,
					goneReason: MAIL_GONE_REASON,
				},
				health: { status: 'ok', detail: null },
			}
		},
	}
}
