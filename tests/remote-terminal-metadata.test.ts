import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { remoteTerminalMetadataSchema } from '../src/remote/protocol.js'
import {
	TerminalMetadataObserver,
	createTerminalMetadataReader,
	remoteTerminalEnvironment,
} from '../src/remote/terminal-metadata.js'

function cleanGitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (!/^GIT_/i.test(key) && value !== undefined) env[key] = value
	}
	return env
}

function fixture() {
	const home = realpathSync(mkdtempSync('/tmp/hr-meta-'))
	const branchRepo = join(home, 'jvs-repository')
	mkdirSync(branchRepo)
	execFileSync('git', ['init', '-q', '-b', 'docs/mobile-phase-0'], { cwd: branchRepo, env: cleanGitEnvironment() })
	const base = join(home, '.config', 'okena')
	const write = (file: string, value: unknown) => {
		mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
		writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
	}
	const project = (id = 'pane-a') => ({
		id: 'project-a',
		name: 'Client care',
		path: '/private/repository',
		layout: { type: 'terminal', terminal_id: id },
		terminal_names: { 'pane-a': 'Email export' },
	})
	const workspace = (
		profile: string,
		projects: unknown[],
		folders: unknown[] = [{ name: 'Work', project_ids: ['project-a'] }],
	) =>
		write(join(base, 'profiles', profile, 'workspace.json'), {
			projects,
			folders,
		})
	write(join(base, 'profiles.json'), { last_used: 'wrong', profiles: [{ id: 'right' }, { id: 'wrong' }] })
	workspace('right', [project()])
	workspace('wrong', [project('different-pane')])
	return {
		home,
		base,
		branchRepo,
		write,
		project,
		workspace,
		read: createTerminalMetadataReader({ home, platform: 'linux', env: { OKENA_TERMINAL_ID: 'pane-a' } }),
		cleanup: () => rmSync(home, { recursive: true, force: true }),
	}
}

test('Okena labels match the exact layout terminal across profiles, not cwd, names or last_used', async () => {
	const f = fixture()
	try {
		const labels = await f.read()
		assert.deepEqual(labels, {
			source: 'okena',
			name: 'Email export',
			project: 'Client care',
			worktree: null,
			branch: null,
			group: 'Work',
		})
		assert.equal(JSON.stringify(labels).includes('/private/'), false)
		f.workspace('right', [{ ...f.project(), terminal_names: { 'pane-a': 'Renamed pane' } }])
		assert.equal((await f.read())?.name, 'Renamed pane')
		f.workspace('wrong', [f.project()])
		assert.equal(await f.read(), null, 'duplicate profile identities must remain ambiguous')
	} finally {
		f.cleanup()
	}
})

test('nested Okena worktree panes inherit their exact parent project folder', async () => {
	const f = fixture()
	try {
		f.workspace('right', [
			{ ...f.project(), layout: null },
			{
				...f.project(),
				id: 'worktree-a',
				name: 'Export fix',
				worktree_info: { parent_project_id: 'project-a' },
				layout: { type: 'tabs', children: [{ type: 'split', children: [f.project().layout] }] },
			},
		])
		assert.deepEqual(await f.read(), {
			source: 'okena',
			name: 'Email export',
			project: 'Client care',
			worktree: 'Export fix',
			branch: null,
			group: 'Work',
		})
	} finally {
		f.cleanup()
	}
})

test('Okena worktree metadata keeps parent, worktree and actual branch distinct when the terminal has no custom name', async () => {
	const f = fixture()
	try {
		f.workspace(
			'right',
			[
				{ ...f.project(), id: 'jvs', name: 'JVS', layout: null, terminal_names: {} },
				{
					...f.project(),
					id: 'mobile',
					name: 'feat/mobile',
					path: f.branchRepo,
					terminal_names: {},
					worktree_info: { parent_project_id: 'jvs' },
					layout: { type: 'terminal', terminal_id: 'pane-a' },
				},
			],
			[{ name: 'Contember', project_ids: ['jvs'] }],
		)
		assert.deepEqual(await f.read(), {
			source: 'okena',
			name: null,
			project: 'JVS',
			worktree: 'feat/mobile',
			branch: 'docs/mobile-phase-0',
			group: 'Contember',
		})
	} finally {
		f.cleanup()
	}
})

test('production Git branch metadata ignores inherited repository and trace settings', async () => {
	const f = fixture()
	const wrongRepo = join(f.home, 'outer-shell')
	mkdirSync(wrongRepo)
	execFileSync('git', ['init', '-q', '-b', 'outer-shell'], { cwd: wrongRepo, env: cleanGitEnvironment() })
	const overridden = {
		GIT_DIR: join(wrongRepo, '.git'),
		GIT_WORK_TREE: wrongRepo,
		GIT_INDEX_FILE: join(wrongRepo, 'wrong-index'),
		GIT_TRACE: join(f.home, 'git-trace.log'),
		GIT_TRACE2_EVENT: join(f.home, 'git-trace2.json'),
		GIT_OPTIONAL_LOCKS: '1',
	}
	const previous = new Map(Object.keys(overridden).map(key => [key, process.env[key]]))
	try {
		Object.assign(process.env, overridden)
		f.workspace(
			'right',
			[
				{ ...f.project(), id: 'jvs', name: 'JVS', layout: null, terminal_names: {} },
				{
					...f.project(),
					id: 'mobile',
					name: 'feat/mobile',
					path: f.branchRepo,
					terminal_names: {},
					worktree_info: { parent_project_id: 'jvs' },
					layout: { type: 'terminal', terminal_id: 'pane-a' },
				},
			],
			[{ name: 'Contember', project_ids: ['jvs'] }],
		)
		assert.deepEqual(await f.read(), {
			source: 'okena',
			name: null,
			project: 'JVS',
			worktree: 'feat/mobile',
			branch: 'docs/mobile-phase-0',
			group: 'Contember',
		})
		assert.equal(existsSync(overridden.GIT_TRACE), false)
		assert.equal(existsSync(overridden.GIT_TRACE2_EVENT), false)
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		f.cleanup()
	}
})

test('legacy metadata remains wire-compatible while new nullable fields are accepted', () => {
	assert.equal(
		remoteTerminalMetadataSchema.safeParse({ source: 'okena', name: null, project: 'JVS', group: null }).success,
		true,
	)
	assert.equal(
		remoteTerminalMetadataSchema.safeParse({
			source: 'okena',
			name: null,
			project: 'JVS',
			worktree: 'feat/mobile',
			branch: 'docs/mobile-phase-0',
			group: 'Contember',
		}).success,
		true,
	)
})

test('stale names and cached remote layouts do not identify a local Okena pane', async () => {
	const f = fixture()
	try {
		for (const change of [
			{ layout: null },
			{ connection_id: 'foreign-host' },
			{ layout: { type: 'terminal', terminal_id: 'pane-a', detached: true } },
		]) {
			f.workspace('right', [{ ...f.project(), ...change }])
			assert.equal(await f.read(), null)
		}
	} finally {
		f.cleanup()
	}
})

test('metadata refuses traversal, links and oversized files', async () => {
	const f = fixture()
	try {
		const file = join(f.base, 'profiles', 'right', 'workspace.json')
		const original = join(f.home, 'original.json')
		f.write(original, { projects: [f.project()] })
		for (const link of [symlinkSync, linkSync]) {
			rmSync(file)
			link(original, file)
			await assert.rejects(f.read())
		}
		rmSync(file)
		writeFileSync(file, ' '.repeat(2 * 1024 * 1024 + 1), { mode: 0o600 })
		await assert.rejects(f.read())
		f.write(join(f.base, 'profiles.json'), { profiles: [{ id: '../outside' }] })
		await assert.rejects(f.read())
	} finally {
		f.cleanup()
	}
})

test('metadata labels are bounded, Unicode-safe and contain no control or direction overrides', async () => {
	const f = fixture()
	try {
		f.workspace('right', [
			{ ...f.project(), name: 'Project\u202esecret\nname', terminal_names: { 'pane-a': `${'a'.repeat(159)}😀extra` } },
		])
		const labels = await f.read()
		assert.equal(labels?.name, 'a'.repeat(159))
		assert.equal(labels?.project, 'Project secret name')
		assert.equal(remoteTerminalMetadataSchema.safeParse({ ...labels, socket: '/private/socket' }).success, false)
	} finally {
		f.cleanup()
	}
})

test('Helm launch uses its captured registry and session, never an inherited Okena or Helm identity', async () => {
	const f = fixture()
	try {
		const registryFile = join(f.home, 'helm', 'sessions.json')
		f.write(registryFile, {
			abc12345: { customName: 'Ship the exporter', lastTitle: 'old title', groupId: 'group-a' },
			_tabGroups: { 'group-a': { name: 'Client care' } },
		})
		const inherited = {
			OKENA_TERMINAL_ID: 'pane-a',
			HELM_REMOTE_TERMINAL_ID: 'old',
			HELM_REMOTE_TERMINAL_REGISTRY: '/old/sessions.json',
			HELM_TERMINAL_AGENT_STATUS: '1',
		}
		const env = remoteTerminalEnvironment(inherited, { sessionId: 'abc12345', registryFile })
		assert.equal(env.OKENA_TERMINAL_ID, undefined)
		assert.equal(inherited.OKENA_TERMINAL_ID, 'pane-a', 'do not mutate caller environment')
		assert.equal(
			await createTerminalMetadataReader({ env: { ...env, OKENA_TERMINAL_ID: 'nested-okena-pane' } })(),
			null,
		)
		const read = createTerminalMetadataReader({ env })
		assert.deepEqual(await read(), {
			source: 'helm',
			name: 'Ship the exporter',
			project: null,
			worktree: null,
			branch: null,
			group: 'Client care',
		})
		f.write(registryFile, { abc12345: { lastTitle: 'live title', groupId: 'missing' } })
		assert.deepEqual(await read(), {
			source: 'helm',
			name: 'live title',
			project: null,
			worktree: null,
			branch: null,
			group: null,
		})
		assert.equal(await createTerminalMetadataReader({ env: { ...env, HELM_REMOTE_TERMINAL_ID: 'missing' } })(), null)
		assert.equal(await createTerminalMetadataReader({ env: remoteTerminalEnvironment(inherited, null) })(), null)
		assert.equal(
			await createTerminalMetadataReader({
				home: f.home,
				platform: 'linux',
				env: { OKENA_TERMINAL_ID: 'pane-a', HELM_TERMINAL_AGENT_STATUS: '1' },
			})(),
			null,
		)
	} finally {
		f.cleanup()
	}
})

test('observer coalesces refreshes, clears unavailable labels and fences late lifecycle completion', async () => {
	let calls = 0
	let changes = 0
	let now = 0
	let resolve: (value: ReturnType<typeof remoteTerminalMetadataSchema.parse> | null) => void = () => {}
	const observer = new TerminalMetadataObserver(
		() => {
			calls++
			return new Promise(done => {
				resolve = done
			})
		},
		() => {
			changes++
		},
		() => now,
	)
	observer.refresh()
	observer.refresh()
	assert.equal(calls, 1)
	resolve({ source: 'okena', name: 'First', project: null, worktree: null, branch: null, group: null })
	await setImmediate()
	assert.equal(changes, 1)
	observer.refresh()
	assert.equal(calls, 1)
	now = 10000
	observer.refresh()
	resolve(null)
	await setImmediate()
	assert.equal(observer.value, null)
	assert.equal(changes, 2)
	now = 20000
	observer.refresh()
	observer.stop()
	resolve({ source: 'okena', name: 'Late', project: null, worktree: null, branch: null, group: null })
	await setImmediate()
	assert.equal(observer.value, null)
	assert.equal(changes, 2)
	observer.refresh()
	assert.equal(calls, 3)
})
