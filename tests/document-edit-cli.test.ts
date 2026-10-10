import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import type { ReviewSessions } from '../app/src/document-review/sessions'
import { callerFixture } from './helpers/document-review-caller'

const run = promisify(execFile)
const cli = resolve('src/cli/helm.ts')
const tsx = import.meta.resolve('tsx')
async function until(condition: () => boolean) {
	const deadline = Date.now() + 15000
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('Expected CLI mailbox transition timed out')
		await new Promise(resolve => setTimeout(resolve, 10))
	}
}
async function fixture() {
	const f = await callerFixture(30000)
	const children: ReturnType<typeof run>[] = []
	const command = (...args: string[]) => {
		const child = run(process.execPath, ['--import', tsx, cli, 'edit', ...args], {
			cwd: f.workspace,
			env: { ...process.env, HOME: f.workspace },
			timeout: 30000,
			maxBuffer: 1000000,
		})
		// Observe rejection immediately, including if an assertion fails while a child is waiting.
		void child.catch(() => {})
		children.push(child)
		return child
	}
	return {
		...f,
		sessions: f.sessions as ReviewSessions,
		command,
		close: async () => {
			for (const child of children) child.child.kill('SIGTERM')
			await Promise.allSettled(children)
			await f.close()
		},
	}
}

test('helm edit FILE needs no flags, returns complete exact feedback, and reply automatically re-listens', async () => {
	const f = await fixture()
	try {
		const originalBytes = await readFile(f.file)
		const opening = f.command('spec.md')
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		const owner = f.sessions.list(f.workspace)[0]
		assert.ok(owner)
		assert.equal(owner.provider, 'cli')
		assert.equal(owner.name, 'Document conversation')
		assert.equal(owner.capabilities.transport, 'tool-return')
		const sent = await f.send(owner, 'Explain this spec without changing it. 🐝')
		const first = JSON.parse((await opening).stdout)
		assert.deepEqual(first.feedback, sent.feedback)
		assert.equal(first.relativePath, 'spec.md')
		assert.equal(first.timedOut, false)
		assert.equal(first.documentId, sent.feedback.request.documentId)
		assert.equal(first.closed, false)
		assert.deepEqual(first.commands.reply, [
			'helm',
			'edit',
			'reply',
			`${first.connection}#${sent.feedback.request.id}#${first.documentId}`,
		])
		assert.deepEqual(first.commands.wait, ['helm', 'edit', 'wait', `${first.connection}#${first.documentId}`])
		assert.match(first.instructions, /original conversation/)
		assert.equal(f.sessions.receipt(sent.feedback.request.id)?.outcome, 'dispatched')
		assert.equal('token' in first, false)
		const reply = f.command(...first.commands.reply.slice(2), '--help')
		await until(() => {
			const session = f.sessions.list(f.workspace)[0]
			return session?.listening === true && session.messages.at(-1)?.text === '--help'
		})
		assert.equal(f.opens(), 1)
		assert.equal(f.sessions.list(f.workspace).length, 1)
		const secondSent = await f.send(owner, 'Now refine the spec.', undefined, 'change')
		const second = JSON.parse((await reply).stdout)
		assert.deepEqual(second.feedback, secondSent.feedback)
		assert.equal(second.connection, first.connection)
		assert.notEqual(second.commands.reply[3], first.commands.reply[3])
		assert.deepEqual(await readFile(f.file), originalBytes)
		await f.command(...second.commands.disconnect.slice(2))
		assert.equal(f.sessions.list(f.workspace)[0]?.state, 'disconnected')
	} finally {
		await f.close()
	}
})

test('edit continuations refuse foreign callers and validate all options before reporting', async () => {
	const f = await fixture()
	try {
		const opening = f.command('spec.md')
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		const owner = f.sessions.list(f.workspace)[0]
		assert.ok(owner)
		const sent = await f.send(owner)
		const first = JSON.parse((await opening).stdout)
		const foreign = await f.connect('pi')
		await assert.rejects(f.command('reply', `${foreign.connection}#${sent.feedback.request.id}`, 'Wrong caller'))
		for (const options of [
			['--timeout', '0'],
			['--timeout', 'not-a-number'],
			['--timeout', '1', '--timeout', '1'],
			['extra'],
		])
			await assert.rejects(f.command('reply', first.commands.reply[3], 'Not admitted', ...options))
		await assert.rejects(f.command('reply', first.commands.reply[3], 'x'.repeat(64001)))
		assert.equal(f.sessions.list(f.workspace)[0]?.busy, true)
		assert.equal(f.sessions.list(f.workspace)[0]?.messages.length, 1)
		assert.equal(f.sessions.list(f.workspace)[1]?.messages.length, 0)
		assert.equal(
			f.sessions.list(f.workspace).some(session => session.listening),
			false,
		)
		assert.equal(f.opens(), 1)
	} finally {
		await f.close()
	}
})

test('edit timeout/resume uses only its returned owner, never the newest connection or a replacement', async () => {
	const f = await fixture()
	try {
		const opening = f.command('spec.md', '--timeout', '1')
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		const firstOwner = f.sessions.list(f.workspace)[0]
		assert.ok(firstOwner)
		const foreign = await f.connect('codex')
		const timedOut = JSON.parse((await opening).stdout)
		assert.equal(timedOut.feedback, null)
		assert.equal(timedOut.timedOut, true)
		assert.equal('reply' in timedOut.commands, false)
		const waiting = f.command(...timedOut.commands.wait.slice(2))
		await until(() => f.sessions.list(f.workspace).find(session => session.id === firstOwner.id)?.listening === true)
		assert.equal(f.sessions.list(f.workspace).find(session => session.id === foreign.id)?.listening, false)
		const sent = await f.send(firstOwner)
		const received = JSON.parse((await waiting).stdout)
		assert.deepEqual(received.feedback, sent.feedback)
		assert.equal(received.connection, timedOut.connection)
		assert.equal(f.sessions.list(f.workspace).length, 2)
		assert.equal(f.opens(), 1)
		f.fence()
		await assert.rejects(f.command(...received.commands.wait.slice(2)))
		assert.equal(f.sessions.list(f.workspace).length, 2)
		assert.equal(f.opens(), 1)
	} finally {
		await f.close()
	}
})

test('reply and next read retain the captured owner when the private connection file is replaced', async () => {
	const f = await fixture()
	try {
		const opening = f.command('spec.md')
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		const owner = f.sessions.list(f.workspace)[0]
		assert.ok(owner)
		await f.send(owner)
		const first = JSON.parse((await opening).stdout)
		const foreign = await f.connect('codex')
		const original = f.backend.command
		f.backend.command = async (binding, command, signal) => {
			const result = await original(binding, command, signal)
			if (command.action === 'reply')
				await writeFile(first.connection, await readFile(foreign.connection), { mode: 0o600 })
			return result
		}
		const continuing = f.command(...first.commands.reply.slice(2), 'Same captured owner')
		await until(() => f.sessions.list(f.workspace).some(session => session.listening))
		assert.equal(f.sessions.list(f.workspace).find(session => session.id === owner.id)?.listening, true)
		assert.equal(f.sessions.list(f.workspace).find(session => session.id === foreign.id)?.listening, false)
		const sent = await f.send(owner)
		const result = JSON.parse((await continuing).stdout)
		assert.deepEqual(result.feedback, sent.feedback)
		assert.equal(result.feedback.request.owner, owner.owner)
		assert.deepEqual(f.sessions.list(f.workspace).find(session => session.id === foreign.id)?.messages, [])
	} finally {
		await f.close()
	}
})

test('edit never replays a report or starts another wait after a failed reply response', async () => {
	const f = await fixture()
	try {
		const opening = f.command('spec.md')
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		const owner = f.sessions.list(f.workspace)[0]
		assert.ok(owner)
		await f.send(owner)
		const first = JSON.parse((await opening).stdout)
		const original = f.backend.command
		let reports = 0
		let waits = 0
		f.backend.command = async (binding, command, signal) => {
			if (command.action === 'next') waits++
			const result = await original(binding, command, signal)
			if (command.action === 'reply') {
				reports++
				// The report took effect, but its caller cannot know that from this handled error response.
				throw new Error('Simulated post-report response failure')
			}
			return result
		}
		await assert.rejects(f.command(...first.commands.reply.slice(2), 'Reported once'))
		assert.equal(reports, 1)
		assert.equal(waits, 0)
		assert.equal(f.sessions.list(f.workspace)[0]?.messages.at(-1)?.text, 'Reported once')
		assert.equal(f.sessions.list(f.workspace)[0]?.listening, false)
		assert.equal(f.sessions.list(f.workspace).length, 1)
		assert.equal(f.opens(), 1)
	} finally {
		await f.close()
	}
})

test('edit cancellation releases its foreground listener without retiring or sending', async () => {
	const f = await fixture()
	try {
		const waiting = f.command('spec.md')
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		waiting.child.kill('SIGTERM')
		await assert.rejects(waiting, /cancelled/)
		await until(() => !f.sessions.list(f.workspace)[0]?.listening)
		assert.equal(f.sessions.list(f.workspace)[0]?.state, 'idle')
		assert.deepEqual(f.sessions.list(f.workspace)[0]?.messages, [])
		assert.equal(f.opens(), 1)
	} finally {
		await f.close()
	}
})

test('closing an edit window completes its real CLI wait normally without a resume command or caller retirement', async () => {
	const f = await fixture()
	try {
		const waiting = f.command('spec.md')
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		f.closeDocument()
		const result = JSON.parse((await waiting).stdout)
		assert.equal(result.closed, true)
		assert.equal(result.timedOut, false)
		assert.equal(result.feedback, null)
		assert.deepEqual(result.commands, {})
		assert.match(result.instructions, /Stop the listening loop/)
		assert.equal(f.sessions.list(f.workspace)[0]?.listening, false)
		assert.equal(f.sessions.list(f.workspace)[0]?.state, 'idle')
		assert.deepEqual(f.sessions.list(f.workspace)[0]?.messages, [])
		assert.equal(f.opens(), 1)
	} finally {
		await f.close()
	}
})

test('close before first read and between reply and re-wait ends the exact document wait without losing the reply', async () => {
	for (const phase of ['open', 'reply'] as const) {
		const f = await fixture()
		try {
			const original = f.backend.command
			f.backend.command = async (binding, command, signal) => {
				const result = await original(binding, command, signal)
				if (command.action === phase) f.closeDocument()
				return result
			}
			const opening = f.command('spec.md')
			if (phase === 'open') {
				assert.equal(JSON.parse((await opening).stdout).closed, true)
			} else {
				await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
				const owner = f.sessions.list(f.workspace)[0]
				assert.ok(owner)
				await f.send(owner)
				const first = JSON.parse((await opening).stdout)
				const continuing = f.command(...first.commands.reply.slice(2), 'The original reply is retained')
				const result = JSON.parse((await continuing).stdout)
				assert.equal(result.closed, true)
				assert.equal(result.timedOut, false)
				assert.deepEqual(result.commands, {})
				assert.equal(f.sessions.list(f.workspace)[0]?.messages.at(-1)?.text, 'The original reply is retained')
			}
			assert.equal(f.sessions.list(f.workspace)[0]?.listening, false)
			assert.equal(f.sessions.list(f.workspace)[0]?.state, 'idle')
			assert.equal(f.opens(), 1)
		} finally {
			await f.close()
		}
	}
})

test('window close does not turn already-delivered feedback into cancellation or prevent its final report', async () => {
	const f = await fixture()
	try {
		const opening = f.command('spec.md')
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		const owner = f.sessions.list(f.workspace)[0]
		assert.ok(owner)
		const sent = await f.send(owner)
		f.closeDocument()
		const first = JSON.parse((await opening).stdout)
		assert.deepEqual(first.feedback, sent.feedback)
		assert.equal(first.closed, false)
		assert.equal(f.sessions.receipt(sent.feedback.request.id)?.outcome, 'dispatched')
		const finished = JSON.parse(
			(await f.command(...first.commands.reply.slice(2), 'Completed in the original agent')).stdout,
		)
		assert.equal(finished.closed, true)
		assert.equal(f.sessions.list(f.workspace)[0]?.messages.at(-1)?.text, 'Completed in the original agent')
		assert.equal(f.sessions.list(f.workspace)[0]?.needsAcknowledgement, false)
	} finally {
		await f.close()
	}
})

test('a foreign closed-window result is rejected without acknowledgement, replay or another wait', async () => {
	const f = await fixture()
	try {
		const original = f.backend.command
		let reads = 0
		f.backend.command = async (binding, command, signal) => {
			if (command.action === 'next') {
				reads++
				return { closed: true, documentId: '99999999-9999-4999-8999-999999999999' }
			}
			return original(binding, command, signal)
		}
		await assert.rejects(f.command('spec.md'), /belongs to another window/)
		assert.equal(reads, 1)
		assert.equal(f.opens(), 1)
		assert.equal(f.sessions.list(f.workspace)[0]?.listening, false)
		assert.deepEqual(f.sessions.list(f.workspace)[0]?.messages, [])
	} finally {
		await f.close()
	}
})

test('a returned timeout handle ends immediately if its window subsequently closes', async () => {
	const f = await fixture()
	try {
		const timedOut = JSON.parse((await f.command('spec.md', '--timeout', '1')).stdout)
		assert.equal(timedOut.timedOut, true)
		f.closeDocument()
		const closed = JSON.parse((await f.command(...timedOut.commands.wait.slice(2))).stdout)
		assert.equal(closed.closed, true)
		assert.deepEqual(closed.commands, {})
		assert.equal(f.opens(), 1)
	} finally {
		await f.close()
	}
})

test('legacy unbound wait and reply handles preserve literal hash characters in the private connection path', async () => {
	const f = await fixture()
	try {
		const owner = await f.connect('pi')
		const legacy = join(f.root, 'legacy#connection.json')
		await writeFile(legacy, await readFile(owner.connection), { mode: 0o600 })
		const waiting = f.command('wait', legacy)
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		const sent = await f.send(owner)
		const first = JSON.parse((await waiting).stdout)
		assert.deepEqual(first.feedback, sent.feedback)
		assert.equal(first.documentId, undefined)
		assert.equal(first.commands.reply[3], `${legacy}#${sent.feedback.request.id}`)
		const replying = f.command(...first.commands.reply.slice(2), 'Legacy reply')
		await until(() => f.sessions.list(f.workspace)[0]?.listening === true)
		const secondSent = await f.send(owner)
		assert.deepEqual(JSON.parse((await replying).stdout).feedback, secondSent.feedback)
		assert.equal(f.sessions.list(f.workspace).length, 1)
		assert.equal(f.opens(), 0)
	} finally {
		await f.close()
	}
})

test('edit help is simple, and malformed input performs no enrollment', async () => {
	const f = await fixture()
	try {
		const help = await f.command('--help')
		assert.match(help.stdout, /Usage: helm edit FILE/)
		assert.match(help.stdout, /No agent is launched or replaced/)
		assert.match(help.stdout, /reports the answer AND listens/)
		for (const args of [
			['spec.md', '--timeout', '0'],
			['spec.md', 'another.md'],
			['reply', 'not-a-handle', 'reply'],
			['spec.md', '--unknown'],
		])
			await assert.rejects(f.command(...args))
		assert.equal(f.sessions.list(f.workspace).length, 0)
		assert.equal(f.opens(), 0)
	} finally {
		await f.close()
	}
})
