// Signals column, Electron main side (app/src/signals-main.ts): the daemon is polled only
// while a window shows the column, pushes are deduplicated, only github.com / Mail links
// open, Okena parent projects map to GitHub repos, and `n` starts a worktree + Claude
// through the Okena CLI with a private, short-lived prompt file. Every exec is a fake:
// these tests never run gh, git, Okena or Mail.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import signalsMainModule from '../app/src/signals-main.ts'

type SignalsMainModule = typeof import('../app/src/signals-main.ts')
type SignalsBridgeState = import('../app/src/shared.ts').SignalsBridgeState
type SignalsSnapshot = import('../app/src/shared-helm.ts').SignalsSnapshot
type SignalsExec = import('../app/src/signals-main.ts').SignalsExec
type SignalsRequest = import('../app/src/signals-main.ts').SignalsRequest
const { SignalsMain, githubRepoFromRemote, signalOpenableUrl, resolveOkenaBinary, SIGNALS_POLL_MS } =
	signalsMainModule as SignalsMainModule

const TOKEN = 'work:1'
const WINDOW = { id: 1 }
const PARENT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const NEW_TERMINAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function snapshot(head: string, generatedAt = '2026-11-05T09:00:00.000Z'): SignalsSnapshot {
	return {
		threads: [
			{
				id: 1,
				threadKey: 'github:acme/widgets#7',
				source: 'github',
				kind: 'review',
				reasons: ['review'],
				ref: 'widgets#7',
				fullRef: 'acme/widgets#7',
				title: 'Example change',
				head,
				actor: 'reviewer-a',
				url: 'https://github.com/acme/widgets/pull/7',
				repo: 'acme/widgets',
				number: 7,
				branch: 'feat/example',
				state: 'new',
				owner: 'jakub',
				snoozedUntil: null,
				lastActivityAt: '2026-11-05T08:00:00.000Z',
				active: true,
				closedReason: null,
				note: null,
				noteAt: null,
				managedBy: null,
				routedAgent: null,
				routedHow: null,
				routedAt: null,
				createdAt: '2026-11-05T08:00:00.000Z',
				updatedAt: '2026-11-05T08:00:00.000Z',
			},
		],
		sources: [{ source: 'github', status: 'ok', detail: null, lastPollAt: null, lastOkAt: null }],
		seq: 3,
		generatedAt,
	}
}

class ManualTimers {
	next = 1
	pending = new Map<number, { callback: () => void; ms: number }>()
	setTimeout = (callback: () => void, ms: number) => {
		const id = this.next++
		this.pending.set(id, { callback, ms })
		return id
	}
	clearTimeout = (handle: unknown) => {
		this.pending.delete(handle as number)
	}
	fire(): number {
		const entries = [...this.pending.entries()]
		this.pending.clear()
		for (const [, entry] of entries) entry.callback()
		return entries.length
	}
}

const flush = async () => {
	for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve))
}

interface Harness {
	main: InstanceType<typeof SignalsMain>
	calls: Array<{ method: string; path: string; body?: unknown }>
	published: SignalsBridgeState[]
	timers: ManualTimers
	clock: { now: number }
	respond: { result: () => unknown }
	token: { value: string }
}

function harness(options: { readOnly?: boolean; exec?: SignalsExec; userDataDir?: string } = {}): Harness {
	const calls: Harness['calls'] = []
	const published: SignalsBridgeState[] = []
	const timers = new ManualTimers()
	const clock = { now: 1_000_000 }
	const respond: Harness['respond'] = { result: () => ({ data: snapshot('review requested · reviewer-a') }) }
	const token = { value: TOKEN }
	const request = (async (method: 'GET' | 'POST', path: string, body?: unknown) => {
		calls.push({ method, path, ...(body === undefined ? {} : { body }) })
		if (method === 'POST' && path === '/signals/poll') return { data: { requested: true } }
		if (method === 'POST') return { data: { id: 1 } }
		return respond.result()
	}) as SignalsRequest
	const main = new SignalsMain({
		request,
		acceptsIpc: (sender, profileToken) => sender === WINDOW && profileToken === token.value,
		profileToken: () => token.value,
		publish: state => published.push(state),
		exec:
			options.exec ??
			(async () => {
				throw new Error('no exec expected')
			}),
		openExternal: async () => undefined,
		userDataDir: options.userDataDir ?? join(tmpdir(), 'helm-signals-unused'),
		okenaBin: '/fake/okena',
		readOnly: options.readOnly ?? false,
		readOnlyError: 'read-only run',
		now: () => clock.now,
		timers,
		env: { PATH: '/usr/bin', GIT_DIR: '/elsewhere' },
	})
	return { main, calls, published, timers, clock, respond, token }
}

test('polls only while visible, asks sources once per 20 s and pushes only changes', async () => {
	const h = harness()
	assert.equal(h.timers.pending.size, 0)
	assert.equal(h.calls.length, 0, 'nothing is read before the column is shown')

	h.main.setVisible(WINDOW, true)
	await flush()
	assert.deepEqual(
		h.calls.map(call => `${call.method} ${call.path}`),
		['POST /signals/poll', 'GET /signals'],
	)
	assert.equal(h.published.length, 1)
	assert.equal(h.published[0]?.error, null)
	assert.equal(h.published[0]?.snapshot?.threads[0]?.head, 'review requested · reviewer-a')
	assert.equal([...h.timers.pending.values()][0]?.ms, SIGNALS_POLL_MS)

	// Same data, new generatedAt: read again, no push.
	h.respond.result = () => ({ data: snapshot('review requested · reviewer-a', '2026-11-05T09:00:03.000Z') })
	h.timers.fire()
	await flush()
	assert.equal(h.calls.filter(call => call.path === '/signals').length, 2)
	assert.equal(h.published.length, 1)

	// Changed head → one push.
	h.respond.result = () => ({ data: snapshot('approved · reviewer-a') })
	h.timers.fire()
	await flush()
	assert.equal(h.published.length, 2)
	assert.equal(h.main.getState().snapshot?.threads[0]?.head, 'approved · reviewer-a')

	// Daemon down: the last snapshot stays, with the reason.
	h.respond.result = () => ({ error: 'fetch failed' })
	h.timers.fire()
	await flush()
	assert.equal(h.published.length, 3)
	assert.equal(h.published[2]?.error, 'Helm daemon is not reachable')
	assert.equal(h.published[2]?.snapshot?.threads[0]?.head, 'approved · reviewer-a')

	// Hidden: the timer is gone and nothing more is read.
	h.main.setVisible(WINDOW, false)
	assert.equal(h.timers.pending.size, 0)
	const reads = h.calls.length
	await flush()
	assert.equal(h.calls.length, reads)

	// Shown again within 20 s: read, but no source poll.
	h.clock.now += 5_000
	h.respond.result = () => ({ data: snapshot('approved · reviewer-a') })
	h.main.setVisible(WINDOW, true)
	await flush()
	assert.deepEqual(
		h.calls.slice(reads).map(call => `${call.method} ${call.path}`),
		['GET /signals'],
	)
	// After 20 s: the sources are asked again.
	h.main.setVisible(WINDOW, false)
	h.clock.now += 20_000
	h.main.setVisible(WINDOW, true)
	await flush()
	assert.ok(h.calls.slice(reads + 1).some(call => call.path === '/signals/poll'))
	h.main.stop()
	assert.equal(h.timers.pending.size, 0)
})

test('a destroyed or reloaded renderer stops the polling; a profile switch drops the cached state', async () => {
	const h = harness()
	let destroyed: (() => void) | null = null
	const contents = {
		once: (_event: string, listener: () => void) => {
			destroyed = listener
		},
	}
	h.main.setVisible(contents, true)
	await flush()
	assert.equal(h.main.isPolling(), true)
	assert.ok(destroyed, 'watches its destroyed event')
	;(destroyed as () => void)()
	assert.equal(h.main.isPolling(), false)
	assert.equal(h.timers.pending.size, 0)

	h.main.setVisible(WINDOW, true)
	await flush()
	h.main.forget(WINDOW)
	assert.equal(h.main.isPolling(), false)

	assert.notEqual(h.main.getState().snapshot, null)
	h.token.value = 'other:2'
	assert.deepEqual(h.main.getState(), { snapshot: null, error: null, at: null })
})

test('update and routed POST, then re-read at once; the IPC gate refuses other windows and profiles', async () => {
	const h = harness()
	const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>()
	const listeners = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => void>()
	h.main.registerIpc({
		on: (channel, listener) => listeners.set(channel, listener),
		handle: (channel, listener) => handlers.set(channel, listener),
	})
	assert.deepEqual(
		[...handlers.keys()].sort(),
		[
			'signals:new-agent',
			'signals:okena-projects',
			'signals:open',
			'signals:routed',
			'signals:subscribe',
			'signals:update',
		].sort(),
	)
	assert.deepEqual([...listeners.keys()], ['signals:set-visible'])

	const update = handlers.get('signals:update')
	assert.ok(update)
	const refusedWindow = (await update({ sender: { id: 9 } }, 1, { state: 'seen' }, TOKEN)) as { error?: string }
	assert.match(refusedWindow.error ?? '', /cannot change signals/)
	const refusedToken = (await update({ sender: WINDOW }, 1, { state: 'seen' }, 'old:0')) as { error?: string }
	assert.match(refusedToken.error ?? '', /cannot change signals/)
	assert.equal(h.calls.length, 0)

	const result = await update({ sender: WINDOW }, 4, { state: 'done' }, TOKEN)
	assert.deepEqual(result, { data: { id: 1 } })
	await flush()
	assert.deepEqual(h.calls.slice(0, 2), [
		{ method: 'POST', path: '/signals/4', body: { state: 'done' } },
		{ method: 'GET', path: '/signals' },
	])
	const routed = handlers.get('signals:routed')
	assert.ok(routed)
	await routed({ sender: WINDOW }, 4, { agent: 'feat/example', how: 'sent' }, TOKEN)
	await flush()
	assert.deepEqual(h.calls.slice(-2), [
		{ method: 'POST', path: '/signals/4/routed', body: { agent: 'feat/example', how: 'sent' } },
		{ method: 'GET', path: '/signals' },
	])
	assert.deepEqual(await update({ sender: WINDOW }, -1, { state: 'done' }, TOKEN), {
		error: 'That signal does not exist.',
		status: 400,
	})

	// setVisible through IPC is gated too.
	const setVisible = listeners.get('signals:set-visible')
	setVisible?.({ sender: { id: 9 } }, true, TOKEN)
	assert.equal(h.main.isPolling(), false)
	setVisible?.({ sender: WINDOW }, true, TOKEN)
	assert.equal(h.main.isPolling(), true)
	const subscribe = handlers.get('signals:subscribe')
	const refusedState = (await subscribe?.({ sender: { id: 9 } }, TOKEN)) as SignalsBridgeState
	assert.equal(refusedState.snapshot, null)
	assert.match(refusedState.error ?? '', /cannot read Signals/)
	h.main.stop()
})

test('open allows only github.com https links and Mail message ids', async () => {
	assert.equal(signalOpenableUrl('https://github.com/acme/widgets/pull/7'), 'https://github.com/acme/widgets/pull/7')
	assert.equal(
		signalOpenableUrl('message://%3Cabc.123%40mail.example.com%3E'),
		'message://%3Cabc.123%40mail.example.com%3E',
	)
	for (const bad of [
		'http://github.com/acme/widgets',
		'https://github.com.evil.example/acme',
		'https://user:pass@github.com/acme',
		'https://github.com:8443/acme',
		'https://gist.github.com/x',
		'file:///etc/passwd',
		'message://<abc@x>',
		'message://%3Cabc%40x%3E/../x',
		'message:%3Cabc%40x%3E',
		'javascript:alert(1)',
		`https://github.com/${'a'.repeat(2050)}`,
		42,
		null,
	])
		assert.equal(signalOpenableUrl(bad), null, String(bad))

	const opened: string[] = []
	const h = harness()
	;(h.main as unknown as { options: { openExternal: (url: string) => Promise<void> } }).options.openExternal =
		async url => {
			opened.push(url)
		}
	assert.deepEqual(await h.main.open('https://github.com/acme/widgets/pull/7'), { data: true })
	assert.deepEqual(await h.main.open('https://example.com/'), {
		error: 'Only GitHub and Mail links can be opened.',
		status: 400,
	})
	assert.deepEqual(opened, ['https://github.com/acme/widgets/pull/7'])
})

test('git remotes normalize to lowercase github owner/repo', () => {
	assert.equal(githubRepoFromRemote('git@github.com:Acme/Widgets.git\n'), 'acme/widgets')
	assert.equal(githubRepoFromRemote('https://github.com/acme/widgets'), 'acme/widgets')
	assert.equal(githubRepoFromRemote('https://github.com/acme/widgets.git/'), 'acme/widgets')
	assert.equal(githubRepoFromRemote('ssh://git@github.com/acme/widgets.git'), 'acme/widgets')
	assert.equal(githubRepoFromRemote('ssh://git@ssh.github.com:443/acme/widgets.git'), 'acme/widgets')
	assert.equal(githubRepoFromRemote('git@gitlab.com:acme/widgets.git'), null)
	assert.equal(githubRepoFromRemote('/Users/someone/repo'), null)
	assert.equal(githubRepoFromRemote('https://github.com/acme'), null)
})

test('the Okena binary: env, then ~/.local/bin, then PATH', () => {
	assert.equal(
		resolveOkenaBinary({ HELM_OKENA_BIN: '/opt/okena' }, '/h', () => true),
		'/opt/okena',
	)
	assert.equal(
		resolveOkenaBinary({}, '/h', path => path === '/h/.local/bin/okena'),
		'/h/.local/bin/okena',
	)
	assert.equal(
		resolveOkenaBinary({}, '/h', () => false),
		'okena',
	)
})

function okenaState(extra: unknown[] = []) {
	return JSON.stringify({
		state_version: 1,
		projects: [
			{ id: 'default', name: 'Default', path: '/home/someone', layout: null },
			{ id: PARENT, name: 'widgets', path: '/code/widgets', layout: null, git_status: { branch: 'main' } },
			{ id: OTHER, name: 'gadgets', path: '/code/gadgets', layout: null },
			{ id: 'twin', name: 'widgets copy', path: '/code/widgets-copy', layout: null, is_closing: true },
			{
				id: 'wt-old',
				name: 'widgets (old)',
				path: '/code/widgets-wt/old',
				worktree_info: { parent_project_id: PARENT },
				git_status: { branch: 'old' },
				layout: { type: 'terminal', terminal_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
			},
			...extra,
		],
	})
}

test('okenaProjects lists parent projects with their origin repo and suggests the single match', async () => {
	const execs: string[][] = []
	const remotes: Record<string, string> = {
		'/code/widgets': 'git@github.com:Acme/widgets.git\n',
		'/code/gadgets': 'https://github.com/acme/gadgets\n',
	}
	const exec: SignalsExec = async (file, args, options) => {
		execs.push([file, ...args])
		if (file === '/fake/okena') {
			assert.deepEqual(args, ['state'])
			return { stdout: okenaState(), stderr: '' }
		}
		assert.equal(file, 'git')
		assert.equal(options.env?.GIT_DIR, undefined, 'inherited GIT_* never reaches git')
		assert.equal(options.env?.GIT_OPTIONAL_LOCKS, '0')
		const remote = remotes[args[1] ?? '']
		if (remote === undefined) throw Object.assign(new Error('not a git repository'), { code: 128 })
		return { stdout: remote, stderr: '' }
	}
	const h = harness({ exec })
	const result = await h.main.okenaProjects('acme/Widgets')
	assert.deepEqual(result, {
		data: {
			projects: [
				{ id: 'default', name: 'Default', repo: null },
				{ id: PARENT, name: 'widgets', repo: 'acme/widgets' },
				{ id: OTHER, name: 'gadgets', repo: 'acme/gadgets' },
			],
			suggested: PARENT,
		},
	})
	// No worktree child, no closing project; every git read is read-only.
	assert.ok(execs.every(call => call[0] === '/fake/okena' || call.slice(3).join(' ') === 'remote get-url origin'))
	const gitReads = execs.filter(call => call[0] === 'git').length
	assert.equal(gitReads, 3)

	// Cached for 5 minutes per path.
	const again = await h.main.okenaProjects(null)
	assert.equal(again.data?.suggested, null)
	assert.equal(execs.filter(call => call[0] === 'git').length, gitReads)

	// Two checkouts of the same repo → no suggestion.
	remotes['/code/gadgets'] = 'git@github.com:acme/widgets.git'
	h.clock.now += 6 * 60_000
	assert.equal((await h.main.okenaProjects('acme/widgets')).data?.suggested, null)

	assert.equal((await h.main.okenaProjects('not a repo')).status, 400)
})

test('okenaProjects says when Okena is missing', async () => {
	const h = harness({
		exec: async () => {
			throw Object.assign(new Error('spawn okena ENOENT'), { code: 'ENOENT' })
		},
	})
	assert.deepEqual(await h.main.okenaProjects(null), { error: 'Okena is not installed.' })
})

function newAgentRequest(overrides: Record<string, unknown> = {}) {
	return {
		signalId: 1,
		projectId: PARENT,
		branch: 'fix/widgets-7',
		agent: 'claude',
		prompt: 'Look at <external>…</external>',
		...overrides,
	}
}

/** git for a branch that exists neither locally nor on origin (ls-remote --exit-code → 2). */
function newBranchGit(args: readonly string[]) {
	if (args[2] === 'check-ref-format') return { stdout: `${args[4]}\n`, stderr: '' }
	if (args[2] === 'show-ref') throw Object.assign(new Error('exit 1'), { code: 1 })
	if (args[2] === 'ls-remote') throw Object.assign(new Error('exit 2'), { code: 2 })
	throw new Error(`unexpected git ${args.join(' ')}`)
}

test('newAgent: worktree add, then claude start with a private prompt file that is deleted afterwards', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-signals-main-'))
	try {
		const execs: string[][] = []
		let promptSeen: { content: string; mode: number; dirMode: number } | null = null
		let created = false
		const exec: SignalsExec = async (file, args) => {
			execs.push([file, ...args])
			if (file === 'git') return newBranchGit(args)
			if (args[0] === 'state')
				return {
					stdout: created
						? okenaState([
								{
									id: 'wt-new',
									name: 'widgets (fix/widgets-7)',
									path: '/code/widgets-wt/fix-widgets-7',
									worktree_info: { parent_project_id: PARENT },
									git_status: { branch: 'fix/widgets-7' },
									layout: {
										type: 'split',
										children: [
											{ type: 'terminal', terminal_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
											{ type: 'terminal', terminal_id: NEW_TERMINAL },
										],
									},
								},
							])
						: okenaState(),
					stderr: '',
				}
			if (args[0] === 'worktree') {
				assert.deepEqual(args, ['worktree', 'add', PARENT, 'fix/widgets-7', '--new-branch', '--wait'])
				created = true
				return { stdout: `wt-new\t/code/widgets-wt/fix-widgets-7\t${NEW_TERMINAL}\n`, stderr: '' }
			}
			if (args[0] === 'claude') {
				const file = args[args.indexOf('--prompt-file') + 1] ?? ''
				assert.deepEqual(args, ['claude', 'start', NEW_TERMINAL, '--trust', '--prompt-file', file, '--json'])
				assert.ok(file.startsWith(join(root, 'signals', 'prompt-')))
				promptSeen = {
					content: readFileSync(file, 'utf8'),
					mode: statSync(file).mode & 0o777,
					dirMode: statSync(join(root, 'signals')).mode & 0o777,
				}
				return {
					stdout: JSON.stringify({ terminal: NEW_TERMINAL, session_id: 'sess-1', delivery: 'typed' }),
					stderr: '',
				}
			}
			throw new Error(`unexpected exec ${file} ${args.join(' ')}`)
		}
		const h = harness({ exec, userDataDir: root })
		const result = await h.main.newAgent(newAgentRequest())
		assert.deepEqual(result, {
			data: { terminalId: NEW_TERMINAL, sessionId: 'sess-1', agentName: 'fix/widgets-7' },
		})
		assert.deepEqual(promptSeen, { content: 'Look at <external>…</external>', mode: 0o600, dirMode: 0o700 })
		assert.deepEqual(readdirSync(join(root, 'signals')), [], 'the prompt file is gone')
		assert.deepEqual(
			execs.map(call => call.slice(0, 3).join(' ')),
			[
				'/fake/okena state',
				'git -C /code/widgets',
				'git -C /code/widgets',
				'git -C /code/widgets',
				'git -C /code/widgets',
				'/fake/okena worktree add',
				'/fake/okena state',
				'/fake/okena claude start',
			],
		)
		assert.deepEqual(
			execs.filter(call => call[0] === 'git').map(call => call.slice(1)),
			[
				['-C', '/code/widgets', 'check-ref-format', '--branch', 'fix/widgets-7'],
				['-C', '/code/widgets', 'show-ref', '--verify', '--quiet', 'refs/heads/fix/widgets-7'],
				['-C', '/code/widgets', 'show-ref', '--verify', '--quiet', 'refs/remotes/origin/fix/widgets-7'],
				['-C', '/code/widgets', 'ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/fix/widgets-7'],
			],
			'a brand-new branch: absent locally and on origin, nothing is fetched or created by git',
		)
		assert.equal(h.calls.length, 0, 'routing is the renderer’s POST, not main’s')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('newAgent falls back to the worktree’s first terminal and still deletes the prompt when Claude fails', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-signals-main-'))
	try {
		let created = false
		let promptPath = ''
		const exec: SignalsExec = async (file, args) => {
			if (file === 'git') return { stdout: '', stderr: '' }
			if (args[0] === 'state')
				return {
					stdout: okenaState(
						created
							? [
									{
										id: 'wt-new',
										name: 'widgets (fix/widgets-7)',
										path: '/code/widgets-wt/fix-widgets-7',
										worktree_info: { parent_project_id: PARENT },
										git_status: { branch: 'fix/widgets-7' },
										layout: { type: 'terminal', terminal_id: NEW_TERMINAL },
									},
								]
							: [],
					),
					stderr: '',
				}
			if (args[0] === 'worktree') {
				created = true
				return { stdout: 'created\n', stderr: '' }
			}
			promptPath = args[args.indexOf('--prompt-file') + 1] ?? ''
			assert.equal(args[2], NEW_TERMINAL)
			throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'claude did not connect\u001b[0m' })
		}
		const h = harness({ exec, userDataDir: root })
		const result = await h.main.newAgent(newAgentRequest())
		assert.match(
			String((result as { error?: string }).error),
			/^Okena could not start Claude: claude did not connect \[0m\. The branch already existed/,
		)
		assert.ok(promptPath !== '')
		assert.equal(existsSync(promptPath), false)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

/** A newAgent run where git answers from `refs`/`origin`; returns every exec argv. */
async function runNewAgentWithGit(git: {
	refs: Set<string>
	origin: Set<string>
	failLsRemote?: boolean
	/** `okena claude start` fails (e.g. the trust dialog is shown without --trust). */
	failClaude?: boolean
}): Promise<{ execs: string[][]; result: unknown }> {
	const root = mkdtempSync(join(tmpdir(), 'helm-signals-main-'))
	try {
		const execs: string[][] = []
		let created = false
		const exec: SignalsExec = async (file, args) => {
			execs.push([file, ...args])
			if (file === 'git') {
				assert.equal(args[1], '/code/widgets')
				const verb = args[2]
				if (verb === 'check-ref-format') return { stdout: '', stderr: '' }
				if (verb === 'show-ref') {
					if (git.refs.has(args[5] ?? '')) return { stdout: '', stderr: '' }
					throw Object.assign(new Error('exit 1'), { code: 1 })
				}
				if (verb === 'ls-remote') {
					if (git.failLsRemote)
						throw Object.assign(new Error('exit 128'), { code: 128, stderr: 'fatal: could not read from remote' })
					if (git.origin.has(args[6] ?? '')) return { stdout: 'abc\trefs/heads/x\n', stderr: '' }
					throw Object.assign(new Error('exit 2'), { code: 2 })
				}
				if (verb === 'fetch') {
					const [, dst] = (args[5] ?? '').split(':')
					git.refs.add(dst ?? '')
					return { stdout: '', stderr: '' }
				}
				if (verb === 'branch') {
					assert.ok(git.refs.has(args[5] ?? ''), 'tracks a fetched remote ref')
					git.refs.add(`refs/heads/${args[4]}`)
					return { stdout: '', stderr: '' }
				}
				throw new Error(`unexpected git ${args.join(' ')}`)
			}
			if (args[0] === 'state')
				return {
					stdout: okenaState(
						created
							? [
									{
										id: 'wt-new',
										name: 'widgets (fix/widgets-7)',
										path: '/code/widgets-wt/fix-widgets-7',
										worktree_info: { parent_project_id: PARENT },
										git_status: { branch: 'fix/widgets-7' },
										layout: { type: 'terminal', terminal_id: NEW_TERMINAL },
									},
								]
							: [],
					),
					stderr: '',
				}
			if (args[0] === 'worktree') {
				created = true
				return { stdout: `wt-new\t/code/widgets-wt/fix-widgets-7\t${NEW_TERMINAL}\n`, stderr: '' }
			}
			if (args[0] === 'claude') {
				if (git.failClaude) throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'trust dialog is shown' })
				return { stdout: JSON.stringify({ session_id: 'sess-1' }), stderr: '' }
			}
			throw new Error(`unexpected exec ${file} ${args.join(' ')}`)
		}
		const h = harness({ exec, userDataDir: root })
		const result = await h.main.newAgent(newAgentRequest())
		return { execs, result }
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

const LOCAL_REF = 'refs/heads/fix/widgets-7'
const REMOTE_REF = 'refs/remotes/origin/fix/widgets-7'
const OK_RESULT = { data: { terminalId: NEW_TERMINAL, sessionId: 'sess-1', agentName: 'fix/widgets-7' } }
const gitArgs = (execs: string[][]) => execs.filter(call => call[0] === 'git').map(call => call.slice(3))
const worktreeArgs = (execs: string[][]) => execs.find(call => call[1] === 'worktree')?.slice(1)
const claudeArgs = (execs: string[][]) => execs.find(call => call[1] === 'claude')?.slice(1)

test('newAgent trusts the folder only for a brand-new branch, never for an existing local or origin branch', async () => {
	// A local branch may be one an earlier `n` made from a teammate's origin branch: no provenance.
	const local = await runNewAgentWithGit({ refs: new Set([LOCAL_REF, REMOTE_REF]), origin: new Set([LOCAL_REF]) })
	assert.deepEqual(local.result, OK_RESULT)
	assert.ok(!claudeArgs(local.execs)?.includes('--trust'))
	const fresh = await runNewAgentWithGit({ refs: new Set(), origin: new Set() })
	assert.ok(claudeArgs(fresh.execs)?.includes('--trust'))

	const remote = await runNewAgentWithGit({ refs: new Set(), origin: new Set([LOCAL_REF]) })
	assert.deepEqual(remote.result, OK_RESULT)
	assert.ok(!claudeArgs(remote.execs)?.includes('--trust'), 'origin code may carry someone else’s .claude hooks')

	const dialog = await runNewAgentWithGit({ refs: new Set(), origin: new Set([LOCAL_REF]), failClaude: true })
	assert.match(String((dialog.result as { error?: string }).error), /answer Claude's trust dialog in Okena/)
})

test('newAgent hands an existing local branch to Okena as is, without --new-branch', async () => {
	const { execs, result } = await runNewAgentWithGit({ refs: new Set([LOCAL_REF]), origin: new Set() })
	assert.deepEqual(result, OK_RESULT)
	assert.deepEqual(worktreeArgs(execs), ['worktree', 'add', PARENT, 'fix/widgets-7', '--wait'])
	assert.deepEqual(gitArgs(execs), [
		['check-ref-format', '--branch', 'fix/widgets-7'],
		['show-ref', '--verify', '--quiet', LOCAL_REF],
	])
})

test('newAgent makes an origin-only branch (a teammate’s PR head) a local tracking branch first', async () => {
	// Already fetched once: refs/remotes/origin/<branch> exists, no local branch.
	const fetched = await runNewAgentWithGit({ refs: new Set([REMOTE_REF]), origin: new Set([LOCAL_REF]) })
	assert.deepEqual(fetched.result, OK_RESULT)
	assert.deepEqual(gitArgs(fetched.execs), [
		['check-ref-format', '--branch', 'fix/widgets-7'],
		['show-ref', '--verify', '--quiet', LOCAL_REF],
		['show-ref', '--verify', '--quiet', REMOTE_REF],
		['fetch', '--no-tags', 'origin', `+${LOCAL_REF}:${REMOTE_REF}`],
		['branch', '--track', 'fix/widgets-7', REMOTE_REF],
	])
	assert.deepEqual(worktreeArgs(fetched.execs), ['worktree', 'add', PARENT, 'fix/widgets-7', '--wait'])

	// Never fetched here: origin itself is asked before anything is created.
	const fresh = await runNewAgentWithGit({ refs: new Set(), origin: new Set([LOCAL_REF]) })
	assert.deepEqual(fresh.result, OK_RESULT)
	assert.deepEqual(gitArgs(fresh.execs), [
		['check-ref-format', '--branch', 'fix/widgets-7'],
		['show-ref', '--verify', '--quiet', LOCAL_REF],
		['show-ref', '--verify', '--quiet', REMOTE_REF],
		['ls-remote', '--exit-code', '--heads', 'origin', LOCAL_REF],
		['fetch', '--no-tags', 'origin', `+${LOCAL_REF}:${REMOTE_REF}`],
		['branch', '--track', 'fix/widgets-7', REMOTE_REF],
	])
	assert.deepEqual(worktreeArgs(fresh.execs), ['worktree', 'add', PARENT, 'fix/widgets-7', '--wait'])
	assert.ok(
		fresh.execs.every(call => !call.includes('--new-branch')),
		'never a same-named branch from main',
	)
})

test('newAgent passes --new-branch only when the branch is on neither side, and stops when origin cannot be asked', async () => {
	const fresh = await runNewAgentWithGit({ refs: new Set(), origin: new Set() })
	assert.deepEqual(fresh.result, OK_RESULT)
	assert.deepEqual(worktreeArgs(fresh.execs), ['worktree', 'add', PARENT, 'fix/widgets-7', '--new-branch', '--wait'])
	assert.ok(fresh.execs.every(call => call[3] !== 'fetch' && call[3] !== 'branch'))

	const offline = await runNewAgentWithGit({ refs: new Set(), origin: new Set(), failLsRemote: true })
	assert.deepEqual(offline.result, {
		error: 'Could not check the branch on origin: fatal: could not read from remote',
	})
	assert.equal(worktreeArgs(offline.execs), undefined, 'no Okena write when origin is unknown')
})

test('newAgent refuses bad branches, unknown projects and other agents before any Okena write', async () => {
	const execs: string[][] = []
	const exec: SignalsExec = async (file, args) => {
		execs.push([file, ...args])
		if (file === 'git') throw Object.assign(new Error('exit 1'), { code: 1, stderr: 'fatal: not a valid branch name' })
		if (args[0] === 'state') return { stdout: okenaState(), stderr: '' }
		throw new Error('no Okena write expected')
	}
	const h = harness({ exec })
	assert.deepEqual(await h.main.newAgent(newAgentRequest({ branch: 'fix..bad' })), {
		error: 'That is not a valid branch name.',
		status: 400,
	})
	for (const branch of ['', '--force', 'has space', 'x'.repeat(256)])
		assert.equal((await h.main.newAgent(newAgentRequest({ branch }))).status, 400, branch)
	assert.equal((await h.main.newAgent(newAgentRequest({ agent: 'codex' }))).status, 400)
	assert.equal((await h.main.newAgent(newAgentRequest({ prompt: '  ' }))).status, 400)
	assert.equal((await h.main.newAgent(newAgentRequest({ prompt: 'x'.repeat(16_385) }))).status, 400)
	assert.deepEqual(await h.main.newAgent(newAgentRequest({ projectId: 'wt-old' })), {
		error: 'That Okena project is no longer open.',
		status: 404,
	})
	assert.ok(execs.every(call => call[1] === 'state' || call[0] === 'git'))
})

test('newAgent is single-flight', async () => {
	let release: () => void = () => undefined
	const gate = new Promise<void>(resolve => {
		release = resolve
	})
	const exec: SignalsExec = async () => {
		await gate
		throw Object.assign(new Error('spawn okena ENOENT'), { code: 'ENOENT' })
	}
	const h = harness({ exec })
	const first = h.main.newAgent(newAgentRequest())
	assert.deepEqual(await h.main.newAgent(newAgentRequest()), {
		error: 'A new agent is already starting.',
		status: 409,
	})
	release()
	assert.deepEqual(await first, { error: 'Okena is not installed.' })
	// Released afterwards.
	const third = await h.main.newAgent(newAgentRequest())
	assert.deepEqual(third, { error: 'Okena is not installed.' })
})

test('a read-only (side-by-side) run never writes: no source poll, no thread changes, no new agents', async () => {
	const h = harness({
		readOnly: true,
		exec: async () => {
			throw new Error('no exec expected')
		},
	})
	h.main.setVisible(WINDOW, true)
	await flush()
	assert.deepEqual(
		h.calls.map(call => `${call.method} ${call.path}`),
		['GET /signals'],
	)
	assert.deepEqual(await h.main.update(1, { state: 'seen' }), { error: 'read-only run', status: 403 })
	assert.deepEqual(await h.main.routed(1, { agent: 'a', how: 'sent' }), { error: 'read-only run', status: 403 })
	assert.deepEqual(await h.main.newAgent(newAgentRequest()), { error: 'read-only run', status: 403 })
	assert.ok(h.calls.every(call => call.method === 'GET'))
	h.main.stop()
})

test('main.ts and preload wire the Signals channels through the gated main-window path', () => {
	const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')
	const preload = readFileSync(new URL('../app/src/preload.ts', import.meta.url), 'utf8')
	assert.match(main, /signalsMain\.registerIpc\(ipcMain\)/)
	const block = main.slice(main.indexOf('new SignalsMain({'), main.indexOf('readOnly: signalsReadOnly'))
	assert.match(
		block,
		/acceptsIpc: \(sender, profileToken\) => sessionIpcGate\.allows\(profileToken\) && sender === mainWindow\?\.webContents,/,
	)
	assert.match(
		block,
		/sendToLiveRenderer\(mainWindow\?\.webContents, SIGNALS_IPC\.snapshot, state, sessionProfileToken\(\)\)/,
	)
	assert.match(main, /readOnly: signalsReadOnly/)
	assert.match(main, /signalsMain\.stop\(\)/)
	assert.match(preload, /const SIGNALS_CHANNELS: typeof SIGNALS_IPC = \{/)
	assert.match(preload, /\} satisfies SignalsApi,/)
})
