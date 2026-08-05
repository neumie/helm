import assert from 'node:assert/strict'
import { chmodSync, linkSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildConfigDocument } from '../src/config-document.js'
import { configSchema, loadConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { validateProfileKnowledgeConfiguration } from '../src/knowledge/bindings.js'
import { ProfileStore } from '../src/profiles/store.js'

function rawConfig(root: string) {
	return {
		provider: {
			type: 'contember',
			apiBaseUrl: 'https://example.test',
			projectSlug: 'test',
			apiToken: 'task-provider-token',
		},
		projects: [{ slug: 'sample', repoPath: root, baseBranch: 'main' }],
		knowledge: {
			providers: [
				{
					id: 'local-hold',
					type: 'hold',
					socketPath: join(root, 'hold.sock'),
					capabilityFile: join(root, 'hold.capability'),
				},
			],
		},
	}
}

test('knowledge provider config is explicit, unique, bounded, and renderer-redacted', () => {
	const root = '/private/example/helm'
	const parsed = configSchema.parse(rawConfig(root))
	assert.equal(parsed.knowledge?.providers[0]?.timeouts.briefMs, 15_000)
	const duplicate = rawConfig(root)
	duplicate.knowledge.providers.push({ ...duplicate.knowledge.providers[0] })
	assert.equal(configSchema.safeParse(duplicate).success, false)
	const relative = rawConfig(root)
	relative.knowledge.providers[0].socketPath = 'hold.sock'
	assert.equal(configSchema.safeParse(relative).success, false)

	const document = buildConfigDocument(parsed, parsed)
	const serialized = JSON.stringify(document)
	assert.doesNotMatch(serialized, /hold\.sock/)
	assert.doesNotMatch(serialized, /hold\.capability/)
	assert.doesNotMatch(serialized, /task-provider-token/)
})

test('config and SQLite state are hardened to owner-only files', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-private-state-'))
	try {
		const configPath = join(root, 'helm.config.json')
		writeFileSync(configPath, JSON.stringify(rawConfig(root)), { mode: 0o644 })
		loadConfig(configPath)
		assert.equal(statSync(configPath).mode & 0o777, 0o600)

		const dbPath = join(root, 'helm.db')
		const db = new DB(dbPath)
		try {
			for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
				assert.equal(statSync(path).mode & 0o777, 0o600)
			}
		} finally {
			db.close()
		}

		const linked = join(root, 'linked-config.json')
		linkSync(configPath, linked)
		assert.throws(() => loadConfig(configPath), /single-link regular file/)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('profile bindings must resolve configured providers and projects', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-knowledge-binding-'))
	try {
		const config = configSchema.parse(rawConfig(root))
		const profiles = new ProfileStore(root, ['sample'])
		profiles.update('work', {
			knowledgeBindings: [
				{
					projectSlug: 'sample',
					providerId: 'missing-provider',
					providerProjectId: 'provider-project',
					characterBudget: 20_000,
					allowSharedProject: false,
				},
			],
		})
		assert.throws(
			() => validateProfileKnowledgeConfiguration(config, profiles.getState()),
			/unknown knowledge provider/,
		)
		profiles.update('work', {
			knowledgeBindings: [
				{
					projectSlug: 'sample',
					providerId: 'local-hold',
					providerProjectId: 'provider-project',
					characterBudget: 20_000,
					allowSharedProject: false,
				},
			],
		})
		assert.doesNotThrow(() => validateProfileKnowledgeConfiguration(config, profiles.getState()))
		chmodSync(profiles.statePath, 0o600)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
