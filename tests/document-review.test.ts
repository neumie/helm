import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import accessModule from '../app/src/document-review/access'
import documentModule from '../app/src/document-review/document'
import draftModule from '../app/src/document-review/drafts'
import requestModule from '../app/src/document-review/request'
import admissionModule from '../app/src/document-review/request-admission'
import reviewSessionsModule from '../app/src/document-review/sessions'
import typesModule from '../app/src/document-review/types'
import markdownModule from '../app/src/renderer/document-review/markdown'
import sessionsModule from '../app/src/sessions'
import { configSchema } from '../src/config.js'
import { PlanWorkspace } from '../src/plan/workspace.js'
import { createAgentAdapter } from '../src/solver/agent-adapter.js'
import { ReviewJsonLines, projectReviewEvent } from '../src/solver/review-output.js'
import { spawnClaude } from '../src/solver/spawn-claude.js'
const { readReviewFile, reviewRevision, ReviewDocumentObservation } = documentModule
const { locateReviewPassage, validatePassage, reviewPrompt } = requestModule
const { ReviewDraftStore } = draftModule
const { parseReviewMarkdown } = markdownModule
const { SessionRegistry, planSessionRestore, isValidSessionId } = sessionsModule
const { defaultReviewDraft } = typesModule
const { ReviewSessions } = reviewSessionsModule
const { requireReviewAccess } = accessModule
const { parseReviewRequest } = admissionModule

async function fixture() {
	const temp = await mkdtemp('/tmp/hr-dr-')
	const root = await realpath(temp)
	const file = join(root, 'spec.md')
	await writeFile(file, '# A real document\n\nA **bold** passage.\n', { mode: 0o600 })
	return { root, file, close: () => rm(root, { recursive: true, force: true }) }
}

test('complete 67KB+ Markdown renders with validated original CRLF/Unicode source partitions', () => {
	const text = `# A document\r\n\r\n${Array.from(
		{ length: 700 },
		(_, i) =>
			`## Section ${i}\r\n\r\nThe **selected** passage has Unicode 🐝, links [example](https://example.org), and ordinary prose.\r\n\r\n| Name | Value |\r\n| --- | --- |\r\n| Original | ${i} |\r\n\r\n`,
	).join('')}Final sentinel.\r\n`
	assert.ok(Buffer.byteLength(text) > 67000)
	const model = parseReviewMarkdown(text)
	assert.equal(model.error, null)
	assert.equal(model.blocks.at(-1)?.end, text.length)
	assert.equal(model.blocks.filter(b => b.heading).length, 701)
	for (const block of model.blocks)
		assert.equal(text.slice(block.start, block.end).replace(/\r\n|\r/g, '\n'), block.token.raw)
})

test('rendered quotes never pretend to be exact Markdown offsets; repeated text is block-bound', () => {
	const text = 'A **selected** passage.\n\nA **selected** passage.\n'
	const revision = reviewRevision(text)
	const second = text.lastIndexOf('A **')
	const selection = locateReviewPassage(text, revision, second, text.length, 'selected passage')
	assert.ok(selection)
	assert.equal(selection.kind, 'block')
	assert.equal(selection.start, second)
	assert.equal(selection.source, text.slice(second))
	validatePassage(text, revision, selection)
	assert.throws(() => validatePassage(`${text}edit`, reviewRevision(`${text}edit`), selection), /changed/)
	assert.throws(() => validatePassage(text, revision, { ...selection, source: 'forged' }), /safely/)
})

test('native review access rejects foreign windows, subframes, stale profiles and disposed frames', () => {
	const frame = { isDestroyed: () => false }
	const contents = { isDestroyed: () => false, mainFrame: frame }
	assert.doesNotThrow(() => requireReviewAccess(contents, contents, frame, 'profile:1', 'profile:1', () => true))
	for (const [sender, top, token, current] of [
		[{}, frame, 'profile:1', true],
		[contents, {}, 'profile:1', true],
		[contents, frame, 'profile:0', true],
		[contents, frame, 'profile:1', false],
	] as const)
		assert.throws(() => requireReviewAccess(contents, sender, top, 'profile:1', token, () => current))
	const disposed = {
		isDestroyed: () => false,
		get mainFrame(): typeof frame {
			throw new Error('disposed')
		},
	}
	assert.throws(() => requireReviewAccess(disposed, disposed, frame, 'profile:1', 'profile:1', () => true))
	assert.throws(() =>
		requireReviewAccess(
			{ ...contents, isDestroyed: () => true },
			contents,
			frame,
			'profile:1',
			'profile:1',
			() => true,
		),
	)
})

test('request admission is strict and bounded before hashing or provider reservation', () => {
	const request = {
		id: randomUUID(),
		documentId: randomUUID(),
		sessionId: `review:${randomUUID()}`,
		owner: randomUUID(),
		revision: reviewRevision('document'),
		intent: 'discuss',
		instruction: 'Discuss this',
		passage: null,
	}
	assert.deepEqual(parseReviewRequest(request), request)
	for (const value of [
		null,
		{ ...request, path: '/etc/passwd' },
		{ ...request, sessionId: 'terminal' },
		{ ...request, instruction: 'x'.repeat(8001) },
		{ ...request, intent: 'execute' },
		{ ...request, owner: '' },
		{ ...request, revision: 'stale' },
		{ ...request, passage: { revision: request.revision, start: -1, end: 1, source: 'a', quote: 'a', kind: 'exact' } },
	])
		assert.throws(() => parseReviewRequest(value), /request/)
})

test('whole-document prompts remain bounded and do not copy the huge spec', () => {
	const text = 'PRIVATE DOCUMENT CONTENT\n'.repeat(4000)
	const prompt = reviewPrompt(
		{
			id: randomUUID(),
			documentId: randomUUID(),
			sessionId: `review:${randomUUID()}`,
			owner: randomUUID(),
			revision: reviewRevision(text),
			intent: 'discuss',
			instruction: 'Discuss the conclusion',
			passage: null,
		},
		text,
		'docs/spec.md',
	)
	assert.ok(prompt.includes('DISCUSS ONLY'))
	assert.ok(!prompt.includes('PRIVATE DOCUMENT CONTENT'))
	assert.ok(prompt.length < 2000)
})

test('file grants reject outside roots, hidden evidence, symlinks, hard links, and genuine byte limits', async () => {
	const f = await fixture()
	try {
		assert.match(await readReviewFile(f.root, f.file), /real document/)
		await symlink(f.file, join(f.root, 'linked.md'))
		await assert.rejects(readReviewFile(f.root, join(f.root, 'linked.md')))
		await link(f.file, join(f.root, 'hard.md'))
		await assert.rejects(readReviewFile(f.root, f.file))
		await rm(join(f.root, 'hard.md'))
		await writeFile(join(f.root, '.helm-private.md'), 'private')
		await assert.rejects(readReviewFile(f.root, join(f.root, '.helm-private.md')))
		await writeFile(join(f.root, 'huge.md'), 'x'.repeat(524289))
		await assert.rejects(readReviewFile(f.root, join(f.root, 'huge.md')), /512 KiB/)
		await assert.rejects(readReviewFile(join(f.root, 'elsewhere'), f.file))
	} finally {
		await f.close()
	}
})

test('observation refresh exposes changes/deletion, preserves last readable bytes, and disposes safely', async () => {
	const f = await fixture()
	let publishes = 0
	const observation = new ReviewDocumentObservation(f.root, f.file, () => publishes++)
	try {
		await observation.start()
		const first = observation.current()
		await writeFile(f.file, '# Changed document\n')
		await observation.refresh()
		assert.equal(observation.current().previous, first.text)
		assert.notEqual(observation.current().revision, first.revision)
		await rm(f.file)
		await observation.refresh()
		assert.ok(observation.current().error)
		assert.equal(observation.current().text, '# Changed document\n')
		await observation.dispose()
		const settled = publishes
		await observation.refresh()
		assert.equal(publishes, settled)
	} finally {
		await observation.dispose()
		await f.close()
	}
})

test('draft persistence is scope-keyed, bounded and private, and never authorizes a file', async () => {
	const f = await fixture()
	try {
		const store = new ReviewDraftStore(f.root)
		const first = store.key(f.root, f.file, 'review:11111111-1111-1111-1111-111111111111')
		const second = store.key(f.root, f.file, 'review:22222222-2222-2222-2222-222222222222')
		store.save(first, { ...defaultReviewDraft(), instruction: 'Retain my exact draft' })
		assert.equal(new ReviewDraftStore(f.root).load(first).instruction, 'Retain my exact draft')
		assert.equal(store.load(second).instruction, '')
		assert.throws(() => store.save(first, { ...defaultReviewDraft(), path: '/etc/passwd' }))
		assert.equal(store.load(first).instruction, 'Retain my exact draft')
		await chmod(store.file, 0o644)
		assert.throws(() => new ReviewDraftStore(f.root), /preserved/)
	} finally {
		await f.close()
	}
})

test('draft reload enforces actual byte and entry bounds and rejects linked private state', async () => {
	const f = await fixture()
	try {
		const store = new ReviewDraftStore(f.root)
		const key = store.key(f.root, f.file, null)
		store.save(key, defaultReviewDraft())
		await link(store.file, join(f.root, 'draft-link.json'))
		assert.throws(() => new ReviewDraftStore(f.root), /preserved/)
		await rm(join(f.root, 'draft-link.json'))
		await writeFile(store.file, 'x'.repeat(1024 * 1024 + 1))
		assert.throws(() => new ReviewDraftStore(f.root), /preserved/)
		const excessive = Object.fromEntries(
			Array.from({ length: 257 }, (_, index) => [index.toString(16).padStart(64, '0'), defaultReviewDraft()]),
		)
		await writeFile(store.file, JSON.stringify(excessive))
		assert.throws(() => new ReviewDraftStore(f.root), /preserved/)
		// Refusal never replaces the already trusted in-memory draft.
		assert.deepEqual(store.load(key), defaultReviewDraft())
	} finally {
		await f.close()
	}
})

test('review conversations persist in existing registry but can never restore as terminal shells, including old ID grammar', async () => {
	const f = await fixture()
	try {
		const registry = new SessionRegistry(join(f.root, 'sessions.json'))
		const id = `review:${randomUUID()}`
		assert.equal(isValidSessionId(id), false)
		assert.equal(
			registry.saveReviewSession(id, {
				provider: 'codex',
				conversationId: randomUUID(),
				workspace: f.root,
				uncertain: true,
			}),
			true,
		)
		const restored = new SessionRegistry(join(f.root, 'sessions.json'))
		assert.equal(restored.listReviewSessions()[0]?.meta.uncertain, true)
		assert.deepEqual(planSessionRestore(restored, { live: [], unknownIds: [] }).sessions, [])
		const failing = new SessionRegistry(join(f.root, 'sessions.json'), () => {
			throw new Error('disk unavailable')
		})
		assert.equal(failing.saveReviewSession(id, { ...restored.listReviewSessions()[0]?.meta, uncertain: false }), false)
		assert.equal(failing.listReviewSessions()[0]?.meta.uncertain, true)
	} finally {
		await f.close()
	}
})

test('legacy uncertain identities are never loaded as live callers after restart', async () => {
	const f = await fixture()
	try {
		const registry = new SessionRegistry(join(f.root, 'sessions.json'))
		const id = `review:${randomUUID()}`
		assert.equal(
			registry.saveReviewSession(id, {
				provider: 'pi',
				conversationId: randomUUID(),
				workspace: f.root,
				initialized: true,
				uncertain: true,
			}),
			true,
		)
		const recovered = new ReviewSessions(() => {})
		assert.deepEqual(recovered.list(f.root), [])
		assert.throws(() => recovered.reserve(id, randomUUID(), f.root), /unavailable/)
		assert.equal('restore' in recovered, false)
		const fresh = recovered.connect('pi', f.root, 'Existing Pi', 'tool-return')
		assert.notEqual(fresh.id, id)
		assert.equal(fresh.listening, false)
		assert.equal(new SessionRegistry(join(f.root, 'sessions.json')).listReviewSessions()[0]?.meta.uncertain, true)
	} finally {
		await f.close()
	}
})

test('even normally settled legacy identities cannot create or resume an agent', async () => {
	const f = await fixture()
	try {
		const registry = new SessionRegistry(join(f.root, 'sessions.json'))
		const id = `review:${randomUUID()}`
		assert.equal(
			registry.saveReviewSession(id, {
				provider: 'pi',
				conversationId: randomUUID(),
				workspace: f.root,
				initialized: true,
				uncertain: false,
			}),
			true,
		)
		const sessions = new ReviewSessions(() => {})
		assert.deepEqual(sessions.list(f.root), [])
		assert.equal('start' in sessions, false)
		assert.equal(registry.listReviewSessions()[0]?.meta.unavailable, undefined)
	} finally {
		await f.close()
	}
})

test('all named providers use stable supported CLI continuation without shell expansion or experimental app-server', () => {
	const id = randomUUID()
	for (const provider of ['claude', 'codex', 'pi'] as const) {
		const adapter = createAgentAdapter(configSchema.innerType().shape.solver.parse({ agent: provider }))
		const invocation = adapter.buildReviewInvocation({ conversationId: id, resume: true, discuss: true })
		assert.equal(invocation.command, provider)
		assert.ok(invocation.args.includes(id))
		assert.ok(!invocation.args.includes('app-server'))
		assert.ok(!invocation.args.some(arg => arg.includes('cat ') || arg.includes('$(')))
	}
})

test('provider projections expose actual messages, not commands/arguments/diagnostics; strict LF framing handles Unicode', () => {
	assert.deepEqual(
		projectReviewEvent('codex', { type: 'item.completed', item: { type: 'command_execution', command: 'secret' } }),
		[],
	)
	assert.deepEqual(projectReviewEvent('pi', { type: 'tool_execution_start', args: { secret: 'never expose' } }), [])
	assert.deepEqual(
		projectReviewEvent('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', input: 'secret' }] } }),
		[],
	)
	const events: unknown[] = []
	const decoder = new ReviewJsonLines('codex', value => events.push(value))
	const bytes = Buffer.from(
		`${JSON.stringify({
			type: 'item.completed',
			item: { type: 'agent_message', id: 'a', text: 'Unicode 🐝\u2028 remains text' },
		})}\n`,
	)
	for (const byte of bytes) decoder.push(Buffer.from([byte]))
	decoder.finish()
	assert.equal((events[0] as { text: string }).text, 'Unicode 🐝\u2028 remains text')
})

test('bounded streaming spawn delivers actual stdout and refuses overflow without unbounded buffering', async () => {
	let streamed = ''
	let dispatched = 0
	const result = await spawnClaude({
		command: process.execPath,
		args: ['-e', "process.stdin.on('data', b => process.stdout.write(b));"],
		cwd: process.cwd(),
		prompt: 'hello',
		timeoutMs: 5000,
		maxOutputBytes: 100,
		onStdout: chunk => {
			streamed += chunk.toString()
		},
		onDispatched: () => dispatched++,
	})
	assert.equal(result.stdout, 'hello')
	assert.equal(streamed, 'hello')
	assert.equal(dispatched, 1)
	await assert.rejects(
		spawnClaude({
			command: process.execPath,
			args: ['-e', "process.stdout.write('x'.repeat(200));"],
			cwd: process.cwd(),
			prompt: '',
			timeoutMs: 5000,
			maxOutputBytes: 100,
		}),
		/bounded/,
	)
})

test('spawn cancellation refuses pre-aborted work and settles an owned active child', async () => {
	const before = new AbortController()
	before.abort()
	let dispatched = 0
	await assert.rejects(
		spawnClaude({
			command: process.execPath,
			args: ['-e', 'process.exit(0)'],
			cwd: process.cwd(),
			prompt: '',
			timeoutMs: 5000,
			signal: before.signal,
			onDispatched: () => dispatched++,
		}),
		{ name: 'AbortError' },
	)
	assert.equal(dispatched, 0)
	const active = new AbortController()
	await assert.rejects(
		spawnClaude({
			command: process.execPath,
			args: ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
			cwd: process.cwd(),
			prompt: '',
			timeoutMs: 5000,
			signal: active.signal,
			onStdout: () => active.abort(),
		}),
		{ name: 'AbortError' },
	)
})

test(
	'spawn deadline releases inherited pipes after own CLI exit without claiming completion',
	{ timeout: 5000 },
	async () => {
		const started = Date.now()
		await assert.rejects(
			spawnClaude({
				command: process.execPath,
				args: [
					'-e',
					"require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: ['ignore', 1, 2] }).unref(); process.exit(0)",
				],
				cwd: process.cwd(),
				prompt: '',
				timeoutMs: 250,
			}),
			/timed out/,
		)
		assert.ok(Date.now() - started < 1800, 'must settle before the owned disposable pipe holder naturally exits')
	},
)

test('plan review paths use PlanWorkspace and refuse generated/private/traversal artifacts', () => {
	const workspace = new PlanWorkspace('/approved/worktree', 'plan')
	assert.equal(workspace.reviewArtifactPath('spec.md'), '/approved/worktree/docs/plans/plan/spec.md')
	for (const name of ['../secret.md', '.helm-knowledge-context.md', 'context.md', 'README.md', 'script.js'])
		assert.throws(() => workspace.reviewArtifactPath(name))
})
