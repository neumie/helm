// Opt-in (HELM_DOCUMENT_REVIEW_CALLER_PROOF=1): a NEW disposable Claude Code / Codex agent runs the real `helm edit`
// through the existing caller harness; the activity watcher reads its real session file (read-only, under the
// user's real ~/.claude / ~/.codex) and must show working, a verb and output tokens for the exact request, then
// freeze at the reply. The production host never launches an agent.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { test } from 'node:test'
import watcherModule from '../app/src/document-review/activity-watcher'
import { configSchema } from '../src/config.js'
import type { ReviewActivity } from '../src/document-review/types.js'
import { createAgentAdapter } from '../src/solver/agent-adapter.js'
import { spawnClaude } from '../src/solver/spawn-claude.js'
import { callerFixture } from './helpers/document-review-caller'

const { ReviewActivityWatcher, providerSources } = watcherModule
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const MODELS = { claude: 'claude-haiku-4-5', codex: 'gpt-5.6-luna' } as const

for (const provider of ['claude', 'codex'] as const)
	test(
		`live ${provider}: helm edit's session hint drives the send activity line from the real session file`,
		{ skip: process.env.HELM_DOCUMENT_REVIEW_CALLER_PROOF !== '1', timeout: 300000 },
		async () => {
			const f = await callerFixture(180000)
			const abort = new AbortController()
			const requestId = randomUUID()
			const cli = `${quote(process.execPath)} --import ${quote(import.meta.resolve('tsx'))} ${quote(resolve('src/cli/helm.ts'))}`
			const command = `HOME=${quote(f.workspace)} ${cli} edit ${quote(f.file)} --agent ${provider} --timeout 200`
			const adapter = createAgentAdapter(
				configSchema.innerType().shape.solver.parse({ agent: provider, model: MODELS[provider] }),
			)
			const invocation = adapter.buildReviewInvocation({ conversationId: randomUUID(), resume: false, discuss: false })
			// The proof agent gets its own provider identity, never this test runner's.
			const environment: NodeJS.ProcessEnv = { ...process.env, HELM_REMOTE_DISABLE_AUTO: '1' }
			for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_THREAD_ID'])
				Reflect.deleteProperty(environment, key)
			let finished = false
			const launch = spawnClaude({
				command: invocation.command,
				args: invocation.args,
				cwd: f.workspace,
				timeoutMs: 240000,
				maxOutputBytes: 4 * 1024 * 1024,
				signal: abort.signal,
				environment,
				prompt: `You are an agent in a disposable integration test. FIRST run this exact shell command in the foreground and wait for it to return (it can take a minute): ${command}. It returns JSON with feedback.prompt and commands.reply. Do what feedback.prompt asks, then run commands.reply with your one-sentence answer appended as ONE extra quoted argument, in the foreground. If that command returns closed: true, stop. Never use subagents or skills, never edit files, never start another agent.`,
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
			const watcher = new ReviewActivityWatcher(
				() => [['work', f.sessions]],
				() => {},
				providerSources(),
				Date.now,
				60000,
			)
			try {
				const end = Date.now() + 150000
				while (!f.sessions.list(f.workspace).some(value => value.listening)) {
					if (finished || Date.now() >= end) throw new Error(`${provider} did not reach helm edit's wait`)
					await new Promise(done => setTimeout(done, 50))
				}
				const owner = f.sessions.list(f.workspace).find(value => value.listening)
				assert.ok(owner)
				const { feedback } = await f.send(
					owner,
					'Discussion only, do not edit anything. First read spec.md with your file-reading tool (or cat it), then run the shell command `ls -la`, then answer: how many lines does spec.md have?',
					requestId,
					'discuss',
				)
				const seen: ReviewActivity[] = []
				const replied = () =>
					f.sessions
						.list(f.workspace)
						.find(value => value.id === owner.id)
						?.messages.some(value => value.id === `${requestId}:assistant`)
				while (!replied()) {
					if (finished || Date.now() >= end + 60000) throw new Error(`${provider} never replied`)
					await watcher.tick()
					const view = watcher.activity('work', owner.id, feedback.request.documentId)
					if (view) seen.push(view)
					await new Promise(done => setTimeout(done, 500))
				}
				await watcher.tick()
				const final = watcher.activity('work', owner.id, feedback.request.documentId)
				f.closeDocument()
				const result = await completion
				assert.equal(result.exitCode, 0)
				assert.ok(
					seen.some(view => view.working && view.requestId === requestId),
					'saw working for the exact request',
				)
				assert.ok(final && !final.working, 'frozen after the reply')
				assert.ok((final?.outputTokens ?? 0) > 0, `output tokens counted (${final?.outputTokens})`)
				assert.equal(f.sessions.receipt(requestId)?.outcome, 'dispatched')
				console.log(
					`${provider}: ${seen.length} views; verbs ${[...new Set(seen.map(view => view.verb ?? 'Thinking'))].join(', ')}; final tokens ${final?.outputTokens}`,
				)
			} finally {
				watcher.stop()
				abort.abort()
				await completion.catch(() => {})
				await f.close()
			}
		},
	)
