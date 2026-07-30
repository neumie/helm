import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import integrationModule from '../app/src/pi-agent-status-integration.ts'

const { PiAgentStatusIntegration, PI_AGENT_STATUS_EXTENSION_SOURCE } = integrationModule

async function fixture() {
	const home = await mkdtemp(join(tmpdir(), 'helm-pi-status-'))
	await mkdir(join(home, '.pi', 'agent'), { recursive: true })
	return { home, integration: new PiAgentStatusIntegration({ home, env: {} }) }
}

test('managed Pi integration installs atomically with private mode and is idempotent', async () => {
	const { integration } = await fixture()
	assert.equal((await integration.status()).status, 'not-installed')
	const installed = await integration.install()
	assert.equal(installed.status, 'installed')
	assert.equal(await readFile(installed.path, 'utf8'), PI_AGENT_STATUS_EXTENSION_SOURCE)
	assert.equal((await lstat(installed.path)).mode & 0o777, 0o600)
	assert.equal((await integration.install()).status, 'installed')
	await chmod(installed.path, 0o644)
	assert.equal((await integration.status()).status, 'outdated')
	assert.equal((await integration.install()).status, 'installed')
	assert.equal((await lstat(installed.path)).mode & 0o777, 0o600)
})

test('standalone Pi package is detected but never modified by Helm', async () => {
	const { home, integration } = await fixture()
	await writeFile(
		join(home, '.pi', 'agent', 'settings.json'),
		JSON.stringify({ packages: ['/Users/example/code/pi-agent-status'] }),
	)
	const external = await integration.status()
	assert.equal(external.status, 'external')
	assert.match(external.message, /managed by a Pi package/)
	assert.equal((await integration.install()).status, 'external')
	assert.equal((await integration.remove()).status, 'external')
	await assert.rejects(() => lstat(external.path), { code: 'ENOENT' })
})

test('managed Pi integration updates only its own marked file', async () => {
	const { integration } = await fixture()
	const path = (await integration.status()).path
	await mkdir(join(path, '..'), { recursive: true })
	await writeFile(path, '// HELM_MANAGED_PI_AGENT_STATUS_V1\nold\n')
	assert.equal((await integration.status()).status, 'outdated')
	assert.equal((await integration.install()).status, 'installed')
})

test('unmanaged and symlink conflicts are preserved', async () => {
	const unmanaged = await fixture()
	const path = (await unmanaged.integration.status()).path
	await mkdir(join(path, '..'), { recursive: true })
	await writeFile(path, 'export default () => {}\n')
	assert.equal((await unmanaged.integration.status()).status, 'conflict')
	await assert.rejects(() => unmanaged.integration.install(), /unmanaged Pi extension/)
	assert.equal(await readFile(path, 'utf8'), 'export default () => {}\n')

	const linked = await fixture()
	const linkedPath = (await linked.integration.status()).path
	await mkdir(join(linkedPath, '..'), { recursive: true })
	const target = join(linked.home, 'target.ts')
	await writeFile(target, 'target')
	await symlink(target, linkedPath)
	assert.equal((await linked.integration.status()).status, 'conflict')
})

test('remove deletes only a Helm-managed integration', async () => {
	const { integration } = await fixture()
	await integration.install()
	assert.equal((await integration.remove()).status, 'not-installed')
	assert.equal((await integration.remove()).status, 'not-installed')
})

test('missing or unsafe Pi directories remain unavailable', async () => {
	const home = await mkdtemp(join(tmpdir(), 'helm-pi-status-missing-'))
	const missing = new PiAgentStatusIntegration({ home, env: {} })
	assert.equal((await missing.status()).status, 'unavailable')

	await mkdir(join(home, '.pi'), { recursive: true })
	await writeFile(join(home, 'agent-target'), 'not a directory')
	await symlink(join(home, 'agent-target'), join(home, '.pi', 'agent'))
	assert.equal((await missing.status()).status, 'unavailable')
})

test('embedded reporter is Helm-gated and never serializes prompts, args, paths, or results', () => {
	assert.match(PI_AGENT_STATUS_EXTENSION_SOURCE, /HELM_TERMINAL_AGENT_STATUS/)
	assert.match(PI_AGENT_STATUS_EXTENSION_SOURCE, /agent_settled/)
	assert.match(PI_AGENT_STATUS_EXTENSION_SOURCE, /tool_execution_start/)
	assert.match(PI_AGENT_STATUS_EXTENSION_SOURCE, /ask_user_question/)
	assert.doesNotMatch(PI_AGENT_STATUS_EXTENSION_SOURCE, /event\.args|event\.input|event\.result|event\.prompt/)
})

test('embedded Pi reporter maps lifecycle, tools, questions, and settlement to structured OSC', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'helm-pi-reporter-'))
	const file = join(directory, 'reporter.mjs')
	await writeFile(file, PI_AGENT_STATUS_EXTENSION_SOURCE)
	const previousFlag = process.env.HELM_TERMINAL_AGENT_STATUS
	const originalWrite = process.stdout.write
	const output: string[] = []
	process.env.HELM_TERMINAL_AGENT_STATUS = '1'
	process.stdout.write = ((chunk: string | Uint8Array) => {
		output.push(String(chunk))
		return true
	}) as typeof process.stdout.write
	try {
		const extension = await import(`${pathToFileURL(file).href}?test=${Date.now()}`)
		const handlers = new Map<string, (...args: unknown[]) => unknown>()
		const bus = new Map<string, (event: unknown) => unknown>()
		const pi = {
			on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
			events: { on: (name: string, handler: (event: unknown) => unknown) => bus.set(name, handler) },
		}
		extension.default(pi)
		const context = { mode: 'tui', isIdle: () => true }
		await handlers.get('session_start')?.({}, context)
		await handlers.get('agent_start')?.({}, context)
		await handlers.get('tool_execution_start')?.({ toolCallId: 'q1', toolName: 'ask_user_question' }, context)
		await handlers.get('tool_execution_end')?.({ toolCallId: 'q1', toolName: 'ask_user_question' }, context)
		await handlers.get('agent_settled')?.({}, context)
		await handlers.get('session_shutdown')?.({}, context)
		const tuiReportCount = output.length
		const jsonContext = { mode: 'json', isIdle: () => true }
		await handlers.get('session_start')?.({}, jsonContext)
		await handlers.get('agent_start')?.({}, jsonContext)
		await handlers.get('tool_execution_start')?.({ toolCallId: 'hidden', toolName: 'bash' }, jsonContext)
		await handlers.get('agent_settled')?.({}, jsonContext)
		await handlers.get('session_shutdown')?.({}, jsonContext)
		assert.equal(output.length, tuiReportCount)
	} finally {
		process.stdout.write = originalWrite
		if (previousFlag === undefined) process.env.HELM_TERMINAL_AGENT_STATUS = undefined
		else process.env.HELM_TERMINAL_AGENT_STATUS = previousFlag
	}
	const reports = output.map(frame => {
		const payload = frame.slice('\u001b]777;helm-agent-state;'.length, -1)
		return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { state: string; phase?: { kind: string } }
	})
	assert.deepEqual(
		reports.map(report => [report.state, report.phase?.kind ?? null]),
		[
			['idle', null],
			['working', 'thinking'],
			['blocked', 'waiting'],
			['working', 'thinking'],
			['idle', null],
			['absent', null],
		],
	)
})
