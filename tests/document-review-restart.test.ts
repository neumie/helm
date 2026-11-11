import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { z } from 'zod'
import documentModule from '../app/src/document-review/document'
import ownerStoreModule from '../app/src/document-review/owner-store'
import requestModule from '../app/src/document-review/request'
import sessionsModule from '../app/src/document-review/sessions'
import {
	ReviewReconnectTimeout,
	callReview,
	callReviewThroughRestart,
	connectReview,
	loadReviewConnection,
	reviewCallFailure,
} from '../src/document-review/client.js'
import { ReviewControlServer } from '../src/document-review/control-server.js'
import type { ReviewControlBackend } from '../src/document-review/control-server.js'
import type { ReviewConnection } from '../src/document-review/protocol.js'
import { feedbackSchema } from '../src/document-review/protocol.js'
import { REVIEW_HOST_RESTARTING, restartingRefusal } from '../src/document-review/refusal.js'
import type { ReviewFeedback } from '../src/document-review/types.js'

const { ReviewSessions, wireReceipt } = sessionsModule
const { ReviewOwnerStore } = ownerStoreModule
const { readReviewFile, reviewRevision } = documentModule
const { reviewPrompt } = requestModule
const run = promisify(execFile)

/**
 * One Helm "process" over a shared private root (S13): the real control server, mailbox and owner store, composed
 * as main composes them. A restart is `quit()` (suspend, write callers down, stop the host) and a new generation.
 * Windows are a fixture: one document id that stays open across generations.
 */
async function generation(root: string, workspace: string, documentId: string) {
	const store = new ReviewOwnerStore(root)
	const sessions = new ReviewSessions(() => {}, 60000, 10000, undefined, {
		profileId: 'work',
		save: (id, record) => store.save(id, record),
	})
	const binding = { profileId: 'work', profileToken: 'work:1', workspace }
	const backend: ReviewControlBackend = {
		status: () => ({ available: true }),
		current: value => {
			try {
				sessions.get(value.id, value.owner)
				return true
			} catch {
				return false
			}
		},
		restore: async record => {
			const kept = await store.load(record.id)
			if (!kept || kept.snapshot.owner !== record.owner) return null
			sessions.restore(kept)
			return { id: record.id, owner: record.owner, ...binding }
		},
		connect: async command => {
			const session = sessions.connect(command.provider, workspace, command.label, command.transport)
			return { id: session.id, owner: session.owner, ...binding }
		},
		command: async (value, command, signal) => {
			if (sessions.isSuspended() && !['status', 'list', 'receipt'].includes(command.action)) throw restartingRefusal()
			switch (command.action) {
				case 'open': {
					const text = await readReviewFile(workspace, command.file)
					sessions.track(value.id, value.owner, documentId, workspace, command.file)
					return { documentId, revision: reviewRevision(text), relativePath: 'spec.md' }
				}
				case 'next':
					return command.documentId
						? sessions.next(value.id, value.owner, command.timeoutMs, signal, command.documentId, command.listener)
						: sessions.next(value.id, value.owner, command.timeoutMs, signal, undefined, command.listener)
				case 'ack':
					sessions.confirm(value.id, value.owner, command.requestId)
					await sessions.flush(value.id)
					return true
				case 'reply':
					sessions.report(value.id, value.owner, command.requestId, command.sequence, command.state, command.text)
					await sessions.flush(value.id)
					return true
				case 'receipt':
					return wireReceipt(sessions.receipt(command.requestId, value.id))
				case 'status':
					return sessions.list(workspace).find(session => session.id === value.id)
				case 'list':
					return sessions.list(workspace)
				case 'disconnect':
					sessions.disconnect(value.id, value.owner)
					return true
			}
		},
		disconnect: value => {
			try {
				sessions.disconnect(value.id, value.owner)
			} catch {
				/* retired */
			}
		},
	}
	const host = new ReviewControlServer(root, backend)
	await host.start()
	return {
		sessions,
		host,
		/** Jakub presses Send in the open window: the listening caller gets this feedback. */
		async send(instruction: string) {
			const [session] = sessions.list(workspace)
			assert.ok(session)
			const text = await readReviewFile(workspace, join(workspace, 'spec.md'))
			const request = {
				id: randomUUID(),
				documentId,
				sessionId: session.id,
				owner: session.owner,
				revision: reviewRevision(text),
				intent: 'discuss' as const,
				instruction,
				passage: null,
			}
			const feedback: ReviewFeedback = {
				request,
				prompt: reviewPrompt(request, text, 'spec.md'),
				relativePath: 'spec.md',
			}
			const owner = sessions.reserve(session.id, session.owner, workspace, documentId)
			sessions.dispatch(owner, request.id, request.id, feedback)
			return feedback
		},
		/** A graceful quit as main runs it: callers kept on disk, then the host stops. */
		async quit() {
			await sessions.suspend()
			await store.drain()
			await host.stop()
		},
	}
}

async function workspaceFixture() {
	const workspace = await realpath(await mkdtemp('/tmp/hrr-'))
	await run('git', ['init', '-q', workspace])
	await writeFile(join(workspace, 'spec.md'), '# Spec\n\nKeep this.\n', { mode: 0o600 })
	const root = join(workspace, '.helm', 'document-review')
	await mkdir(root, { recursive: true, mode: 0o700 })
	return { workspace, root, documentId: randomUUID(), close: () => rm(workspace, { recursive: true, force: true }) }
}

const until = async (check: () => boolean | Promise<boolean>, ms = 20000) => {
	const end = Date.now() + ms
	while (!(await check())) {
		if (Date.now() > end) throw new Error('condition not reached')
		await new Promise(done => setTimeout(done, 20))
	}
}

const connect = async (root: string, workspace: string): Promise<ReviewConnection & { connection: string }> => {
	const connected = await connectReview(
		{ action: 'connect', provider: 'claude', workspace, label: 'Original conversation', transport: 'tool-return' },
		root,
	)
	return { ...(await loadReviewConnection(connected.connection)), connection: connected.connection }
}

test('a quitting host answers a waiting read with a kept-connection refusal, not a lost response', async () => {
	const f = await workspaceFixture()
	const first = await generation(f.root, f.workspace, f.documentId)
	try {
		const caller = await connect(f.root, f.workspace)
		const read = callReview(caller, { action: 'next', timeoutMs: 20000 }, feedbackSchema.nullable()).then(
			() => null,
			(value: unknown) => value,
		)
		await until(() => first.sessions.list(f.workspace)[0]?.listening === true)
		await first.quit()
		const error = await read
		assert.equal(reviewCallFailure(error), 'restarting')
		assert.match((error as Error).message, new RegExp(REVIEW_HOST_RESTARTING))
		// The connection file and its binding stay for the next Helm.
		const names = await readdir(f.root)
		assert.ok(names.some(name => name.startsWith('connection-')))
		assert.ok(names.some(name => name.startsWith('binding-')))
		assert.ok(names.some(name => name.startsWith('caller-')))
	} finally {
		await first.host.stop()
		await f.close()
	}
})

test('feedback handed out but not confirmed before a restart goes again only to the same listener', async () => {
	const f = await workspaceFixture()
	let current = await generation(f.root, f.workspace, f.documentId)
	try {
		const caller = await connect(f.root, f.workspace)
		const listener = randomUUID()
		const read = callReview(caller, { action: 'next', timeoutMs: 20000, listener }, feedbackSchema.nullable())
		await until(() => current.sessions.list(f.workspace)[0]?.listening === true)
		const sent = await current.send('Explain the heading.')
		assert.equal((await read)?.request.id, sent.request.id)
		// Helm quits before the agent's CLI confirmed the pickup.
		await current.quit()
		current = await generation(f.root, f.workspace, f.documentId)
		// The same listening process gets exactly the same feedback again, from the restarted Helm, same connection.
		const again = await callReview(caller, { action: 'next', timeoutMs: 5000, listener }, feedbackSchema.nullable())
		assert.equal(again?.request.id, sent.request.id)
		await callReview(caller, { action: 'ack', requestId: sent.request.id }, z.literal(true))
		await callReview(
			caller,
			{ action: 'reply', requestId: sent.request.id, sequence: 0, state: 'complete', text: 'Answered after restart.' },
			z.literal(true),
		)
		assert.equal(current.sessions.list(f.workspace)[0]?.busy, false)
		const messages = current.sessions.list(f.workspace)[0]?.messages ?? []
		assert.ok(messages.some(message => message.text === 'Answered after restart.'))
	} finally {
		await current.host.stop()
		await f.close()
	}
})

test('another listening process never receives feedback an earlier one may hold: it is marked unknown', async () => {
	const f = await workspaceFixture()
	let current = await generation(f.root, f.workspace, f.documentId)
	try {
		const caller = await connect(f.root, f.workspace)
		const read = callReview(
			caller,
			{ action: 'next', timeoutMs: 20000, listener: randomUUID() },
			feedbackSchema.nullable(),
		)
		await until(() => current.sessions.list(f.workspace)[0]?.listening === true)
		const sent = await current.send('Do not duplicate me.')
		assert.equal((await read)?.request.id, sent.request.id)
		await current.quit()
		current = await generation(f.root, f.workspace, f.documentId)
		await assert.rejects(
			callReview(caller, { action: 'next', timeoutMs: 2000, listener: randomUUID() }, feedbackSchema.nullable()),
			/never confirmed/,
		)
		assert.equal(current.sessions.receipt(sent.request.id)?.outcome, 'unknown')
	} finally {
		await current.host.stop()
		await f.close()
	}
})

test('a confirmed feedback survives a restart: the reply sent to the restarted Helm settles it once', async () => {
	const f = await workspaceFixture()
	let current = await generation(f.root, f.workspace, f.documentId)
	try {
		const caller = await connect(f.root, f.workspace)
		const read = callReview(caller, { action: 'next', timeoutMs: 20000 }, feedbackSchema.nullable())
		await until(() => current.sessions.list(f.workspace)[0]?.listening === true)
		const sent = await current.send('Rewrite the intro.')
		assert.equal((await read)?.request.id, sent.request.id)
		await callReview(caller, { action: 'ack', requestId: sent.request.id }, z.literal(true))
		// Restart while the agent works on it.
		await current.quit()
		current = await generation(f.root, f.workspace, f.documentId)
		const reply = {
			action: 'reply' as const,
			requestId: sent.request.id,
			sequence: 0,
			state: 'complete' as const,
			text: 'Rewrote it.',
		}
		await callReview(caller, reply, z.literal(true))
		// A reply whose answer was lost is sent again: Helm keeps one message, not two.
		await callReview(caller, reply, z.literal(true))
		const messages = (current.sessions.list(f.workspace)[0]?.messages ?? []).filter(
			message => message.text === 'Rewrote it.',
		)
		assert.equal(messages.length, 1)
		assert.equal(current.sessions.list(f.workspace)[0]?.busy, false)
	} finally {
		await current.host.stop()
		await f.close()
	}
})

test('callReviewThroughRestart waits for the next Helm, and gives up with a timeout error when none comes', async () => {
	const f = await workspaceFixture()
	let current = await generation(f.root, f.workspace, f.documentId)
	try {
		const caller = await connect(f.root, f.workspace)
		await current.quit()
		let noted = 0
		const waiting = callReviewThroughRestart(caller, { action: 'next', timeoutMs: 3000 }, feedbackSchema.nullable(), {
			until: Date.now() + 15000,
			pauseMs: 50,
			onWait: () => noted++,
		})
		await new Promise(done => setTimeout(done, 300))
		current = await generation(f.root, f.workspace, f.documentId)
		assert.equal(await waiting, null)
		assert.equal(noted, 1)
		await current.quit()
		await assert.rejects(
			callReviewThroughRestart(caller, { action: 'next', timeoutMs: 1000 }, feedbackSchema.nullable(), {
				until: Date.now() + 400,
				pauseMs: 50,
			}),
			(error: unknown) => error instanceof ReviewReconnectTimeout,
		)
	} finally {
		await current.host.stop()
		await f.close()
	}
})

test('helm edit keeps listening through a Helm restart and its reply reaches the restarted Helm', async () => {
	const f = await workspaceFixture()
	const root = join(f.workspace, '.helm', 'document-review')
	let current = await generation(root, f.workspace, f.documentId)
	const cli = resolve('src/cli/helm.ts')
	const tsx = import.meta.resolve('tsx')
	const env = { ...process.env, HOME: f.workspace }
	Reflect.deleteProperty(env, 'CLAUDECODE')
	Reflect.deleteProperty(env, 'CODEX_THREAD_ID')
	const helm = (...args: string[]) => {
		const child = spawn(process.execPath, ['--import', tsx, cli, ...args], { cwd: f.workspace, env })
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', chunk => {
			stdout += chunk
		})
		child.stderr.on('data', chunk => {
			stderr += chunk
		})
		const done = new Promise<number | null>(resolveExit => child.once('exit', resolveExit))
		return { child, done, stdout: () => stdout, stderr: () => stderr }
	}
	try {
		// The agent's foreground tool: helm edit FILE, listening.
		const editing = helm('edit', join(f.workspace, 'spec.md'), '--timeout', '120')
		await until(() => current.sessions.list(f.workspace)[0]?.listening === true, 60000)
		// Jakub restarts Helm while the agent waits. Before S13 the CLI printed "Review response was lost".
		await current.quit()
		await until(() => editing.stderr().includes('waiting for it to come back'), 20000)
		current = await generation(root, f.workspace, f.documentId)
		await until(() => current.sessions.list(f.workspace)[0]?.listening === true, 30000)
		const sent = await current.send('Comments written after the restart.')
		assert.equal(await editing.done, 0, editing.stderr())
		const result = JSON.parse(editing.stdout())
		assert.equal(result.feedback.request.id, sent.request.id)
		assert.doesNotMatch(editing.stderr(), /Review response was lost/)
		// The CLI confirmed the pickup.
		await until(() => current.sessions.receipt(sent.request.id)?.outcome === 'dispatched')
		// Another restart while the agent works; its reply goes to the next Helm with the same handle.
		await current.quit()
		const replying = helm('edit', 'reply', result.commands.reply[3], 'Done after two restarts.', '--timeout', '1')
		await new Promise(done => setTimeout(done, 500))
		current = await generation(root, f.workspace, f.documentId)
		assert.equal(await replying.done, 0, replying.stderr())
		assert.equal(current.sessions.list(f.workspace)[0]?.busy, false)
		const messages = current.sessions.list(f.workspace)[0]?.messages ?? []
		assert.ok(messages.some(message => message.text === 'Done after two restarts.'))
	} finally {
		await current.host.stop()
		await f.close()
	}
})
