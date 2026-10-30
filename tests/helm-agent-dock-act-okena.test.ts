// Agent dock slice 2, end to end below the renderer: AgentDockWatcher.act →
// OkenaClaudeSource (CAS read) → real OkenaClient → a fake Okena HTTP server on
// a private Unix socket. Asserts the exact Okena routes/bodies (the ones
// `okena claude answer` / `okena claude prompt` send) and that no answer text
// reaches the spool. Never talks to a live Okena.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import modelModule from '../app/src/agent-dock/model.ts'
import sourceModule from '../app/src/agent-dock/okena-claude-source.ts'
import reduceModule from '../app/src/agent-dock/reduce.ts'
import watcherModule from '../app/src/agent-dock/watcher.ts'
import { OkenaClient } from '../src/extensions/okena/client.js'

type SourceModule = typeof import('../app/src/agent-dock/okena-claude-source.ts')
type WatcherModule = typeof import('../app/src/agent-dock/watcher.ts')
type ReduceModule = typeof import('../app/src/agent-dock/reduce.ts')
type ModelModule = typeof import('../app/src/agent-dock/model.ts')
type DockItem = import('../app/src/agent-dock/model.ts').DockItem

const { OkenaClaudeSource } = sourceModule as SourceModule
const { AgentDockWatcher } = watcherModule as WatcherModule
const { TURN_IDLE_MS } = reduceModule as ReduceModule
const { ACT_CONFIRM_MS } = modelModule as ModelModule

type Json = Record<string, unknown>
function fixture<T = Json>(name: string): T {
	return JSON.parse(readFileSync(new URL(`./fixtures/okena-claude/${name}`, import.meta.url), 'utf8')) as T
}
const STATE_ASK = fixture('state-ask.json')
const SHOW_ASK: Json = { ...fixture('show-ask.json'), channel_attached: false }
const SHOW_IDLE: Json = { ...fixture('show-idle.json'), channel_attached: false }
const TID = SHOW_ASK.terminal_id as string
const SID = SHOW_ASK.session_id as string
const ASK_DIALOG = (SHOW_ASK.dialogs as Json[])[0] as Json
const TOKEN = 'dock-act-token'

const bashDialog = (id: string, overrides: Json = {}): Json => ({
	id,
	tool_name: 'Bash',
	tool_input: { command: 'npm run deploy:stage', description: 'Deploy to stage' },
	permission_suggestions: [
		{
			type: 'addRules',
			rules: [{ toolName: 'Bash', ruleContent: 'npm run deploy:stage' }],
			behavior: 'allow',
			destination: 'localSettings',
		},
	],
	created_at_ms: 1_793_364_800_000,
	...overrides,
})

interface Post {
	url: string
	auth?: string
	type?: string
	body: unknown
}

/** A minimal stateful Okena Claude Remote API: state, session, transcript, dialog decision, prompt. */
class FakeOkenaServer {
	version = 2_000
	detail: Json = structuredClone(SHOW_ASK)
	entries: Json[] = []
	posts: Post[] = []
	gets: string[] = []
	/** Next dialog POST answers with this instead of closing the dialog. */
	dialogReply: { status: number; text: string } | null = null
	promptReply: { status: number; text: string } | null = null

	handle = async (request: IncomingMessage, response: import('node:http').ServerResponse) => {
		const url = request.url ?? ''
		const plain = (status: number, text: string) => {
			response.writeHead(status, { 'Content-Type': 'text/plain' })
			response.end(text)
		}
		const json = (body: unknown) => {
			response.writeHead(200, { 'Content-Type': 'application/json' })
			response.end(JSON.stringify(body))
		}
		if (request.headers.authorization !== `Bearer ${TOKEN}`) return plain(401, 'unauthorized')
		if (request.method === 'POST') {
			const chunks: Buffer[] = []
			for await (const chunk of request) chunks.push(chunk as Buffer)
			const raw = Buffer.concat(chunks).toString('utf8')
			this.posts.push({
				url,
				auth: request.headers.authorization,
				type: request.headers['content-type'],
				body: JSON.parse(raw),
			})
			const base = `/v1/claude/terminals/${encodeURIComponent(TID)}`
			if (url === `${base}/prompt`) {
				if (this.promptReply) return plain(this.promptReply.status, this.promptReply.text)
				this.entries.push({ kind: 'user', uuid: `u-${this.entries.length}`, text: '…', origin: 'terminal' })
				this.detail = { ...this.detail, busy: true }
				this.version++
				return json({ delivery: 'pty' })
			}
			const match = url.startsWith(`${base}/dialogs/`) ? decodeURIComponent(url.slice(base.length + 9)) : null
			if (match !== null) {
				if (this.dialogReply) return plain(this.dialogReply.status, this.dialogReply.text)
				const dialogs = this.detail.dialogs as Json[]
				if (!dialogs.some(dialog => dialog.id === match)) return plain(404, 'dialog is no longer open')
				this.detail = { ...this.detail, dialogs: dialogs.filter(dialog => dialog.id !== match) }
				this.version++
				return json({})
			}
			return plain(404, 'not found')
		}
		this.gets.push(url)
		if (url === '/v1/state') {
			const dialogs = (this.detail.dialogs as Json[]).length
			return json({
				...STATE_ASK,
				state_version: this.version,
				claude_sessions: [TID],
				claude_dialogs: dialogs ? { [TID]: dialogs } : {},
			})
		}
		if (url === `/v1/claude/terminals/${TID}`) return json(this.detail)
		if (url.startsWith(`/v1/claude/terminals/${TID}/transcript`)) {
			const query = new URL(url, 'http://okena').searchParams
			const cursor = query.has('cursor') ? Number(query.get('cursor')) : null
			const from = cursor === null ? 0 : cursor
			return json({
				session_id: SID,
				entries: this.entries.slice(from),
				cursor: this.entries.length,
				reset: cursor === null,
			})
		}
		return plain(404, 'terminal not found')
	}
}

function writeProfile(root: string, socketPath: string): string {
	const baseDir = join(root, 'config')
	const profileDir = join(baseDir, 'profiles', 'p1')
	mkdirSync(profileDir, { recursive: true })
	writeFileSync(join(baseDir, 'profiles.json'), JSON.stringify({ last_used: 'p1' }))
	writeFileSync(join(profileDir, 'cli.json'), JSON.stringify({ token: TOKEN, token_id: 't' }))
	writeFileSync(
		join(profileDir, 'remote.json'),
		JSON.stringify({ pid: process.pid, port: 1, local_endpoint: { kind: 'unix_socket', path: socketPath } }),
	)
	return baseDir
}

async function harness(setup?: (okena: FakeOkenaServer) => void) {
	const root = mkdtempSync(join(tmpdir(), 'hda-'))
	const okena = new FakeOkenaServer()
	setup?.(okena)
	const socketPath = join(root, 'o.sock')
	const server: Server = createServer((request, response) => {
		void okena.handle(request, response)
	})
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(socketPath, resolve)
	})
	const dir = join(root, 'agent-dock')
	const clock = { now: 1_793_364_800_000 }
	const source = new OkenaClaudeSource(new OkenaClient(writeProfile(root, socketPath)))
	const watcher = new AgentDockWatcher({
		dir,
		source,
		publish: () => {},
		isFocused: () => true,
		now: () => clock.now,
		log: () => {},
	})
	await watcher.load()
	const tick = async (advance = 1_500) => {
		clock.now += advance
		await watcher.tick()
		await watcher.drain()
	}
	const items = () => watcher.snapshot().items
	const item = (kind: DockItem['kind'] = 'ask') => {
		const found = items().find(candidate => candidate.kind === kind)
		assert.ok(found, `no ${kind} item`)
		return found
	}
	/** Everything the dock wrote to disk, concatenated. */
	const disk = () =>
		readdirSync(dir)
			.map(name => readFileSync(join(dir, name), 'utf8'))
			.join('\n')
	const done = async () => {
		watcher.stop()
		await watcher.drain()
		await new Promise<void>(resolve => server.close(() => resolve()))
		rmSync(root, { recursive: true, force: true })
	}
	return { okena, watcher, clock, tick, item, items, disk, done }
}

const DIALOG_PATH = (id: string) => `/v1/claude/terminals/${TID}/dialogs/${encodeURIComponent(id)}`

test('answer: CAS read, then POST the ApiClaudeDecision answer body; the closed dialog confirms by dock', async () => {
	const h = await harness()
	try {
		await h.tick()
		const ask = h.item()
		assert.equal(ask.state, 'open')
		const gets = h.okena.gets.length
		const result = await h.watcher.act({
			itemId: ask.id,
			rev: ask.rev,
			action: { type: 'answer', picks: [{ options: [1] }, { options: [0] }] },
		})
		assert.deepEqual(result, { ok: true, outcome: { status: 'sent' } })
		// Fresh session read (CAS) before the POST.
		assert.deepEqual(h.okena.gets.slice(gets), [`/v1/claude/terminals/${TID}`])
		assert.deepEqual(h.okena.posts, [
			{
				url: DIALOG_PATH(ASK_DIALOG.id as string),
				auth: `Bearer ${TOKEN}`,
				type: 'application/json',
				body: { decision: 'answer', answers: { 'Barva?': 'Blue', 'Velikost?': 'S' } },
			},
		])
		assert.equal(h.item().state, 'sending')
		assert.equal(h.item().receipt?.status, 'sent')
		await h.tick()
		const done = h.item()
		assert.equal(done.state, 'resolved')
		assert.equal(done.resolution?.by, 'dock')
		assert.equal(done.receipt?.status, 'confirmed')
		// Nothing Jakub answered, nor the dialog's text, reaches the spool.
		const onDisk = h.disk()
		for (const secret of ['Blue', 'Barva', 'Velikost', 'Červená']) assert.ok(!onDisk.includes(secret), secret)
		assert.match(onDisk, /"t":"act\.outcome"/)
		assert.match(onDisk, /"by":"dock"/)
	} finally {
		await h.done()
	}
})

test('permission: Always allow posts {decision:allow, always:true}; Deny posts the trimmed message', async () => {
	const h = await harness(okena => {
		okena.detail = { ...okena.detail, dialogs: [bashDialog('perm-1')] }
	})
	try {
		await h.tick()
		const first = h.item()
		assert.equal((await h.watcher.act({ itemId: first.id, rev: 1, action: { type: 'allow', always: true } })).ok, true)
		await h.tick()
		assert.equal(h.items().find(item => item.id === first.id)?.resolution?.by, 'dock')
		assert.equal(h.items().find(item => item.id === first.id)?.receipt?.always, true)

		h.okena.detail = { ...h.okena.detail, dialogs: [bashDialog('perm 2/x')] }
		h.okena.version++
		await h.tick()
		const second = h.items().find(item => item.state === 'open')
		assert.ok(second)
		const denied = await h.watcher.act({
			itemId: second.id,
			action: { type: 'deny', message: '  use deploy:preview instead\n', confirmed: true },
		})
		assert.equal(denied.ok, true)
		assert.deepEqual(
			h.okena.posts.map(post => [post.url, post.body]),
			[
				[DIALOG_PATH('perm-1'), { decision: 'allow', always: true }],
				// Dialog ids are percent-encoded like the CLI's terminal_path.
				[
					`/v1/claude/terminals/${TID}/dialogs/perm%202%2Fx`,
					{ decision: 'deny', message: 'use deploy:preview instead' },
				],
			],
		)
		await h.tick()
		assert.ok(!h.disk().includes('deploy:preview'))
	} finally {
		await h.done()
	}
})

test('CAS refusal: the dialog changed under the same id → nothing is posted, the item stays open', async () => {
	const h = await harness(okena => {
		okena.detail = { ...okena.detail, dialogs: [bashDialog('perm-1')] }
	})
	try {
		await h.tick()
		const ask = h.item()
		// Same dialog id, different command (the card Jakub read is stale).
		h.okena.detail = {
			...h.okena.detail,
			dialogs: [bashDialog('perm-1', { tool_input: { command: 'npm run deploy:prod' } })],
		}
		const result = await h.watcher.act({ itemId: ask.id, rev: 1, action: { type: 'allow' } })
		assert.equal(result.ok, false)
		assert.equal(result.outcome.status, 'refused')
		assert.equal(result.outcome.status === 'refused' && result.outcome.reason, 'changed')
		assert.deepEqual(h.okena.posts, [])
		assert.equal(h.item().state, 'open')
		assert.equal(h.item().receipt?.status, 'refused')

		// Gone before the CAS read: refused as answered elsewhere, still no POST.
		h.okena.detail = { ...h.okena.detail, dialogs: [] }
		const gone = await h.watcher.act({ itemId: ask.id, rev: 1, action: { type: 'allow' } })
		assert.equal(gone.outcome.status === 'refused' && gone.outcome.reason, 'gone')
		assert.deepEqual(h.okena.posts, [])

		// A stale rev never even reads Okena.
		const gets = h.okena.gets.length
		const stale = await h.watcher.act({ itemId: ask.id, rev: 7, action: { type: 'allow' } })
		assert.equal(stale.outcome.status === 'refused' && stale.outcome.reason, 'changed')
		assert.equal(h.okena.gets.length, gets)
	} finally {
		await h.done()
	}
})

test('Okena errors: 500 is a verbatim failure (item reopens); 404 on the dialog = answered elsewhere', async () => {
	const h = await harness()
	try {
		await h.tick()
		const ask = h.item()
		const answer = { type: 'answer', picks: [{ options: [0] }, { options: [1] }] }
		h.okena.dialogReply = { status: 500, text: 'bridge unavailable' }
		const failed = await h.watcher.act({ itemId: ask.id, rev: 1, action: answer })
		assert.deepEqual(failed, {
			ok: false,
			outcome: {
				status: 'failed',
				detail: `Okena POST ${DIALOG_PATH(ASK_DIALOG.id as string)} failed (500): bridge unavailable`,
			},
		})
		assert.equal(h.item().state, 'open')
		assert.equal(h.item().receipt?.status, 'failed')

		h.okena.dialogReply = { status: 404, text: 'dialog is no longer open' }
		const gone = await h.watcher.act({ itemId: ask.id, rev: 1, action: answer })
		assert.equal(gone.outcome.status, 'refused')
		assert.equal(gone.outcome.status === 'refused' && gone.outcome.reason, 'gone')
		assert.match(gone.outcome.status === 'refused' ? gone.outcome.detail : '', /\(404\): dialog is no longer open/)
		assert.equal(h.okena.posts.length, 2)
		// Spool keeps the reason, never the error text with answers in it.
		assert.ok(!h.disk().includes('bridge unavailable'))
	} finally {
		await h.done()
	}
})

test('reply: idle turn → CAS (transcript tail) → POST /prompt {text}; the user entry confirms by dock', async () => {
	const h = await harness(okena => {
		okena.detail = { ...structuredClone(SHOW_IDLE), busy: true }
		okena.entries = [{ kind: 'user', uuid: 'u-a', text: 'start', origin: 'terminal' }]
	})
	try {
		await h.tick()
		// The agent finishes a turn and goes idle.
		h.okena.entries.push({ kind: 'assistant', uuid: 'a-1', text: 'Ready for the next step?' })
		h.okena.detail = { ...h.okena.detail, busy: false }
		h.okena.version++
		await h.tick()
		await h.tick(TURN_IDLE_MS)
		const turn = h.item('turn')
		assert.equal(turn.state, 'open')

		const risky = await h.watcher.act({ itemId: turn.id, rev: turn.rev, action: { type: 'prompt', text: 'merge it' } })
		assert.equal(risky.outcome.status === 'refused' && risky.outcome.reason, 'invalid')
		assert.deepEqual(h.okena.posts, [])

		const gets = h.okena.gets.length
		const sent = await h.watcher.act({
			itemId: turn.id,
			rev: turn.rev,
			action: { type: 'prompt', text: 'Ano, pokračuj s merge.\n', confirmed: true },
		})
		assert.deepEqual(sent, { ok: true, outcome: { status: 'sent', delivery: 'pty' } })
		assert.deepEqual(h.okena.gets.slice(gets), [
			`/v1/claude/terminals/${TID}`,
			`/v1/claude/terminals/${TID}/transcript`,
		])
		assert.deepEqual(
			h.okena.posts.map(post => [post.url, post.body, post.type]),
			[[`/v1/claude/terminals/${TID}/prompt`, { text: 'Ano, pokračuj s merge.' }, 'application/json']],
		)
		// Okena now reports busy; the expedited transcript read still sees the user entry.
		await h.tick()
		const done = h.item('turn')
		assert.equal(done.resolution?.by, 'dock')
		assert.equal(done.receipt?.delivery, 'pty')
		assert.ok(!h.disk().includes('pokračuj'))
	} finally {
		await h.done()
	}
})

test('reply refused when someone already answered in the terminal; prompt errors keep the Okena reason verbatim', async () => {
	const h = await harness(okena => {
		okena.detail = { ...structuredClone(SHOW_IDLE), busy: true }
		okena.entries = [{ kind: 'user', uuid: 'u-a', text: 'start', origin: 'terminal' }]
	})
	try {
		await h.tick()
		h.okena.entries.push({ kind: 'assistant', uuid: 'a-1', text: 'Done.' })
		h.okena.detail = { ...h.okena.detail, busy: false }
		h.okena.version++
		await h.tick()
		await h.tick(TURN_IDLE_MS)
		const turn = h.item('turn')

		h.okena.promptReply = { status: 409, text: 'No Claude session detected in this pane' }
		const failed = await h.watcher.act({ itemId: turn.id, action: { type: 'prompt', text: 'ok' } })
		assert.deepEqual(failed.outcome, {
			status: 'failed',
			detail: 'Okena refused the reply (409): No Claude session detected in this pane. Reply in the terminal.',
		})
		assert.equal(h.item('turn').state, 'open')

		h.okena.promptReply = null
		h.okena.entries.push({ kind: 'user', uuid: 'u-b', text: 'typed in the pane', origin: 'terminal' })
		const refused = await h.watcher.act({ itemId: turn.id, action: { type: 'prompt', text: 'ok' } })
		assert.equal(refused.outcome.status === 'refused' && refused.outcome.reason, 'gone')
		assert.equal(h.okena.posts.length, 1)
	} finally {
		await h.done()
	}
})

test('a 2xx whose dialog stays open turns amber after 10 s, is not ackable, then comes back to answer again', async () => {
	const h = await harness()
	try {
		await h.tick()
		const ask = h.item()
		// Okena accepts but the dialog stays open (hook bridge lost it).
		h.okena.dialogReply = { status: 200, text: '{}' }
		const sent = await h.watcher.act({
			itemId: ask.id,
			action: { type: 'answer', picks: [{ options: [0] }, { options: [0] }] },
		})
		assert.equal(sent.ok, true)
		await h.tick()
		assert.equal(h.item().state, 'sending')
		await h.tick(ACT_CONFIRM_MS)
		assert.equal(h.item().state, 'unconfirmed')
		// The dialog is still open: acking would hide an agent that may still be blocked.
		assert.equal(await h.watcher.ack(ask.id), false)
		await h.tick(ACT_CONFIRM_MS)
		assert.equal(h.item().state, 'open')
		assert.equal(h.item().receipt?.status, 'failed')
	} finally {
		await h.done()
	}
})
