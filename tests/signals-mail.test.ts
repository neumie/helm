import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { HelmConfig } from '../src/config.js'
import type { SignalObservation } from '../src/signals/contract.js'
import type { SignalCommandRunner } from '../src/signals/github-source.js'
import {
	type MailFilterOptions,
	type MailMessageHead,
	filterMail,
	globToRegExpSource,
	mailRef,
	mapMailThreads,
	matchesGlob,
	messageUrl,
	parseGlobList,
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

/** A read-only fake of the JXA Mail object model: any property write throws. */
function fakeMail(messages: FakeMessage[], { running = true } = {}) {
	const touched: string[] = []
	const readOnly = <T extends object>(target: T): T =>
		new Proxy(target, {
			set(_t, property) {
				throw new Error(`write to ${String(property)}`)
			},
			defineProperty(_t, property) {
				throw new Error(`define ${String(property)}`)
			},
		})
	const batch =
		<K extends keyof FakeMessage>(key: K) =>
		() => {
			touched.push(key)
			return messages.map(message => message[key])
		}
	const collection = readOnly(
		new Proxy(
			{
				id: batch('id'),
				messageId: batch('messageId'),
				subject: batch('subject'),
				sender: batch('sender'),
				dateReceived: batch('date'),
				readStatus: batch('read'),
				flaggedStatus: batch('flagged'),
			} as Record<string, unknown>,
			{
				get(target, property) {
					if (typeof property === 'string' && /^\d+$/.test(property)) {
						const message = messages[Number(property)]
						return readOnly({
							id: () => message.id,
							allHeaders: () => {
								touched.push(`allHeaders:${message.id}`)
								return message.headers
							},
						})
					}
					return target[property as string]
				},
			},
		),
	)
	const queries: unknown[] = []
	const mail = readOnly({
		running: () => running,
		inbox: readOnly({
			messages: readOnly({
				whose: (query: unknown) => {
					queries.push(query)
					return collection
				},
			}),
		}),
		accounts: readOnly({ emailAddresses: () => [['me@example.com'], ['me@work.example', 'alias@example.com']] }),
	})
	return { mail, touched, queries }
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
	include: parseGlobList(mailSettings.includeSenders).map(globToRegExpSource),
	unreadOnly: true,
	maxMessages: 300,
	maxCandidates: 60,
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
