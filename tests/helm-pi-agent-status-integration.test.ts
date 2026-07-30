import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import integrationModule from '../app/src/pi-agent-status-integration.ts'

const { PiAgentStatusIntegration } = integrationModule

async function fixture() {
	const home = await mkdtemp(join(tmpdir(), 'helm-pi-status-'))
	await mkdir(join(home, '.pi', 'agent'), { recursive: true })
	return { home, integration: new PiAgentStatusIntegration({ home, env: {} }) }
}

async function configurePackage(home: string, packageEntry: string): Promise<void> {
	await writeFile(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: [packageEntry] }))
}

test('standalone Pi package is detected without exposing mutation methods', async () => {
	for (const packageEntry of [
		'/Users/example/code/pi-agent-status',
		'git:github.com/neumie/pi-agent-status',
		'npm:@neumie/pi-agent-status',
	]) {
		const { home, integration } = await fixture()
		await configurePackage(home, packageEntry)
		const status = await integration.status()
		assert.equal(status.status, 'external')
		assert.match(status.message, /managed by the pi-agent-status package/)
		assert.equal('install' in integration, false)
		assert.equal('remove' in integration, false)
	}
})

test('symlinked Pi settings can identify the managed package', async () => {
	const { home, integration } = await fixture()
	const target = join(home, 'settings-source.json')
	await writeFile(target, JSON.stringify({ packages: ['/Users/example/code/pi-agent-status'] }))
	await symlink(target, join(home, '.pi', 'agent', 'settings.json'))
	assert.equal((await integration.status()).status, 'external')
})

test('missing, malformed, or oversized package settings stay not configured', async () => {
	const missing = await fixture()
	assert.equal((await missing.integration.status()).status, 'not-installed')

	const malformed = await fixture()
	await writeFile(join(malformed.home, '.pi', 'agent', 'settings.json'), '{')
	assert.equal((await malformed.integration.status()).status, 'not-installed')

	const oversized = await fixture()
	await writeFile(join(oversized.home, '.pi', 'agent', 'settings.json'), ' '.repeat(512 * 1024 + 1))
	assert.equal((await oversized.integration.status()).status, 'not-installed')
})

test('legacy direct extensions are reported as conflicts and never modified', async () => {
	const direct = await fixture()
	const path = join(direct.home, '.pi', 'agent', 'extensions', 'helm-agent-status.ts')
	await mkdir(join(path, '..'), { recursive: true })
	await writeFile(path, 'export default () => {}\n')
	await configurePackage(direct.home, '/Users/example/code/pi-agent-status')
	const status = await direct.integration.status()
	assert.equal(status.status, 'conflict')
	assert.match(status.message, /legacy direct Pi status extension/)
	assert.equal(await readFile(path, 'utf8'), 'export default () => {}\n')

	const linked = await fixture()
	const linkedPath = join(linked.home, '.pi', 'agent', 'extensions', 'helm-agent-status.ts')
	await mkdir(join(linkedPath, '..'), { recursive: true })
	const target = join(linked.home, 'target.ts')
	await writeFile(target, 'target')
	await symlink(target, linkedPath)
	assert.equal((await linked.integration.status()).status, 'conflict')
})

test('missing or unsafe Pi agent directories remain unavailable', async () => {
	const home = await mkdtemp(join(tmpdir(), 'helm-pi-status-missing-'))
	const missing = new PiAgentStatusIntegration({ home, env: {} })
	assert.equal((await missing.status()).status, 'unavailable')

	await mkdir(join(home, '.pi'), { recursive: true })
	await writeFile(join(home, 'agent-target'), 'not a directory')
	await symlink(join(home, 'agent-target'), join(home, '.pi', 'agent'))
	assert.equal((await missing.status()).status, 'unavailable')
})
