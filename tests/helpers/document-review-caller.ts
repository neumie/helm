import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import documentModule from '../../app/src/document-review/document'
import requestModule from '../../app/src/document-review/request'
import sessionsModule from '../../app/src/document-review/sessions'
import { connectReview, loadReviewConnection } from '../../src/document-review/client.js'
import { ReviewControlServer } from '../../src/document-review/control-server.js'
import type { CallerBinding, ReviewControlBackend } from '../../src/document-review/control-server.js'
import type { ReviewFeedback } from '../../src/document-review/types.js'
const { ReviewSessions } = sessionsModule
const { readReviewFile, reviewRevision } = documentModule
const { reviewPrompt } = requestModule
const run = promisify(execFile)

/** Real private wire + real mailbox/file grant. Opening is a fixture, not an Electron certification. */
export async function callerFixture(deadline = 2000) {
	const temporary = await mkdtemp('/tmp/hca-')
	const workspace = await realpath(temporary)
	const root = join(workspace, '.helm', 'document-review')
	const file = join(workspace, 'spec.md')
	await run('git', ['init', '-q', workspace])
	await writeFile(file, '# Review\n\nKeep this original document.\n', { mode: 0o600 })
	let current = true
	let opens = 0
	const sessions = new ReviewSessions(() => {}, deadline, Math.min(deadline, 10000))
	const documentId = randomUUID()
	const backend: ReviewControlBackend = {
		status: () => ({ available: current }),
		current: binding => {
			try {
				sessions.get(binding.id, binding.owner)
				return current
			} catch {
				return false
			}
		},
		connect: async command => {
			assert.equal(command.workspace, workspace)
			const session = sessions.connect(command.provider, workspace, command.label, command.transport)
			return { id: session.id, owner: session.owner, workspace, profileId: 'work', profileToken: 'work:1' }
		},
		command: async (binding, command, signal) => {
			switch (command.action) {
				case 'open': {
					const text = await readReviewFile(workspace, command.file)
					opens++
					return { documentId, revision: reviewRevision(text), relativePath: 'spec.md' }
				}
				case 'list':
					return sessions.list(workspace).map(value => ({
						...value,
						messages: [],
						historyTruncated: value.messages.length > 0 || value.historyTruncated,
					}))
				case 'status':
					return sessions.list(workspace).find(value => value.id === binding.id)
				case 'next':
					return sessions.next(binding.id, binding.owner, command.timeoutMs, signal)
				case 'ack':
					sessions.confirm(binding.id, binding.owner, command.requestId)
					return true
				case 'reply':
					sessions.report(binding.id, binding.owner, command.requestId, command.sequence, command.state, command.text)
					return true
				case 'receipt':
					return sessions.receipt(command.requestId, binding.id)
				case 'disconnect':
					sessions.disconnect(binding.id, binding.owner)
					return true
			}
		},
		disconnect: binding => {
			try {
				sessions.disconnect(binding.id, binding.owner)
			} catch {
				/* retired */
			}
		},
	}
	const host = new ReviewControlServer(root, backend)
	await host.start()
	const connect = async (provider: 'claude' | 'codex' | 'pi' = 'pi') => {
		const connected = await connectReview(
			{ action: 'connect', provider, workspace, label: `${provider} original caller`, transport: 'tool-return' },
			root,
		)
		return { ...connected, authority: await loadReviewConnection(connected.connection) }
	}
	const send = async (
		binding: Pick<CallerBinding, 'id' | 'owner'>,
		instruction = 'Discuss the actual source.',
		requestId = randomUUID(),
		intent: 'discuss' | 'change' = 'discuss',
	) => {
		const text = await readReviewFile(workspace, file)
		const request = {
			id: requestId,
			documentId,
			sessionId: binding.id,
			owner: binding.owner,
			revision: reviewRevision(text),
			intent,
			instruction,
			passage: null,
		}
		const feedback: ReviewFeedback = {
			request,
			prompt: reviewPrompt(request, text, 'spec.md'),
			relativePath: 'spec.md',
		}
		const owner = sessions.reserve(binding.id, binding.owner, workspace)
		return { feedback, receipt: sessions.dispatch(owner, request.id, request.id, feedback) }
	}
	return {
		workspace,
		root,
		file,
		backend,
		sessions,
		host,
		connect,
		send,
		opens: () => opens,
		fence: () => {
			current = false
			sessions.stopOwned()
		},
		close: async () => {
			await host.stop()
			await rm(workspace, { recursive: true, force: true })
		},
	}
}
