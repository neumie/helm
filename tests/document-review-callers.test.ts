import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { callReview, loadReviewConnection } from '../src/document-review/client.js'
import { ReviewControlServer } from '../src/document-review/control-server.js'
import { LiveReviewCaller } from '../src/document-review/live-caller.js'
import {
	discoverySchema,
	feedbackSchema,
	openedSchema,
	receiptSchema,
	sessionSchema,
} from '../src/document-review/protocol.js'
import type { ReviewFeedback } from '../src/document-review/types.js'
import { callerFixture } from './helpers/document-review-caller'
const run = promisify(execFile)
async function discoverReview(root: string) {
	return discoverySchema.parse(JSON.parse(await readFile(join(root, 'discovery.json'), 'utf8')))
}

async function until(condition: () => boolean) {
	const end = Date.now() + 3000
	while (!condition()) {
		if (Date.now() > end) throw new Error('Expected caller transition timed out')
		await new Promise(resolve => setTimeout(resolve, 5))
	}
}

test('real private wire: only the exact listening caller receives feedback and reports replies', async () => {
	const f = await callerFixture()
	try {
		const a = await f.connect('claude')
		const b = await f.connect('codex')
		assert.throws(() => f.sessions.reserve(a.id, a.owner, f.workspace), /not listening/)
		const opened = await callReview(a.authority, { action: 'open', file: f.file }, openedSchema)
		assert.equal(opened.relativePath, 'spec.md')
		const wait = callReview(a.authority, { action: 'next', timeoutMs: 2000 }, feedbackSchema.nullable())
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		assert.equal(f.sessions.list(f.workspace)[1]?.listening, false)
		const { feedback, receipt } = await f.send(a)
		assert.equal(receipt.outcome, 'pending')
		assert.deepEqual(await wait, feedback)
		assert.throws(() => f.sessions.reserve(a.id, a.owner, f.workspace), /settle/)
		await assert.rejects(
			callReview(b.authority, { action: 'ack', requestId: feedback.request.id }, z.literal(true)),
			/unavailable/,
		)
		assert.equal(
			await callReview(b.authority, { action: 'receipt', requestId: feedback.request.id }, receiptSchema.nullable()),
			null,
		)
		await callReview(a.authority, { action: 'ack', requestId: feedback.request.id }, z.literal(true))
		assert.equal(
			(await callReview(a.authority, { action: 'receipt', requestId: feedback.request.id }, receiptSchema.nullable()))
				?.outcome,
			'dispatched',
		)
		const report = {
			action: 'reply' as const,
			requestId: feedback.request.id,
			sequence: 0,
			state: 'complete' as const,
			text: 'Reply from the original caller.',
		}
		await callReview(a.authority, report, z.literal(true))
		await callReview(a.authority, report, z.literal(true)) // ambiguous transport retry is exact/idempotent, never a provider effect
		await assert.rejects(callReview(a.authority, { ...report, text: 'Altered retry' }, z.literal(true)), /unavailable/)
		const status = await callReview(a.authority, { action: 'status' }, sessionSchema)
		assert.equal(status.busy, false)
		assert.equal(status.messages.at(-1)?.text, report.text)
		assert.equal('start' in f.sessions, false)
		assert.equal(await readFile(f.file, 'utf8'), '# Review\n\nKeep this original document.\n')
		await callReview(a.authority, { action: 'disconnect' }, z.literal(true))
		await assert.rejects(loadReviewConnection(a.connection), /ENOENT/)
	} finally {
		await f.close()
	}
})

test('wait cancellation, timeout, uncertainty, retirement, and epoch replacement never replay', async () => {
	const f = await callerFixture(25)
	try {
		const a = await f.connect()
		const cancelled = new AbortController()
		const wait = callReview(
			a.authority,
			{ action: 'next', timeoutMs: 2000 },
			feedbackSchema.nullable(),
			cancelled.signal,
		)
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		cancelled.abort()
		await assert.rejects(wait, /uncertain|cancel|unavailable/i)
		await until(() => !f.sessions.list(f.workspace)[0]?.listening)
		assert.equal(await callReview(a.authority, { action: 'next', timeoutMs: 10 }, feedbackSchema.nullable()), null)
		const next = callReview(a.authority, { action: 'next', timeoutMs: 2000 }, feedbackSchema.nullable())
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		const sent = await f.send(a)
		await next
		await until(() => f.sessions.list(f.workspace)[0]?.needsAcknowledgement === true)
		assert.equal(f.sessions.receipt(sent.feedback.request.id)?.outcome, 'unknown')
		await assert.rejects(
			callReview(a.authority, { action: 'next', timeoutMs: 10 }, feedbackSchema.nullable()),
			/unavailable/,
		)
		f.sessions.acknowledge(a.id, a.owner)
		assert.throws(() => f.sessions.reserve(a.id, a.owner, f.workspace), /not listening/)
		f.sessions.disconnect(a.id, a.owner)
		assert.throws(() => f.sessions.reserve(a.id, a.owner, f.workspace), /unavailable/)
		const b = await f.connect()
		assert.notEqual(b.id, a.id)
		assert.equal(f.sessions.list(f.workspace).find(value => value.id === b.id)?.listening, false)
		assert.equal(
			await callReview(
				b.authority,
				{ action: 'receipt', requestId: sent.feedback.request.id },
				receiptSchema.nullable(),
			),
			null,
		)
		f.fence()
		await assert.rejects(callReview(b.authority, { action: 'status' }, sessionSchema), /unavailable/)
	} finally {
		await f.close()
	}
})

test('native caller preserves context, coalesces replies, re-listens, and permanently fences disposal', async () => {
	const f = await callerFixture()
	let live: LiveReviewCaller | null = null
	try {
		let current = true
		const originalContext = { marker: randomUUID() }
		const deliveries: ReviewFeedback[] = []
		let unavailable = 0
		live = await LiveReviewCaller.connect(
			f.workspace,
			f.file,
			{
				current: () => current,
				dispatch: value => {
					assert.ok(originalContext.marker)
					deliveries.push(value)
					live?.publish('working', 'Observed original reply')
					live?.publish('complete', originalContext.marker)
					live?.publish('working', 'Never overwrite a terminal report')
				},
				unavailable: () => {
					unavailable++
				},
			},
			f.root,
		)
		const authority = await loadReviewConnection(live.connectionFile)
		live.start()
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		await f.send(authority)
		await until(
			() =>
				f.sessions.list(f.workspace)[0]?.messages.at(-1)?.text === originalContext.marker &&
				f.sessions.list(f.workspace)[0]?.listening === true,
		)
		assert.equal(deliveries.length, 1)
		assert.equal(unavailable, 0)
		current = false
		await live.dispose()
		live.start()
		assert.equal(f.sessions.list(f.workspace)[0]?.listening, false)
		assert.throws(() => f.sessions.reserve(authority.id, authority.owner, f.workspace), /unavailable/)
		assert.equal(deliveries.length, 1)
	} finally {
		await live?.dispose()
		await f.close()
	}
})

test('private discovery rejects links, insecure state, foreign authority, singleton races, and substituted cleanup', async () => {
	const f = await callerFixture()
	try {
		const discovery = await discoverReview(f.root)
		assert.equal((await lstat(discovery.socket)).mode & 0o777, 0o600)
		await assert.rejects(new ReviewControlServer(f.root, f.backend).start(), /owns|EEXIST/)
		await assert.rejects(
			callReview({ ...discovery, token: '0'.repeat(64) }, { action: 'status' }, z.unknown()),
			/unavailable/,
		)
		await assert.rejects(
			callReview({ ...discovery, epoch: randomUUID() }, { action: 'status' }, z.unknown()),
			/unavailable/,
		)
		const a = await f.connect()
		await chmod(a.connection, 0o644)
		await assert.rejects(loadReviewConnection(a.connection), /private|unsafe|unavailable/i)
		await chmod(a.connection, 0o600)
		const old = join(f.root, 'old-discovery.json')
		await rename(join(f.root, 'discovery.json'), old)
		await writeFile(join(f.root, 'discovery.json'), 'do not delete the replacement', { mode: 0o600 })
		await f.host.stop()
		assert.equal(await readFile(join(f.root, 'discovery.json'), 'utf8'), 'do not delete the replacement')
	} finally {
		await f.close()
	}
})

test('actual helm review CLI opens, blocks in the original tool call, reports, inspects, and disconnects', async () => {
	const f = await callerFixture()
	const cli = resolve('src/cli/helm.ts')
	const tsx = import.meta.resolve('tsx')
	const command = (...args: string[]) =>
		run(process.execPath, ['--import', tsx, cli, 'review', ...args, '--json'], {
			cwd: f.workspace,
			env: { ...process.env, HOME: f.workspace },
			timeout: 15000,
			maxBuffer: 1000000,
		})
	try {
		const opening = command('open', f.file, '--agent', 'codex', '--wait', '--timeout', '5')
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		const owner = f.sessions.list(f.workspace)[0]
		assert.ok(owner)
		const sent = await f.send(owner, 'Return this selection to my existing Codex tool.')
		const result = JSON.parse((await opening).stdout)
		assert.equal(result.feedback.request.id, sent.feedback.request.id)
		assert.equal(result.feedback.request.owner, owner.owner)
		assert.equal(result.feedback.request.instruction, 'Return this selection to my existing Codex tool.')
		assert.ok(!('token' in result))
		const connection = result.connection as string
		assert.equal(JSON.parse((await command('status', '--connection', connection)).stdout).state, 'waiting')
		await command('reply', sent.feedback.request.id, '--connection', connection, '--text', 'Same-context reply')
		assert.equal(
			JSON.parse((await command('receipt', sent.feedback.request.id, '--connection', connection)).stdout).outcome,
			'dispatched',
		)
		assert.equal(JSON.parse((await command('list', '--connection', connection)).stdout).length, 1)
		const empty = JSON.parse((await command('wait', '--connection', connection, '--timeout', '1')).stdout)
		assert.equal(empty.feedback, null)
		await command('disconnect', '--connection', connection)
		assert.equal(f.opens(), 1)
		assert.equal(f.sessions.list(f.workspace)[0]?.state, 'disconnected')
		const help = await run(process.execPath, ['--import', tsx, cli, 'review', '--help'])
		assert.match(help.stdout, /never starts|never launches|No agent/i)
	} finally {
		await f.close()
	}
})

test(
	'actual Pi loader registers an inert native tool and fences before-navigation until genuine settlement',
	{ skip: !process.env.HELM_DOCUMENT_REVIEW_PI },
	async () => {
		const cli = process.env.HELM_DOCUMENT_REVIEW_PI as string
		let piRoot = dirname(cli)
		while (!(await lstat(join(piRoot, 'package.json')).catch(() => null))) piRoot = dirname(piRoot)
		const { loadExtensions, createExtensionRuntime } = await import(
			pathToFileURL(join(piRoot, 'dist/core/extensions/loader.js')).href
		)
		const f = await callerFixture()
		const oldHome = process.env.HOME
		const deliveries: { prompt: string; options: unknown }[] = []
		const runtime = createExtensionRuntime()
		runtime.sendUserMessage = (prompt: string, options: unknown) => {
			deliveries.push({ prompt, options })
		}
		const loaded = await loadExtensions(
			[resolve('packages/helm-document-review/index.ts')],
			f.workspace,
			undefined,
			runtime,
		)
		try {
			assert.deepEqual(loaded.errors, [])
			const extension = loaded.extensions[0]
			const tool = extension.tools.get('helm_review').definition
			assert.equal(f.opens(), 0)
			assert.deepEqual(f.sessions.list(f.workspace), [])
			process.env.HOME = f.workspace
			const ctx = {
				mode: 'tui',
				cwd: f.workspace,
				sessionManager: { getSessionId: () => 'original-pi-context' },
				ui: { notify: () => {} },
			}
			const event = async (name: string, value: unknown = {}) => {
				for (const handler of extension.handlers.get(name) ?? []) await handler(value, ctx)
			}
			await event('session_start')
			await tool.execute('open', { action: 'open', file: f.file }, undefined, undefined, ctx)
			await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
			const owner = f.sessions.list(f.workspace)[0]
			assert.ok(owner)
			const sent = await f.send(owner)
			await until(() => deliveries.length === 1)
			assert.equal(deliveries[0]?.prompt, sent.feedback.prompt)
			assert.deepEqual(deliveries[0]?.options, { deliverAs: 'followUp', expandPromptTemplates: false })
			await event('message_end', {
				message: { role: 'assistant', content: [{ type: 'text', text: 'Unrelated turn must not leak' }] },
			})
			await event('agent_settled')
			assert.equal(f.sessions.list(f.workspace)[0]?.messages.length, 1)
			await event('before_agent_start', { prompt: sent.feedback.prompt })
			await event('message_end', {
				message: {
					role: 'assistant',
					content: [
						{ type: 'text', text: 'Original session reply' },
						{ type: 'toolCall', arguments: { secret: 'never project' } },
					],
				},
			})
			await event('agent_settled')
			await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
			assert.equal(f.sessions.list(f.workspace)[0]?.messages.at(-1)?.text, 'Original session reply')
			const second = await f.send(owner)
			await until(() => deliveries.length === 2)
			await event('before_agent_start', { prompt: second.feedback.prompt })
			await event('message_end', {
				message: {
					role: 'assistant',
					stopReason: 'error',
					content: [{ type: 'text', text: `${'X'.repeat(63899)}🐝${'Y'.repeat(2000)}` }],
				},
			})
			await event('agent_settled')
			await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
			const failed = f.sessions.list(f.workspace)[0]
			const reply = failed?.messages.find(value => value.id === `${second.feedback.request.id}:assistant`)
			assert.match(reply?.text ?? '', /Reply shortened in Helm/)
			assert.ok(!reply?.text.includes('�'))
			assert.match(failed?.messages.at(-1)?.text ?? '', /caller reported a failure/)
			assert.equal(failed?.error, null) // a genuine next listener may continue; the error record stays visible
			await event('session_before_tree')
			await assert.rejects(tool.execute('again', { action: 'open', file: f.file }, undefined, undefined, ctx), /fenced/)
			await tool.execute('disconnect', { action: 'disconnect' }, undefined, undefined, ctx)
			await assert.rejects(
				tool.execute('still-fenced', { action: 'open', file: f.file }, undefined, undefined, ctx),
				/fenced/,
			)
			assert.equal(deliveries.length, 2)
			await event('session_tree')
			await tool.execute('settled', { action: 'open', file: f.file }, undefined, undefined, ctx)
			await until(() => f.sessions.list(f.workspace).some(value => value.id !== owner.id && value.listening))
			await event('session_shutdown')
		} finally {
			if (oldHome === undefined) Reflect.deleteProperty(process.env, 'HOME')
			else process.env.HOME = oldHome
			await f.close()
		}
	},
)

test('native opening admission serializes CLI opens and fences lifecycle without launching Electron', async () => {
	// Isolated child: mock only Electron import, execute the actual window manager's
	// admission method, and replace file/window creation with a held fixture effect.
	const module = resolve('app/src/document-review/window.ts')
	const script = `
		const assert = require('node:assert/strict');
		const { createRequire } = require('node:module');
		const local = createRequire(${JSON.stringify(module)});
		const electron = local.resolve('electron');
		require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {} };
		const { DocumentReviewWindows } = local(${JSON.stringify(module)});
		(async () => {
			const windows = new DocumentReviewWindows({
				profileId: () => 'profile', allowsToken: token => token === 'current',
			});
			const owner = windows.connectCaller('pi', '/workspace', 'Pi', 'in-process');
			let finish;
			let starts = 0;
			let guarded;
			windows.openFile = async (_file, _token, current) => {
				starts++;
				guarded = current;
				await new Promise(resolve => { finish = resolve; });
			};
			const first = windows.openForCaller('/workspace/spec.md', 'current', 'profile', owner.id, owner.owner);
			await assert.rejects(windows.openForCaller('/workspace/spec.md', 'current', 'profile', owner.id, owner.owner), /Another document/);
			assert.equal(starts, 1);
			assert.equal(windows.opening, true);
			assert.equal(guarded(), true);
			windows.admissionEpoch++;
			assert.equal(guarded(), false);
			finish();
			await assert.rejects(first, /connection changed/);
			assert.equal(windows.opening, false);
			windows.openFile = async () => { throw new Error('Fixture file rejected'); };
			await assert.rejects(windows.openForCaller('/workspace/spec.md', 'current', 'profile', owner.id, owner.owner), /Fixture file rejected/);
			assert.equal(windows.opening, false);
		})().catch(error => { console.error(error); process.exitCode = 1; });
	`
	await run(process.execPath, ['--import', import.meta.resolve('tsx'), '-e', script], { timeout: 15000 })
})

test('malformed, oversized, multi-frame and partial wire requests admit no caller', async () => {
	const f = await callerFixture()
	try {
		const discovery = await discoverReview(f.root)
		for (const value of ['not-json\n', '{}\n{}\n', `${'x'.repeat(600000)}\n`, '{']) {
			await new Promise<void>((resolve, reject) => {
				const socket = createConnection(discovery.socket)
				socket.on('error', error => {
					if (['EPIPE', 'ECONNRESET'].includes((error as NodeJS.ErrnoException).code ?? '')) resolve()
					else reject(error)
				})
				socket.on('data', () => {})
				socket.on('connect', () => socket.write(value))
				socket.on('close', () => resolve())
			})
		}
		assert.deepEqual(f.sessions.list(f.workspace), [])
	} finally {
		await f.close()
	}
})
