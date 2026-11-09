import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { HelmConfig } from '../src/config.js'
import type { SignalObservation } from '../src/signals/contract.js'
import type { SignalCommandRunner } from '../src/signals/github-source.js'
import {
	type MailAccountIdentity,
	type MailFilterOptions,
	type MailMessageHead,
	dedupeMailMessages,
	filterMail,
	globToRegExpSource,
	mailFullRef,
	mailGoneReason,
	mailRef,
	mailboxEntryMatches,
	mapMailThreads,
	matchesGlob,
	messageUrl,
	parseGlobList,
	parseMailboxList,
	relayedSenderAddress,
	senderIdentity,
	sentryHead,
} from '../src/signals/mail-filter.js'
import { MAIL_JXA_SCRIPT, mailOsascriptArgs } from '../src/signals/mail-jxa.js'
import { createMailSignalReader } from '../src/signals/mail-source.js'

interface ScriptOutput {
	running: boolean
	truncated: boolean
	myAddresses: string[]
	messages: MailMessageHead[]
}

const output = JSON.parse(
	readFileSync(new URL('./fixtures/signals/mail-output.json', import.meta.url), 'utf8'),
) as ScriptOutput

const NOW = new Date('2026-01-15T10:00:00Z')

const mailSettings = {
	enabled: true,
	pollSeconds: 120,
	unreadOnly: true,
	excludeBulk: true,
	maxAgeDays: 7,
	includeSenders: '*@sentry.io\n*@*.sentry.io\n*@getsentry.com\n*@*.getsentry.com',
	excludeSenders: '  robot@*  \n\n',
	mailboxes: '',
}
const config = { signals: { mail: mailSettings } } as unknown as HelmConfig

function options(overrides: Partial<MailFilterOptions> = {}): MailFilterOptions {
	return {
		unreadOnly: true,
		excludeBulk: true,
		maxAgeDays: 7,
		includeSenders: parseGlobList(mailSettings.includeSenders),
		excludeSenders: parseGlobList(mailSettings.excludeSenders),
		myAddresses: output.myAddresses,
		...overrides,
	}
}

function ids(messages: MailMessageHead[]): string[] {
	return messages.map(message => message.messageId).sort()
}

function byKey(observations: SignalObservation[]): Map<string, SignalObservation> {
	return new Map(observations.map(observation => [observation.threadKey, observation]))
}

test('glob lists are one per line, trimmed, case-insensitive `*` wildcards', () => {
	assert.deepEqual(parseGlobList(' a@b.cz \n\n*@c.io\r\n'), ['a@b.cz', '*@c.io'])
	assert.equal(matchesGlob('Alerts@Acme.Sentry.io', ['*@*.sentry.io']), true)
	assert.equal(matchesGlob('alerts@sentry.io.evil.example', ['*@*.sentry.io']), false)
	assert.equal(matchesGlob('a+b@x.example', ['a+b@x.example']), true)
	assert.equal(matchesGlob('axb@x.example', ['a.b@x.example']), false)
})

test('default filter: unread non-bulk mail in; bulk, read, excluded, own and old mail out; Sentry always in', () => {
	const kept = filterMail(output.messages, options(), NOW)
	assert.deepEqual(ids(kept), [
		'm1@northwind.cz',
		'm2@northwind.cz',
		'm3@xyz.cz',
		'm4@gmail.com',
		's1@sentry.example',
		's2@sentry.example',
		's3@sentry.example',
	])
})

test('filter switches: read and bulk mail when asked, include beats exclude', () => {
	const all = filterMail(output.messages, options({ unreadOnly: false, excludeBulk: false }), NOW)
	assert.ok(ids(all).includes('m5@news.example'))
	assert.ok(ids(all).includes('m6@northwind.cz'))
	assert.ok(!ids(all).includes('m7@example.com'))
	assert.ok(!ids(all).includes('m9@old.example'))

	const included = filterMail(
		output.messages,
		options({ includeSenders: ['robot@*'], excludeSenders: ['robot@*'] }),
		NOW,
	)
	assert.ok(ids(included).includes('m8@noise.example'))
})

test('mail threads group by conversation root; the latest foreign message decides the row', () => {
	const threads = mapMailThreads(filterMail(output.messages, options(), NOW))
	assert.equal(threads.length, 5)
	const invoice = threads.find(thread => thread.ref === 'Northwind')
	assert.ok(invoice)
	assert.match(invoice.threadKey, /^mail:[0-9a-f]{16}$/)
	assert.equal(invoice.source, 'mail')
	assert.equal(invoice.kind, 'mail')
	assert.deepEqual(invoice.reasons, ['mail'])
	assert.equal(invoice.title, 'Re: Invoice question')
	assert.equal(invoice.head, 'Re: Invoice question · 2 messages')
	assert.equal(invoice.actor, 'Petr Example')
	assert.equal(invoice.fullRef, 'Petr Example <petr@northwind.cz>')
	assert.equal(invoice.url, 'message://%3Cm2%40northwind.cz%3E')
	assert.equal(invoice.activityKey, 'm2@northwind.cz')
	assert.equal(invoice.lastActivityAt, '2026-01-14T09:30:00.000Z')
	assert.equal(invoice.repo, null)
	assert.equal(invoice.number, null)
	assert.equal(invoice.branch, null)

	const single = threads.find(thread => thread.ref === 'XYZ')
	assert.equal(single?.head, 'Contract draft')
	assert.ok(threads.some(thread => thread.ref === 'Friend Example'))
})

test('organisation refs come from the sender domain; webmail uses the person', () => {
	assert.equal(mailRef('Klara', 'klara@northwind.cz'), 'Northwind')
	assert.equal(mailRef('Jan', 'jan@abc.cz'), 'ABC')
	assert.equal(mailRef('Olga', 'olga@mail.xyz.cz'), 'XYZ')
	assert.equal(mailRef('Ann', 'ann@shop.acme.co.uk'), 'Acme')
	assert.equal(mailRef('Friend Example', 'friend@gmail.com'), 'Friend Example')
	assert.equal(mailRef('', 'friend.example@Seznam.cz'), 'friend.example')
})

test('Sentry alerts dedupe by short id, with the decoration stripped from the head', () => {
	const threads = byKey(mapMailThreads(filterMail(output.messages, options(), NOW)))
	const issue = threads.get('sentry:ACME-ADMIN-3F2')
	assert.ok(issue)
	assert.equal(issue.kind, 'sentry')
	assert.deepEqual(issue.reasons, ['sentry'])
	assert.equal(issue.ref, 'ACME-ADMIN-3F2')
	assert.equal(issue.head, 'ACME-ADMIN-3F2 - TypeError: x is undefined (regression)')
	assert.equal(issue.activityKey, 's2@sentry.example')

	const report = [...threads.values()].find(thread => thread.kind === 'sentry' && thread.ref === 'Sentry')
	assert.ok(report)
	assert.match(report.threadKey, /^sentry:[0-9a-f]{16}$/)
	assert.equal(report.head, 'Weekly report')

	assert.equal(sentryHead('[Sentry] Sentry: [Sentry] PROJ-1 boom'), 'PROJ-1 boom')
})

test('message urls are encoded Message-IDs', () => {
	assert.equal(messageUrl('<a.b+c@x.example>'), 'message://%3Ca.b%2Bc%40x.example%3E')
	assert.equal(messageUrl('a@x'), 'message://%3Ca%40x%3E')
})

test('untrusted subjects and names stay one bounded line', () => {
	const [thread] = mapMailThreads([
		{
			...output.messages[0],
			subject: `Hello\nworld\u0007 ${'x'.repeat(400)}`,
			senderName: 'Name\r\nInjected',
		},
	])
	assert.ok(thread.head.startsWith('Hello world x'))
	assert.ok(thread.head.length <= 300)
	assert.equal(thread.actor, 'Name Injected')
})

// ---------- reader (fake osascript) ----------

function fakeRunner(answer: () => Promise<{ stdout: string; stderr: string }>): {
	run: SignalCommandRunner
	calls: { file: string; args: string[]; timeout: number }[]
} {
	const calls: { file: string; args: string[]; timeout: number }[] = []
	const run: SignalCommandRunner = async (file, args, opts) => {
		calls.push({ file, args, timeout: opts.timeout })
		return answer()
	}
	return { run, calls }
}

test('reader runs one read-only osascript call and maps the answer', async () => {
	const { run, calls } = fakeRunner(async () => ({ stdout: JSON.stringify(output), stderr: '' }))
	const reader = createMailSignalReader(config, { run, now: () => NOW })
	assert.equal(reader.source, 'mail')
	const { result, health } = await reader.read(new AbortController().signal)
	assert.deepEqual(health, { status: 'ok', detail: null })
	assert.equal(result?.complete, true)
	assert.equal(result?.goneReason, 'no longer unread in the inbox')
	assert.equal(result?.observations.length, 5)

	assert.equal(calls.length, 1)
	assert.equal(calls[0].file, 'osascript')
	assert.equal(calls[0].timeout, 45_000)
	assert.deepEqual(calls[0].args.slice(0, 4), ['-l', 'JavaScript', '-e', MAIL_JXA_SCRIPT])
	const scriptArgs = JSON.parse(calls[0].args[calls[0].args.length - 1])
	assert.equal(scriptArgs.since, '2026-01-08T10:00:00.000Z')
	assert.equal(scriptArgs.unreadOnly, true)
	assert.equal(scriptArgs.include.length, 4)
	assert.equal(new RegExp(scriptArgs.include[1], 'i').test('alerts@acme.sentry.io'), true)
})

test('a truncated or not running Mail never yields a complete poll', async () => {
	const truncated = fakeRunner(async () => ({ stdout: JSON.stringify({ ...output, truncated: true }), stderr: '' }))
	const partial = await createMailSignalReader(config, { run: truncated.run, now: () => NOW }).read(
		new AbortController().signal,
	)
	assert.equal(partial.result?.complete, false)
	assert.equal(partial.health.status, 'ok')

	const stopped = fakeRunner(async () => ({ stdout: JSON.stringify({ running: false }), stderr: '' }))
	const notRunning = await createMailSignalReader(config, { run: stopped.run, now: () => NOW }).read(
		new AbortController().signal,
	)
	assert.deepEqual(notRunning.result?.observations, [])
	assert.equal(notRunning.result?.complete, false)
	assert.deepEqual(notRunning.health, { status: 'unavailable', detail: 'Mail is not running' })
})

test('malformed messages are dropped and make the poll incomplete', async () => {
	const broken = { ...output, messages: [...output.messages, { messageId: '', subject: 1 }] }
	const { run } = fakeRunner(async () => ({ stdout: JSON.stringify(broken), stderr: '' }))
	const { result } = await createMailSignalReader(config, { run, now: () => NOW }).read(new AbortController().signal)
	assert.equal(result?.observations.length, 5)
	assert.equal(result?.complete, false)
})

test('automation permission, timeouts and other failures map to health', async () => {
	const fail = (fields: Record<string, unknown>) =>
		fakeRunner(async () => {
			throw Object.assign(new Error('Command failed'), fields)
		})

	const denied = fail({ code: 1, stderr: 'execution error: Not authorized to send Apple events to Mail. (-1743)' })
	const permission = await createMailSignalReader(config, { run: denied.run }).read(new AbortController().signal)
	assert.equal(permission.result, null)
	assert.deepEqual(permission.health, {
		status: 'needs_permission',
		detail: 'Allow node to control Mail in System Settings › Privacy & Security › Automation',
	})

	const slow = fail({ killed: true, signal: 'SIGTERM' })
	assert.deepEqual(
		(await createMailSignalReader(config, { run: slow.run }).read(new AbortController().signal)).health,
		{
			status: 'error',
			detail: 'Mail did not answer in time',
		},
	)

	const quit = fail({ code: 1, stderr: "execution error: Mail got an error: Application isn't running. (-600)" })
	assert.deepEqual(
		(await createMailSignalReader(config, { run: quit.run }).read(new AbortController().signal)).health,
		{
			status: 'unavailable',
			detail: 'Mail is not running',
		},
	)

	const other = fail({ code: 1, stderr: 'execution error: Something odd\nstack' })
	assert.deepEqual(
		(await createMailSignalReader(config, { run: other.run }).read(new AbortController().signal)).health,
		{
			status: 'error',
			detail: 'Mail read failed: execution error: Something odd',
		},
	)

	const garbage = fakeRunner(async () => ({ stdout: 'not json', stderr: '' }))
	const unreadable = await createMailSignalReader(config, { run: garbage.run }).read(new AbortController().signal)
	assert.deepEqual(unreadable.health, { status: 'error', detail: 'Mail returned an unreadable answer' })
})

// ---------- the JXA script itself, against a fake Mail ----------

interface FakeMessage {
	id: number
	messageId: string
	subject: string
	sender: string
	date: Date
	read: boolean
	flagged: boolean
	headers: string
}

interface FakeMailbox {
	name: string
	messages: FakeMessage[]
	/** Reading its messages throws (a mailbox Mail fails to read). */
	broken?: boolean
}

interface FakeAccount {
	name: string
	addresses: string[]
	mailboxes: FakeMailbox[]
	/** Listing its mailboxes throws (a broken or disabled account). */
	listBroken?: boolean
}

/**
 * A read-only fake of the JXA Mail object model: any property write throws. `messages` is the
 * unified inbox; `accounts` and `local` hold the named mailboxes the script may resolve.
 */
function fakeMail(
	messages: FakeMessage[],
	{
		running = true,
		accounts = [
			{ name: 'Personal', addresses: ['me@example.com'], mailboxes: [] },
			{ name: 'Work', addresses: ['me@work.example', 'alias@example.com'], mailboxes: [] },
		] as FakeAccount[],
		local = [] as FakeMailbox[],
	} = {},
) {
	const touched: string[] = []
	const queries: unknown[] = []
	/** Mailboxes whose messages were queried, by name (`inbox` for the unified inbox). */
	const read: string[] = []
	const readOnly = <T extends object>(target: T): T =>
		new Proxy(target, {
			set(_t, property) {
				throw new Error(`write to ${String(property)}`)
			},
			defineProperty(_t, property) {
				throw new Error(`define ${String(property)}`)
			},
		})
	const indexed = <T>(target: Record<string, unknown>, item: (index: number) => T) =>
		readOnly(
			new Proxy(target, {
				get(t, property) {
					if (typeof property === 'string' && /^\d+$/.test(property)) return item(Number(property))
					return t[property as string]
				},
			}),
		)
	const mailbox = (name: string, list: FakeMessage[], broken = false) => {
		// The inbox keeps the plain batch names the original tests assert on.
		const tag = name === 'inbox' ? '' : `${name}:`
		const batch =
			<K extends keyof FakeMessage>(key: K) =>
			() => {
				if (broken) throw new Error(`cannot read ${name}`)
				touched.push(`${tag}${key}`)
				return list.map(message => message[key])
			}
		const collection = indexed(
			{
				id: batch('id'),
				messageId: batch('messageId'),
				subject: batch('subject'),
				sender: batch('sender'),
				dateReceived: batch('date'),
				readStatus: batch('read'),
				flaggedStatus: batch('flagged'),
			},
			index => {
				const message = list[index]
				return readOnly({
					id: () => message.id,
					allHeaders: () => {
						touched.push(`allHeaders:${message.id}`)
						return message.headers
					},
				})
			},
		)
		return readOnly({
			messages: readOnly({
				whose: (query: unknown) => {
					queries.push(query)
					read.push(name)
					return collection
				},
			}),
		})
	}
	const mailboxes = (boxes: FakeMailbox[], listBroken = false) =>
		indexed(
			{
				name: () => {
					if (listBroken) throw new Error('cannot list mailboxes')
					return boxes.map(box => box.name)
				},
			},
			index => mailbox(boxes[index].name, boxes[index].messages, boxes[index].broken),
		)
	const accountObjects = accounts.map(account =>
		readOnly({
			name: () => account.name,
			emailAddresses: () => account.addresses,
			mailboxes: mailboxes(account.mailboxes, account.listBroken),
		}),
	)
	const mail = readOnly({
		running: () => running,
		inbox: mailbox('inbox', messages),
		mailboxes: mailboxes(local),
		accounts: readOnly(
			Object.assign(() => accountObjects, {
				emailAddresses: () => accounts.map(account => account.addresses),
			}),
		),
	})
	return { mail, touched, queries, read }
}

function runScript(mail: unknown, args: Parameters<typeof mailOsascriptArgs>[0]): ScriptOutput {
	const run = new Function('Application', `${MAIL_JXA_SCRIPT}\nreturn run`)((name: string) => {
		assert.equal(name, 'Mail')
		return mail
	}) as (argv: string[]) => string
	const argv = mailOsascriptArgs(args)
	return JSON.parse(run([argv[argv.length - 1]])) as ScriptOutput
}

const scriptArgs = {
	since: '2026-01-08T10:00:00.000Z',
	mailboxes: [] as string[],
	include: parseGlobList(mailSettings.includeSenders).map(globToRegExpSource),
	unreadOnly: true,
	maxMessages: 300,
	maxCandidates: 60,
	maxMailboxCandidates: 60,
}

const fakeMessages: FakeMessage[] = [
	{
		id: 1,
		messageId: 'reply@northwind.cz',
		subject: 'Re: Plan',
		sender: '"Petr Example" <petr@northwind.cz>',
		date: new Date('2026-01-14T09:00:00Z'),
		read: false,
		flagged: false,
		headers:
			'From: Petr Example <petr@northwind.cz>\nIn-Reply-To: <parent@northwind.cz>\nReferences: <root@northwind.cz>\n <parent@northwind.cz>\nSubject: Re: Plan\n\nbody text that must not leak',
	},
	{
		id: 2,
		messageId: 'news@list.example',
		subject: 'Digest',
		sender: 'List <news@list.example>',
		date: new Date('2026-01-14T08:00:00Z'),
		read: false,
		flagged: false,
		headers: 'List-Id: <digest.list.example>\nMessage-ID: <news@list.example>',
	},
	{
		id: 3,
		messageId: 'auto@ops.example',
		subject: 'Out of office',
		sender: 'ops@ops.example',
		date: new Date('2026-01-14T07:00:00Z'),
		read: false,
		flagged: true,
		headers: 'Auto-Submitted: auto-replied\nIn-Reply-To: <x@y.example>',
	},
	{
		id: 4,
		messageId: 'human@ops.example',
		subject: 'Hello',
		sender: 'Human <human@ops.example>',
		date: new Date('2026-01-14T06:00:00Z'),
		read: false,
		flagged: false,
		headers: 'Auto-Submitted: no\nPrecedence: normal',
	},
	{
		id: 5,
		messageId: 'read@ops.example',
		subject: 'Read already',
		sender: 'Human <human@ops.example>',
		date: new Date('2026-01-14T05:00:00Z'),
		read: true,
		flagged: false,
		headers: '',
	},
	{
		id: 6,
		messageId: 'alert@sentry.example',
		subject: '[Sentry] PROJ-1 boom',
		sender: 'Sentry <noreply@md.getsentry.com>',
		date: new Date('2026-01-14T04:00:00Z'),
		read: true,
		flagged: false,
		headers: 'Precedence: Bulk',
	},
]

test('JXA script reads in batches, reduces headers to bulk/root and never writes', () => {
	const { mail, touched, queries } = fakeMail(fakeMessages)
	const result = runScript(mail, scriptArgs)
	assert.equal(result.running, true)
	assert.equal(result.truncated, false)
	assert.deepEqual(result.myAddresses, ['me@example.com', 'me@work.example', 'alias@example.com'])
	assert.equal(queries.length, 1)

	const byId = new Map(result.messages.map(message => [message.messageId, message]))
	assert.deepEqual(
		[...byId.keys()],
		['reply@northwind.cz', 'news@list.example', 'auto@ops.example', 'human@ops.example', 'alert@sentry.example'],
	)
	assert.deepEqual(byId.get('reply@northwind.cz'), {
		messageId: 'reply@northwind.cz',
		subject: 'Re: Plan',
		senderName: 'Petr Example',
		senderAddress: 'petr@northwind.cz',
		dateReceived: '2026-01-14T09:00:00.000Z',
		read: false,
		flagged: false,
		bulk: false,
		root: 'root@northwind.cz',
		mailbox: null,
	})
	assert.equal(byId.get('news@list.example')?.bulk, true)
	assert.equal(byId.get('auto@ops.example')?.bulk, true)
	assert.equal(byId.get('auto@ops.example')?.root, 'x@y.example')
	assert.equal(byId.get('auto@ops.example')?.senderAddress, 'ops@ops.example')
	assert.equal(byId.get('human@ops.example')?.bulk, false)
	assert.equal(byId.get('human@ops.example')?.root, 'human@ops.example')
	assert.equal(byId.get('alert@sentry.example')?.bulk, true)
	assert.ok(!JSON.stringify(result).includes('body text'))

	// Headers only for candidates (the read, non-included message is skipped).
	assert.ok(!touched.includes('allHeaders:5'))
	assert.deepEqual(touched.slice(0, 7), ['id', 'messageId', 'subject', 'sender', 'date', 'read', 'flagged'])
})

test('JXA script does nothing when Mail is not running and flags truncation', () => {
	const stopped = fakeMail(fakeMessages, { running: false })
	assert.deepEqual(runScript(stopped.mail, scriptArgs), { running: false })
	assert.deepEqual(stopped.queries, [])

	const capped = runScript(fakeMail(fakeMessages).mail, { ...scriptArgs, maxCandidates: 2 })
	assert.equal(capped.truncated, true)
	assert.deepEqual(
		capped.messages.map(message => message.messageId),
		['reply@northwind.cz', 'news@list.example'],
	)

	const windowed = runScript(fakeMail(fakeMessages).mail, { ...scriptArgs, maxMessages: 1 })
	assert.equal(windowed.truncated, true)
	assert.equal(windowed.messages.length, 1)
})

test('Sentry is always in: default globs cover md.getsentry.com, and it survives an emptied include list', async () => {
	const { DEFAULT_SIGNAL_INCLUDE_SENDERS } = await import('../src/config.js')
	assert.equal(matchesGlob('noreply@md.getsentry.com', parseGlobList(DEFAULT_SIGNAL_INCLUDE_SENDERS)), true)

	const sentry: MailMessageHead = {
		messageId: 'alert@md.getsentry.com',
		subject: '[Sentry] PROJ-9 boom',
		senderName: 'Sentry',
		senderAddress: 'noreply@md.getsentry.com',
		dateReceived: '2026-01-15T09:00:00.000Z',
		read: true,
		flagged: false,
		bulk: true,
		root: 'alert@md.getsentry.com',
	}
	const kept = filterMail([sentry], options({ includeSenders: [] }), NOW)
	assert.deepEqual(ids(kept), ['alert@md.getsentry.com'])
	// Still bounded by age.
	assert.deepEqual(
		filterMail([{ ...sentry, dateReceived: '2025-12-01T00:00:00.000Z' }], options({ includeSenders: [] }), NOW),
		[],
	)

	// The JXA script makes a read Sentry message a candidate without any include regex.
	const { mail, touched } = fakeMail(fakeMessages)
	const result = runScript(mail, { ...scriptArgs, include: [] })
	assert.ok(result.messages.some(message => message.messageId === 'alert@sentry.example'))
	assert.ok(touched.includes('allHeaders:6'))
	assert.ok(!touched.includes('allHeaders:5'))
})

// ---------- bulk markers and Apple Hide My Email relays ----------

interface HeaderCase {
	name: string
	sender: string
	bulk: boolean
	headers: string
}

const headerCases = (
	JSON.parse(readFileSync(new URL('./fixtures/signals/mail-headers.json', import.meta.url), 'utf8')) as {
		cases: HeaderCase[]
	}
).cases

function headerMessages(cases: HeaderCase[], read = false): FakeMessage[] {
	return cases.map((entry, index) => ({
		id: 100 + index,
		messageId: `case-${index}@fixture.example`,
		subject: entry.name,
		sender: entry.sender,
		date: new Date(Date.UTC(2026, 0, 14, 12, 0, 0) - index * 60_000),
		read,
		flagged: false,
		headers: entry.headers,
	}))
}

test('JXA bulk markers: list headers, List-Unsubscribe-Post and the X-Campaign names are bulk; transport fingerprints and person mail are not', () => {
	const result = runScript(fakeMail(headerMessages(headerCases)).mail, scriptArgs)
	assert.equal(result.messages.length, headerCases.length)
	for (const [index, entry] of headerCases.entries()) {
		const message = result.messages.find(candidate => candidate.messageId === `case-${index}@fixture.example`)
		assert.ok(message, entry.name)
		assert.equal(message.bulk, entry.bulk, entry.name)
	}
	assert.ok(headerCases.some(entry => entry.bulk) && headerCases.some(entry => !entry.bulk))
})

test('JXA bulk: List-Unsubscribe-Post alone (the relayed StartupJobs alert) is bulk, Auto-Submitted no is not', () => {
	const base = { id: 1, messageId: 'x@y.example', subject: 's', sender: 'a@b.example', read: false, flagged: false }
	const bulkOf = (headers: string) =>
		runScript(fakeMail([{ ...base, date: new Date('2026-01-14T00:00:00Z'), headers }]).mail, scriptArgs).messages[0]
			.bulk
	assert.equal(bulkOf('List-Unsubscribe-Post: List-Unsubscribe=One-Click'), true)
	assert.equal(bulkOf('list-unsubscribe-post: List-Unsubscribe=One-Click'), true)
	assert.equal(bulkOf('X-Campaign-Id: 1'), true)
	assert.equal(bulkOf('X-CampaignID: 1'), true)
	assert.equal(bulkOf('X-Campaign: mailchimp1'), true)
	assert.equal(bulkOf('X-Campaign-Source: portal'), false)
	assert.equal(bulkOf('X-Auto-Response-Suppress: All\nX-Mandrill-User: md_1\nX-PM-Message-Id: 1'), false)
	assert.equal(bulkOf('Auto-Submitted: no\nFeedback-ID: 1:a:b:c\nX-SES-Outgoing: x'), false)
	assert.equal(bulkOf('Subject: X-Campaign-Id: 1'), false)
})

test('the relayed StartupJobs newsletter is dropped by default and its row would be named Startupjobs', () => {
	const relayed = runScript(fakeMail(headerMessages(headerCases.slice(0, 1))).mail, scriptArgs).messages
	assert.equal(relayed.length, 1)
	assert.equal(relayed[0].senderAddress, 'jobot_at_startupjobs_cz_pp77sqsgqd_3e707591@privaterelay.appleid.com')
	assert.deepEqual(filterMail(relayed, options(), NOW), [])
	const [row] = mapMailThreads(filterMail(relayed, options({ excludeBulk: false }), NOW))
	assert.equal(row.ref, 'Startupjobs')
	assert.equal(row.fullRef, 'StartupJobs <jobot@startupjobs.cz> via Hide My Email')
	assert.equal(row.actor, 'StartupJobs')
})

test('Apple relay addresses decode to the original sender, or to nothing', () => {
	const relay = (local: string) => `${local}@privaterelay.appleid.com`
	assert.equal(relayedSenderAddress(relay('jobot_at_startupjobs_cz_pp77sqsgqd_3e707591')), 'jobot@startupjobs.cz')
	assert.equal(
		relayedSenderAddress(relay('kamila.example_at_startupjobs_cz_pp77sqsgqd_fb028362')),
		'kamila.example@startupjobs.cz',
	)
	assert.equal(relayedSenderAddress(relay('noreply_at_pdffiller_com_6v2y9yftm9_2aa5dead')), 'noreply@pdffiller.com')
	assert.equal(
		relayedSenderAddress(relay('a.b-c_at_mail_my-shop_co_uk_4wb6bxhxvn_0c0003cd')),
		'a.b-c@mail.my-shop.co.uk',
	)
	// The first `_at_` splits user from domain, so an Austrian domain stays decodable.
	assert.equal(relayedSenderAddress(relay('office_at_firma_at_4wb6bxhxvn_0c0003cd')), 'office@firma.at')
	// Case and whitespace do not matter.
	assert.equal(
		relayedSenderAddress(` ${relay('Info_AT_Qerko_COM_4wb6bxhxvn_0c0003cd').toUpperCase()} `),
		'info@qerko.com',
	)

	for (const undecodable of [
		relay('nobody'),
		relay('a_at_b_4wb6bxhxvn_0c0003cd'), // one-label domain
		relay('a_at_example_com'), // no relay token
		relay('a_at_example_com_4wb6bxhxvn'), // no hex
		relay('a_at_example_123_4wb6bxhxvn_0c0003cd'), // numeric top label
		relay('a_at_-bad_com_4wb6bxhxvn_0c0003cd'),
		relay(`${'u'.repeat(400)}_at_example_com_4wb6bxhxvn_0c0003cd`),
		'jobot_at_startupjobs_cz_pp77sqsgqd_3e707591@privaterelay.appleid.com.evil.example',
		'jobot_at_startupjobs_cz_pp77sqsgqd_3e707591@evil.example',
		'',
	]) {
		assert.equal(relayedSenderAddress(undecodable), null, undecodable)
	}
	// Sign in with Apple's newer domain and iCloud+ Hide My Email (on icloud.com) relay the same way;
	// an ordinary iCloud user is left alone.
	assert.equal(relayedSenderAddress('hello_at_sarunw_com_4wb6bxhxvn_0c0003cd@private.icloud.com'), 'hello@sarunw.com')
	assert.equal(relayedSenderAddress('test_at_davemail_io_5rvrmv74x77007_62a85f4e@icloud.com'), 'test@davemail.io')
	assert.equal(relayedSenderAddress('jakub.example@icloud.com'), null)
	assert.equal(relayedSenderAddress('john_at_home@icloud.com'), null)
	assert.equal(senderIdentity(' Petr@Northwind.CZ '), 'petr@northwind.cz')
	assert.equal(senderIdentity(relay('jobot_at_startupjobs_cz_pp77sqsgqd_3e707591')), 'jobot@startupjobs.cz')
})

test('relay senders are named by the original domain, else by display name, never "Appleid"', () => {
	const relay = 'jobot_at_startupjobs_cz_pp77sqsgqd_3e707591@privaterelay.appleid.com'
	assert.equal(mailRef('StartupJobs', relay), 'Startupjobs')
	assert.equal(mailRef('', relay), 'Startupjobs')
	assert.equal(mailRef('Friend', 'friend_at_gmail_com_4wb6bxhxvn_0c0003cd@privaterelay.appleid.com'), 'Friend')
	assert.equal(mailRef('', 'friend_at_gmail_com_4wb6bxhxvn_0c0003cd@privaterelay.appleid.com'), 'friend')
	assert.equal(mailRef('Some Shop', 'garbled@privaterelay.appleid.com'), 'Some Shop')
	assert.equal(mailRef('  ', 'garbled@privaterelay.appleid.com'), 'Mail')
	assert.equal(mailRef('', 'garbled@private.icloud.com'), 'Mail')
	assert.equal(mailRef('Dave', 'test_at_davemail_io_5rvrmv74x77007_62a85f4e@icloud.com'), 'Davemail')
	// An ordinary iCloud user is still a person.
	assert.equal(mailRef('Ann Example', 'ann_example@icloud.com'), 'Ann Example')
	assert.equal(mailFullRef('Ann', 'ann@icloud.com'), 'Ann <ann@icloud.com>')
	for (const address of [relay, 'garbled@privaterelay.appleid.com', 'x_at_y@privaterelay.appleid.com']) {
		for (const name of ['', 'Name']) assert.notEqual(mailRef(name, address).toLowerCase(), 'appleid')
	}
	assert.equal(mailFullRef('StartupJobs', relay), 'StartupJobs <jobot@startupjobs.cz> via Hide My Email')
	assert.equal(mailFullRef('', 'garbled@privaterelay.appleid.com'), 'garbled@privaterelay.appleid.com')
	assert.equal(mailFullRef('Petr', 'Petr@Northwind.cz'), 'Petr <petr@northwind.cz>')
})

test('include and exclude globs match the decoded relay sender as well as the raw address', () => {
	const message: MailMessageHead = {
		messageId: 'r1@startupjobs.cz',
		subject: 'Pozice',
		senderName: 'Jana',
		senderAddress: 'jana_at_startupjobs_cz_pp77sqsgqd_fb028362@privaterelay.appleid.com',
		dateReceived: '2026-01-15T09:00:00.000Z',
		read: false,
		flagged: false,
		bulk: false,
		root: 'r1@startupjobs.cz',
	}
	assert.equal(filterMail([message], options(), NOW).length, 1)
	assert.equal(filterMail([message], options({ excludeSenders: ['*@startupjobs.cz'] }), NOW).length, 0)
	assert.equal(filterMail([message], options({ excludeSenders: ['*@privaterelay.appleid.com'] }), NOW).length, 0)
	// Include beats read, bulk and exclude, by decoded or raw address.
	const noisy = { ...message, read: true, bulk: true }
	for (const include of ['*@startupjobs.cz', 'jana_at_*@privaterelay.appleid.com']) {
		assert.equal(
			filterMail([noisy], options({ includeSenders: [include], excludeSenders: ['*@startupjobs.cz'] }), NOW).length,
			1,
			include,
		)
	}
	// A relayed Sentry alert is still Sentry: in, and grouped by short id.
	const sentry = {
		...noisy,
		messageId: 'alert@sentry.example',
		subject: '[Sentry] PROJ-7 boom',
		senderAddress: 'noreply_at_md_getsentry_com_4wb6bxhxvn_0c0003cd@privaterelay.appleid.com',
	}
	const kept = filterMail([sentry], options({ includeSenders: [] }), NOW)
	assert.equal(kept.length, 1)
	assert.equal(mapMailThreads(kept)[0].threadKey, 'sentry:PROJ-7')
})

test('JXA candidates: a read relayed sender is a candidate when its decoded address is included', () => {
	const cases = headerMessages(headerCases.slice(7, 8), true) // the relayed recruiter, already read
	const plain = runScript(fakeMail(cases).mail, scriptArgs)
	assert.deepEqual(plain.messages, [])
	const included = runScript(fakeMail(cases).mail, {
		...scriptArgs,
		include: [...scriptArgs.include, globToRegExpSource('*@startupjobs.cz')],
	})
	assert.equal(included.messages.length, 1)
	const sentry = runScript(
		fakeMail([
			{
				...cases[0],
				sender: 'Sentry <noreply_at_md_getsentry_com_4wb6bxhxvn_0c0003cd@privaterelay.appleid.com>',
				headers: 'Precedence: bulk',
			},
		]).mail,
		{ ...scriptArgs, include: [] },
	)
	assert.equal(sentry.messages.length, 1)
	assert.equal(sentry.messages[0].bulk, true)
})

test('the JXA relay decoder mirrors relayedSenderAddress', () => {
	const start = MAIL_JXA_SCRIPT.indexOf('function relayDecode')
	const end = MAIL_JXA_SCRIPT.indexOf('function isBulk')
	assert.ok(start > 0 && end > start)
	const decode = new Function(`${MAIL_JXA_SCRIPT.slice(start, end)}\nreturn relayDecode`)() as (
		address: string,
	) => string | null
	const samples = [
		...headerCases.map(entry => entry.sender.match(/<([^>]+)>/)?.[1] ?? entry.sender),
		'office_at_firma_at_4wb6bxhxvn_0c0003cd@privaterelay.appleid.com',
		'a_at_b_4wb6bxhxvn_0c0003cd@privaterelay.appleid.com',
		'a_at_example_123_4wb6bxhxvn_0c0003cd@privaterelay.appleid.com',
		'x_at_xn--bcher-kva_ch_4wb6bxhxvn_0c0003cd@privaterelay.appleid.com',
		'x_at_a--b_com_4wb6bxhxvn_0c0003cd@privaterelay.appleid.com',
		' Info_AT_Qerko_COM_4wb6bxhxvn_0c0003cd@PrivateRelay.AppleID.com ',
		`${'u'.repeat(380)}_at_example_com_4wb6bxhxvn_0c0003cd@privaterelay.appleid.com`,
		`${'u'.repeat(400)}_at_example_com_4wb6bxhxvn_0c0003cd@privaterelay.appleid.com`,
		'garbled@privaterelay.appleid.com',
		'hello_at_sarunw_com_4wb6bxhxvn_0c0003cd@private.icloud.com',
		'test_at_davemail_io_5rvrmv74x77007_62a85f4e@icloud.com',
		'jakub.example@icloud.com',
		'plain_at_example_com_4wb6bxhxvn_0c0003cd@example.com',
		'plain@example.com',
	]
	for (const sample of samples) assert.equal(decode(sample), relayedSenderAddress(sample), sample)
})

// ---------- extra mailboxes (signals.mail.mailboxes) ----------

const mailboxOutput = JSON.parse(
	readFileSync(new URL('./fixtures/signals/mail-mailboxes-output.json', import.meta.url), 'utf8'),
) as ScriptOutput & { missingMailboxes: string[]; unreadableMailboxes: string[] }

function configWith(mail: Partial<typeof mailSettings>): HelmConfig {
	return { signals: { mail: { ...mailSettings, ...mail } } } as unknown as HelmConfig
}

test('config: signals.mail.mailboxes defaults to none, saves as one mailbox per line and has a Settings field', async () => {
	const { configSchema } = await import('../src/config.js')
	const { buildConfigDocument, parseConfigUpdate } = await import('../src/config-document.js')
	const base = {
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'test' },
		projects: [{ slug: 'helm', repoPath: '/repo' }],
	}
	const defaults = configSchema.parse(base)
	assert.equal(defaults.signals.mail.mailboxes, '')

	const mailboxes = 'Clientcare\nneumann@contember.com/Clientcare'
	const saved = parseConfigUpdate({ ...base, signals: { mail: { mailboxes } } }, defaults)
	assert.ok(saved.success)
	assert.equal(saved.data.signals.mail.mailboxes, mailboxes)
	assert.equal(configSchema.parse(JSON.parse(JSON.stringify(saved.data))).signals.mail.mailboxes, mailboxes)
	assert.equal(
		parseConfigUpdate({ ...base, signals: { mail: { mailboxes: ['Clientcare'] } } }, defaults).success,
		false,
	)
	assert.equal(
		parseConfigUpdate({ ...base, signals: { mail: { mailboxes: 'x'.repeat(2001) } } }, defaults).success,
		false,
	)

	const doc = buildConfigDocument(defaults, defaults)
	const section = doc.edit.sections.find(entry => entry.id === 'signals')
	assert.ok(section)
	const paths = section.controls.map(control => control.path.join('.'))
	const field = section.controls.find(control => control.path.join('.') === 'signals.mail.mailboxes')
	assert.ok(field && field.type === 'field')
	assert.equal(field.input, 'textarea')
	// Right after the sender filters, like them one per line.
	assert.equal(paths.indexOf('signals.mail.mailboxes'), paths.indexOf('signals.mail.excludeSenders') + 1)
})

test('mailbox lists are one per line, trimmed, without blank lines or case-insensitive repeats', () => {
	assert.deepEqual(parseMailboxList('  Clientcare \n\nclientcare\r\nneumann@contember.com/Clientcare\n  \n'), [
		'Clientcare',
		'neumann@contember.com/Clientcare',
	])
	assert.deepEqual(parseMailboxList(''), [])
})

const work: MailAccountIdentity = { name: 'Contember', addresses: ['neumann@contember.com', 'jakub@contember.com'] }

test('mailbox entries match the mailbox name, optionally qualified with the account name or address', () => {
	assert.equal(mailboxEntryMatches('Clientcare', work, 'Clientcare'), true)
	assert.equal(mailboxEntryMatches(' CLIENTCARE ', work, 'clientcare'), true)
	assert.equal(mailboxEntryMatches('Clientcare', null, 'Clientcare'), true)
	assert.equal(mailboxEntryMatches('neumann@contember.com/Clientcare', work, 'Clientcare'), true)
	assert.equal(mailboxEntryMatches('Neumann@Contember.com / clientcare', work, 'Clientcare'), true)
	assert.equal(mailboxEntryMatches('jakub@contember.com/Clientcare', work, 'Clientcare'), true)
	assert.equal(mailboxEntryMatches('contember/Clientcare', work, 'Clientcare'), true)
	// Another account, another mailbox, a local mailbox, an empty entry: no.
	assert.equal(mailboxEntryMatches('me@example.com/Clientcare', work, 'Clientcare'), false)
	assert.equal(mailboxEntryMatches('neumann@contember.com/Clientcare', work, 'Archive'), false)
	assert.equal(mailboxEntryMatches('neumann@contember.com/Clientcare', null, 'Clientcare'), false)
	assert.equal(mailboxEntryMatches('/Clientcare', work, 'Clientcare'), false)
	assert.equal(mailboxEntryMatches('', work, ''), false)
	assert.equal(mailboxEntryMatches('Client', work, 'Clientcare'), false)
	// The mailbox's own name, not its path.
	assert.equal(mailboxEntryMatches('All Mail', work, 'All Mail'), true)
	assert.equal(mailboxEntryMatches('[Gmail]/All Mail', work, 'All Mail'), false)
})

test('the JXA mailbox matcher mirrors mailboxEntryMatches', () => {
	const start = MAIL_JXA_SCRIPT.indexOf('function mailboxMatches')
	const end = MAIL_JXA_SCRIPT.indexOf('function idKey')
	assert.ok(start > 0 && end > start)
	const matches = new Function(
		`${MAIL_JXA_SCRIPT.slice(start, end)}\nreturn mailboxMatches`,
	)() as typeof mailboxEntryMatches
	const entries = [
		'Clientcare',
		' CLIENTCARE ',
		'neumann@contember.com/Clientcare',
		'Neumann@Contember.com / clientcare',
		'contember/Clientcare',
		'me@example.com/Clientcare',
		'/Clientcare',
		'Clientcare/',
		'[Gmail]/All Mail',
		'All Mail',
		'',
		'a/b/c',
	]
	const accounts = [work, null, { name: 'a', addresses: [] }]
	for (const entry of entries) {
		for (const account of accounts) {
			for (const mailbox of ['Clientcare', 'All Mail', 'b/c', '']) {
				assert.equal(
					matches(entry, account, mailbox),
					mailboxEntryMatches(entry, account, mailbox),
					`${entry} | ${account?.name} | ${mailbox}`,
				)
			}
		}
	}
})

test('the same Message-ID in several mailboxes is one message, the inbox copy first', () => {
	const kept = dedupeMailMessages(mailboxOutput.messages)
	assert.equal(kept.length, mailboxOutput.messages.length - 1)
	const both = kept.filter(message => message.messageId.toLowerCase().includes('both@northwind.cz'))
	assert.equal(both.length, 1)
	assert.equal(both[0].mailbox, null)
	// Without an inbox copy the first one listed stays, order kept.
	const labelled = mailboxOutput.messages.filter(message => message.mailbox)
	assert.deepEqual(dedupeMailMessages(labelled), labelled)
	const twice = [labelled[0], { ...labelled[0], mailbox: 'Important' }]
	assert.deepEqual(dedupeMailMessages(twice), [labelled[0]])
})

test('mail from an extra mailbox goes through the same filter and its row says which mailbox', () => {
	const threads = mapMailThreads(filterMail(dedupeMailMessages(mailboxOutput.messages), options(), NOW))
	assert.deepEqual(threads.map(thread => thread.head).sort(), [
		'Clientcare · [JVS] Pavel commented on Export faktur',
		'Clientcare · [Psyon] New task: Indikace klientů přidaných do konzilia',
		'Contract (in the inbox and labelled)',
	])
	const task = threads.find(thread => thread.title.startsWith('[Psyon] New task'))
	assert.ok(task)
	assert.equal(task.kind, 'mail')
	assert.equal(task.ref, 'Contember')
	assert.equal(task.title, '[Psyon] New task: Indikace klientů přidaných do konzilia')
	assert.equal(task.activityKey, 'task-1@clientcare.example')

	// Read (unread-only), bulk (List-Id) and old mail stay out exactly as in the inbox; read in when asked.
	const all = mapMailThreads(
		filterMail(dedupeMailMessages(mailboxOutput.messages), options({ unreadOnly: false, excludeBulk: false }), NOW),
	)
	assert.equal(all.length, 5)
	assert.ok(all.some(thread => thread.head === 'Clientcare · Weekly digest'))
	assert.ok(all.some(thread => thread.head === 'Clientcare · [JVS] Old comment'))
	// Exclude globs apply too.
	const excluded = filterMail(mailboxOutput.messages, options({ excludeSenders: ['*@contember.dev'] }), NOW)
	assert.ok(excluded.every(message => message.senderAddress !== 'notifications@contember.dev'))
})

test('mailbox labels are bounded, one line, and never push the head past its limit', () => {
	const [message] = mailboxOutput.messages
	const [thread] = mapMailThreads([
		{ ...message, mailbox: `Label\nwith\u0007control ${'x'.repeat(200)}`, subject: 'y'.repeat(400) },
	])
	assert.ok(thread.head.length <= 300)
	assert.match(thread.head, /^Label with control x+… · y+…$/)
	const [sentry] = mapMailThreads([
		{ ...message, senderAddress: 'noreply@md.getsentry.com', subject: '[Sentry] PROJ-9 boom', mailbox: 'Alerts' },
	])
	assert.equal(sentry.head, 'Alerts · PROJ-9 boom')
	const [grouped] = mapMailThreads([
		message,
		{ ...message, messageId: 'reply@clientcare.example', dateReceived: '2026-01-15T09:30:00.000Z' },
	])
	assert.equal(grouped.head, 'Clientcare · [Psyon] New task: Indikace klientů přidaných do konzilia · 2 messages')
})

test('reader passes the configured mailboxes, dedupes them and labels their rows', async () => {
	const { run, calls } = fakeRunner(async () => ({ stdout: JSON.stringify(mailboxOutput), stderr: '' }))
	const reader = createMailSignalReader(
		configWith({ mailboxes: 'Clientcare\n\nclientcare\nneumann@contember.com/Archive\n' }),
		{
			run,
			now: () => NOW,
		},
	)
	const { result, health } = await reader.read(new AbortController().signal)
	assert.deepEqual(health, { status: 'ok', detail: null })
	assert.equal(result?.complete, true)
	assert.equal(result?.observations.length, 3)
	assert.ok(result?.observations.some(thread => thread.head.startsWith('Clientcare · [Psyon] New task')))
	const scriptArgs = JSON.parse(calls[0].args[calls[0].args.length - 1])
	assert.deepEqual(scriptArgs.mailboxes, ['Clientcare', 'neumann@contember.com/Archive'])

	// No mailboxes configured: none asked for.
	const plain = fakeRunner(async () => ({ stdout: JSON.stringify(output), stderr: '' }))
	await createMailSignalReader(config, { run: plain.run, now: () => NOW }).read(new AbortController().signal)
	assert.deepEqual(JSON.parse(plain.calls[0].args[plain.calls[0].args.length - 1]).mailboxes, [])
})

test('a missing or unreadable mailbox keeps the poll incomplete and says so', async () => {
	const answer = { ...mailboxOutput, missingMailboxes: ['Clientcar'], unreadableMailboxes: ['Archive'] }
	const { run } = fakeRunner(async () => ({ stdout: JSON.stringify(answer), stderr: '' }))
	const { result, health } = await createMailSignalReader(configWith({ mailboxes: 'Clientcar\nArchive' }), {
		run,
		now: () => NOW,
	}).read(new AbortController().signal)
	assert.equal(result?.complete, false)
	assert.equal(result?.observations.length, 3)
	assert.deepEqual(health, { status: 'error', detail: 'no mailbox named "Clientcar"; could not read "Archive"' })

	// More entries than the bound: the rest are not read, and the footer says so.
	const many = Array.from({ length: 22 }, (_, index) => `Box ${index}`).join('\n')
	const capped = fakeRunner(async () => ({ stdout: JSON.stringify(mailboxOutput), stderr: '' }))
	const read = await createMailSignalReader(configWith({ mailboxes: many }), { run: capped.run, now: () => NOW }).read(
		new AbortController().signal,
	)
	assert.equal(JSON.parse(capped.calls[0].args[capped.calls[0].args.length - 1]).mailboxes.length, 20)
	assert.deepEqual(read.health, { status: 'error', detail: 'only the first 20 listed mailboxes are read' })
})

const clientcareMessages: FakeMessage[] = [
	{
		id: 201,
		messageId: 'task-1@clientcare.example',
		subject: '[Psyon] New task: Indikace klientů přidaných do konzilia',
		sender: 'ClientCare <notifications@contember.dev>',
		date: new Date('2026-01-14T11:00:00Z'),
		read: false,
		flagged: false,
		headers: 'Feedback-ID: 123:clientcare:contember\nMessage-ID: <task-1@clientcare.example>',
	},
	{
		id: 202,
		messageId: '<Reply@Northwind.cz>',
		subject: 'Re: Plan (also labelled)',
		sender: '"Petr Example" <petr@northwind.cz>',
		date: new Date('2026-01-14T09:00:00Z'),
		read: false,
		flagged: false,
		headers: 'References: <root@northwind.cz>',
	},
	{
		id: 203,
		messageId: 'read-task@clientcare.example',
		subject: '[JVS] read already',
		sender: 'ClientCare <notifications@contember.dev>',
		date: new Date('2026-01-14T10:00:00Z'),
		read: true,
		flagged: false,
		headers: '',
	},
	{
		id: 204,
		messageId: 'ancient@clientcare.example',
		subject: 'outside the window',
		sender: 'ClientCare <notifications@contember.dev>',
		date: new Date('2025-01-01T10:00:00Z'),
		read: false,
		flagged: false,
		headers: '',
	},
]

const allMailMessages: FakeMessage[] = [
	{ ...clientcareMessages[0], id: 301 },
	{
		id: 302,
		messageId: 'archived@elsewhere.example',
		subject: 'Only in All Mail',
		sender: 'Someone <someone@elsewhere.example>',
		date: new Date('2026-01-14T08:30:00Z'),
		read: false,
		flagged: false,
		headers: '',
	},
]

function gmailAccounts(clientcare = clientcareMessages, broken = false): FakeAccount[] {
	return [
		{ name: 'iCloud', addresses: ['me@example.com'], mailboxes: [{ name: 'Archive', messages: [] }] },
		{
			name: 'neumann@contember.com',
			addresses: ['neumann@contember.com'],
			mailboxes: [
				{ name: 'All Mail', messages: allMailMessages },
				{ name: 'Trash', messages: allMailMessages },
				{ name: 'Spam', messages: allMailMessages },
				{ name: 'Sent Mail', messages: allMailMessages },
				{ name: 'Clientcare', messages: clientcare, broken },
				{ name: 'INBOX', messages: [] },
			],
		},
	]
}

test('JXA reads the inbox plus the listed mailboxes only, dedupes by Message-ID and labels the source', () => {
	const { mail, read, touched, queries } = fakeMail(fakeMessages, { accounts: gmailAccounts() })
	const result = runScript(mail, { ...scriptArgs, mailboxes: ['neumann@contember.com/clientcare'] })
	// Never All Mail, Trash, Spam or Sent unless listed; the inbox first.
	assert.deepEqual(read, ['inbox', 'Clientcare'])
	assert.equal(result.truncated, false)
	assert.deepEqual((result as unknown as { missingMailboxes: string[] }).missingMailboxes, [])

	const byId = new Map(result.messages.map(message => [message.messageId, message]))
	const task = byId.get('task-1@clientcare.example')
	assert.ok(task)
	assert.equal(task.mailbox, 'Clientcare')
	assert.equal(task.bulk, false) // Feedback-ID is a transport fingerprint, never bulk.
	// The labelled copy of an inbox message is the inbox one.
	assert.equal(result.messages.filter(message => message.messageId.toLowerCase() === 'reply@northwind.cz').length, 1)
	assert.equal(byId.get('reply@northwind.cz')?.mailbox, null)
	// Same unread-only rule and window: the read one is not a candidate (no headers read).
	assert.ok(!byId.has('read-task@clientcare.example'))
	assert.ok(!touched.includes('allHeaders:203'))
	assert.ok(!touched.includes('allHeaders:202'))
	// Newest first across mailboxes.
	const dates = result.messages.map(message => message.dateReceived)
	assert.deepEqual(dates, [...dates].sort().reverse())
	// One query per mailbox, all with the same window.
	assert.equal(queries.length, 2)
	for (const query of queries) {
		const since = (query as { dateReceived: { _greaterThan: Date } }).dateReceived._greaterThan
		assert.equal(since.toISOString(), scriptArgs.since)
	}
})

test('JXA mailbox entries: unqualified names match in every account and local mailboxes; All Mail only when listed', () => {
	const local = [
		{ name: 'Clientcare', messages: [{ ...clientcareMessages[0], id: 401, messageId: 'local@clientcare.example' }] },
	]
	const unqualified = fakeMail([], { accounts: gmailAccounts(), local })
	const result = runScript(unqualified.mail, { ...scriptArgs, mailboxes: ['CLIENTCARE'] })
	assert.deepEqual(unqualified.read, ['inbox', 'Clientcare', 'Clientcare'])
	const labels = new Map(result.messages.map(message => [message.messageId, message.mailbox]))
	assert.equal(labels.get('local@clientcare.example'), 'Clientcare')
	assert.equal(labels.get('task-1@clientcare.example'), 'Clientcare')

	const explicit = fakeMail([], { accounts: gmailAccounts() })
	const allMail = runScript(explicit.mail, { ...scriptArgs, mailboxes: ['Clientcare', 'All Mail'] })
	// In the order of the entries, not Mail's: mail in both reads as Clientcare.
	assert.deepEqual(explicit.read, ['inbox', 'Clientcare', 'All Mail'])
	const task = allMail.messages.filter(message => message.messageId === 'task-1@clientcare.example')
	assert.equal(task.length, 1)
	assert.equal(task[0].mailbox, 'Clientcare')
	assert.ok(
		allMail.messages.some(
			message => message.messageId === 'archived@elsewhere.example' && message.mailbox === 'All Mail',
		),
	)

	// A qualified entry for another account reads nothing and is reported missing.
	const other = fakeMail([], { accounts: gmailAccounts() })
	const missing = runScript(other.mail, {
		...scriptArgs,
		mailboxes: ['me@example.com/Clientcare', 'Nope'],
	}) as unknown as {
		truncated: boolean
		messages: MailMessageHead[]
		missingMailboxes: string[]
	}
	assert.deepEqual(other.read, ['inbox'])
	assert.deepEqual(missing.missingMailboxes, ['me@example.com/Clientcare', 'Nope'])
	assert.equal(missing.truncated, false)
})

test('JXA: one unreadable mailbox leaves the rest read and is reported; the inbox failing fails the read', () => {
	const broken = fakeMail(fakeMessages, { accounts: gmailAccounts(clientcareMessages, true) })
	const result = runScript(broken.mail, { ...scriptArgs, mailboxes: ['Clientcare'] }) as unknown as ScriptOutput & {
		unreadableMailboxes: string[]
	}
	assert.equal(result.truncated, true)
	assert.deepEqual(result.unreadableMailboxes, ['Clientcare'])
	assert.ok(result.messages.some(message => message.messageId === 'reply@northwind.cz'))

	const { mail } = fakeMail(fakeMessages, { accounts: gmailAccounts() })
	const failingInbox = new Proxy(mail, {
		get(target, property) {
			if (property === 'inbox')
				return {
					messages: {
						whose: () => ({
							id: () => {
								throw new Error('Not authorized (-1743)')
							},
						}),
					},
				}
			return Reflect.get(target, property)
		},
	})
	assert.throws(() => runScript(failingInbox, { ...scriptArgs, mailboxes: ['Clientcare'] }), /-1743/)
})

test('JXA: the extra mailboxes are bounded per mailbox and in number', () => {
	const many: FakeAccount[] = [
		{
			name: 'Work',
			addresses: ['me@work.example'],
			mailboxes: Array.from({ length: 15 }, (_, index) => ({
				name: 'Clientcare',
				messages: index === 0 ? clientcareMessages : [],
			})),
		},
	]
	const capped = fakeMail([], { accounts: many })
	const result = runScript(capped.mail, { ...scriptArgs, mailboxes: ['Clientcare'] })
	assert.equal(capped.read.length, 1 + 12)
	assert.equal(result.truncated, true)
	const reported = result as unknown as { missingMailboxes: string[]; skippedMailboxes: string[] }
	assert.deepEqual(reported.missingMailboxes, [])
	assert.deepEqual(reported.skippedMailboxes, ['Clientcare'])

	const windowed = runScript(fakeMail([], { accounts: gmailAccounts() }).mail, {
		...scriptArgs,
		mailboxes: ['Clientcare'],
		maxMessages: 1,
	})
	assert.equal(windowed.truncated, true)
	assert.deepEqual(
		windowed.messages.map(message => message.messageId),
		['task-1@clientcare.example'],
	)
	assert.deepEqual((windowed as unknown as { cappedMailboxes: string[] }).cappedMailboxes, ['Clientcare'])
	// The inbox over its window is truncated as before, but is not an extra mailbox to report.
	const inboxWindow = runScript(fakeMail(fakeMessages, { accounts: gmailAccounts([]) }).mail, {
		...scriptArgs,
		mailboxes: ['Clientcare'],
		maxMessages: 1,
	})
	assert.equal(inboxWindow.truncated, true)
	assert.deepEqual((inboxWindow as unknown as { cappedMailboxes: string[] }).cappedMailboxes, [])
})

test('JXA: a busy extra mailbox has its own candidate budget and never crowds inbox mail out', () => {
	const busy: FakeMessage[] = Array.from({ length: 5 }, (_, index) => ({
		...clientcareMessages[0],
		id: 500 + index,
		messageId: `busy-${index}@clientcare.example`,
		// Newer than every inbox message.
		date: new Date(Date.UTC(2026, 0, 14, 20, index)),
	}))
	const { mail } = fakeMail(fakeMessages, { accounts: gmailAccounts(busy) })
	const result = runScript(mail, {
		...scriptArgs,
		mailboxes: ['Clientcare'],
		maxCandidates: 2,
		maxMailboxCandidates: 3,
	})
	const inbox = result.messages.filter(message => message.mailbox === null)
	const labelled = result.messages.filter(message => message.mailbox === 'Clientcare')
	assert.deepEqual(
		inbox.map(message => message.messageId),
		['reply@northwind.cz', 'news@list.example'],
	)
	assert.equal(labelled.length, 3)
	assert.equal(result.truncated, true)
	assert.deepEqual((result as unknown as { cappedMailboxes: string[] }).cappedMailboxes, ['Clientcare'])
})

test('JXA: a mailbox list that fails makes unmatched entries unreadable (never missing) and is reported', () => {
	const accounts = gmailAccounts()
	accounts[0] = { ...accounts[0], listBroken: true }
	const { mail, read } = fakeMail(fakeMessages, { accounts })
	const result = runScript(mail, { ...scriptArgs, mailboxes: ['Clientcare', 'Archive'] }) as unknown as ScriptOutput & {
		missingMailboxes: string[]
		unreadableMailboxes: string[]
	}
	// The other account still lists and reads its Clientcare.
	assert.deepEqual(read, ['inbox', 'Clientcare'])
	assert.equal(result.truncated, true)
	assert.deepEqual(result.missingMailboxes, [])
	assert.deepEqual(result.unreadableMailboxes, ['iCloud mailbox list', 'Archive'])
	assert.ok(result.messages.some(message => message.mailbox === 'Clientcare'))

	// Every entry found elsewhere: the failed list is still reported, so the incomplete poll is never silent.
	const found = runScript(fakeMail(fakeMessages, { accounts }).mail, {
		...scriptArgs,
		mailboxes: ['Clientcare'],
	}) as unknown as {
		truncated: boolean
		unreadableMailboxes: string[]
	}
	assert.equal(found.truncated, true)
	assert.deepEqual(found.unreadableMailboxes, ['iCloud mailbox list'])
})

test('reader: capped and skipped mailboxes are reported; the gone reason names the mailboxes', async () => {
	const answer = { ...mailboxOutput, truncated: true, cappedMailboxes: ['All Mail'], skippedMailboxes: ['Archive'] }
	const { run } = fakeRunner(async () => ({ stdout: JSON.stringify(answer), stderr: '' }))
	const one = await createMailSignalReader(configWith({ mailboxes: 'All Mail' }), { run, now: () => NOW }).read(
		new AbortController().signal,
	)
	assert.equal(one.result?.complete, false)
	assert.deepEqual(one.health, {
		status: 'error',
		detail: 'more mail than one poll reads in "All Mail"; only 12 matching mailboxes are read',
	})
	assert.equal(one.result?.goneReason, 'no longer unread in the inbox or All Mail')

	const plain = fakeRunner(async () => ({ stdout: JSON.stringify(mailboxOutput), stderr: '' }))
	const two = await createMailSignalReader(configWith({ mailboxes: 'Clientcare\nArchive' }), {
		run: plain.run,
		now: () => NOW,
	}).read(new AbortController().signal)
	assert.equal(two.result?.goneReason, 'no longer unread in the inbox or the listed mailboxes')
	assert.equal(mailGoneReason([]), 'no longer unread in the inbox')
})
