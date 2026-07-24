import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
	LOCAL_CONTROL_TOKEN_REDACTION,
	loadOrCreateLocalControlToken,
	readLocalControlToken,
	redactLocalControlToken,
} from '../src/auth/local-control.js'
import {
	RESIDENT_LEASE_TTL_MS,
	ResidentLeaseManager,
	createScopedCapability,
	hashScopedCapability,
	verifyScopedCapability,
} from '../src/auth/scoped-capability.js'
import { toDashboardSafeConfig } from '../src/config-document.js'
import { configSchema, isLoopbackHost } from '../src/config.js'

function config(overrides: Record<string, unknown> = {}) {
	return {
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'project', apiToken: 'secret' },
		projects: [{ slug: 'project', repoPath: '/repo' }],
		...overrides,
	}
}

test('scheduled-run rollout defaults off and only enables on loopback', () => {
	const defaults = configSchema.parse(config())
	assert.deepEqual(defaults.scheduledRuns, { enabled: false, systemTargetsEnabled: false })
	assert.equal(toDashboardSafeConfig(defaults).scheduledRuns.enabled, false)

	for (const host of ['localhost', '127.0.0.1', '127.99.3.4', '::1', '[::1]']) assert.equal(isLoopbackHost(host), true)
	for (const host of ['0.0.0.0', '192.168.1.2', 'example.test', '::']) assert.equal(isLoopbackHost(host), false)

	assert.throws(
		() => configSchema.parse(config({ server: { host: '0.0.0.0' }, scheduledRuns: { enabled: true } })),
		/Scheduled runs require server.host to be loopback/,
	)
	assert.equal(
		configSchema.parse(config({ server: { host: '127.0.0.1' }, scheduledRuns: { enabled: true } })).scheduledRuns
			.enabled,
		true,
	)
})

test('local control token is atomically private and redacted', async () => {
	const root = await mkdtemp(join(tmpdir(), 'helm-scheduled-auth-'))
	const tokenPath = join(root, 'private', 'control-token')
	const token = await loadOrCreateLocalControlToken(tokenPath)
	assert.match(token, /^[A-Za-z0-9_-]{43}$/)
	assert.equal(await loadOrCreateLocalControlToken(tokenPath), token)
	assert.equal(await readLocalControlToken(tokenPath), token)
	const parentStat = await lstat(join(root, 'private'))
	const tokenStat = await lstat(tokenPath)
	assert.equal(parentStat.mode & 0o777, 0o700)
	assert.equal(tokenStat.mode & 0o777, 0o600)
	assert.equal(redactLocalControlToken(`Bearer ${token}`, token), `Bearer ${LOCAL_CONTROL_TOKEN_REDACTION}`)

	await chmod(tokenPath, 0o644)
	await assert.rejects(() => readLocalControlToken(tokenPath), /private regular file/)
})

test('local control token refuses a symlink', async () => {
	const root = await mkdtemp(join(tmpdir(), 'helm-scheduled-auth-'))
	const target = join(root, 'target')
	const tokenPath = join(root, 'control-token')
	await writeFile(target, 'x'.repeat(43), { mode: 0o600 })
	await symlink(target, tokenPath)
	await assert.rejects(() => loadOrCreateLocalControlToken(tokenPath))
})

test('local control token rejects a symlinked parent before changing target permissions', async () => {
	const root = await mkdtemp(join(tmpdir(), 'helm-scheduled-auth-'))
	const target = join(root, 'target')
	const linkedParent = join(root, 'private')
	await mkdir(target, { mode: 0o755 })
	await symlink(target, linkedParent)
	await assert.rejects(() => loadOrCreateLocalControlToken(join(linkedParent, 'control-token')), /real directory/)
	assert.equal((await lstat(target)).mode & 0o777, 0o755)
})

test('scoped capabilities hash and verify without cross-capability access', () => {
	const first = createScopedCapability()
	const second = createScopedCapability()
	const firstHash = hashScopedCapability(first)
	assert.match(firstHash, /^[a-f0-9]{64}$/)
	assert.equal(verifyScopedCapability(first, firstHash), true)
	assert.equal(verifyScopedCapability(second, firstHash), false)
	assert.equal(verifyScopedCapability(first, 'not-a-hash'), false)
})

test('resident lease is single-holder, renewable, revocable, and expires', () => {
	let now = 1_000
	const leases = new ResidentLeaseManager(RESIDENT_LEASE_TTL_MS, () => now)
	const first = leases.issue()
	assert.equal(leases.isActive(), true)
	const second = leases.issue()
	assert.equal(leases.heartbeat(first.capability), null)
	assert.ok(leases.heartbeat(second.capability))
	assert.equal(leases.revoke(first.capability), false)
	assert.equal(leases.revoke(second.capability), true)
	assert.equal(leases.isActive(), false)

	const expiring = leases.issue()
	now += RESIDENT_LEASE_TTL_MS
	assert.equal(leases.heartbeat(expiring.capability), null)
	assert.equal(leases.isActive(), false)
})
