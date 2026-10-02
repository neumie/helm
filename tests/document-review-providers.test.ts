import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { configSchema } from '../src/config.js'
import { createAgentAdapter } from '../src/solver/agent-adapter.js'
import { spawnClaude } from '../src/solver/spawn-claude.js'
import { callerFixture } from './helpers/document-review-caller'

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
for (const provider of ['claude', 'codex', 'pi'] as const)
	test(
		`live ${provider}: original agent tool receives feedback, recalls its private context, edits, and reports`,
		{ skip: process.env.HELM_DOCUMENT_REVIEW_CALLER_PROOF !== '1', timeout: 240000 },
		async () => {
			// This harness alone launches a NEW disposable proof agent. The production host never launches one.
			const f = await callerFixture(180000)
			const abort = new AbortController()
			const privateContext = `same-context-${randomUUID()}`
			const requestId = randomUUID()
			const cli = `${quote(process.execPath)} --import ${quote(import.meta.resolve('tsx'))} ${quote(resolve('src/cli/helm.ts'))} review`
			const command = `HOME=${quote(f.workspace)} ${cli}`
			const adapter = createAgentAdapter(configSchema.innerType().shape.solver.parse({ agent: provider }))
			const invocation = adapter.buildReviewInvocation({ conversationId: randomUUID(), resume: false, discuss: false })
			let finished = false
			const launch = spawnClaude({
				command: invocation.command,
				args: invocation.args,
				cwd: f.workspace,
				timeoutMs: 180000,
				maxOutputBytes: 2 * 1024 * 1024,
				signal: abort.signal,
				environment: { ...process.env, HELM_REMOTE_DISABLE_AUTO: '1', PI_OFFLINE: '1' },
				prompt: `You are an already-running agent in a disposable integration test. Remember this private original context token: ${privateContext}. Do not write it to a file or run another agent. FIRST run this exact ordinary shell tool command and wait for it to return: ${command} open ${quote(f.file)} --agent ${provider} --wait --timeout 120 --json. The tool returns Helm review feedback into THIS same conversation. Read and carry out its feedback.prompt. Report your answer with the CLI reply command using the returned connection file and request ID; use --text containing the original private context token. Never commit, push, deploy, use skills or subagents, or edit anything except the explicit disposable spec.md requested by that feedback. Disconnect only the review connection when complete; no provider/session should be started or resumed.`,
			})
			const completion = launch.then(
				value => {
					finished = true
					return value
				},
				error => {
					finished = true
					throw error
				},
			)
			void completion.catch(() => {})
			try {
				const end = Date.now() + 120000
				while (!f.sessions.list(f.workspace).some(value => value.listening)) {
					if (finished || Date.now() >= end) throw new Error(`${provider} did not enter its existing-session CLI wait`)
					await new Promise(resolve => setTimeout(resolve, 20))
				}
				const owner = f.sessions.list(f.workspace).find(value => value.listening)
				assert.ok(owner)
				await f.send(
					owner,
					'This is explicit Change feedback to your ORIGINAL running session. Replace only the sentence "Keep this original document." in spec.md with "Original caller edit verified." Preserve all other bytes. Reply to Helm using the private context token you remembered BEFORE opening this UI. Do not start/resume another agent or reconstruct any session.',
					requestId,
					'change',
				)
				const result = await completion
				assert.equal(result.exitCode, 0)
				const snapshot = f.sessions.list(f.workspace).find(value => value.id === owner.id)
				assert.ok(
					snapshot?.messages.some(value => value.role === 'assistant' && value.text.includes(privateContext)),
					'Feedback must use context retained only by the original running agent',
				)
				assert.equal(snapshot?.owner, owner.owner)
				assert.equal(await readFile(f.file, 'utf8'), '# Review\n\nOriginal caller edit verified.\n')
				assert.equal(f.sessions.receipt(requestId)?.outcome, 'dispatched')
				assert.equal(f.opens(), 1)
			} finally {
				abort.abort()
				await completion.catch(() => {})
				await f.close()
			}
		},
	)
