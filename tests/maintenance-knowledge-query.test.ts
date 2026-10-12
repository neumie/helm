import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ItemCommands } from '../src/items/commands.js'
import { KnowledgeIntegration } from '../src/knowledge/integration.js'
import { KnowledgeProviderRegistry } from '../src/knowledge/provider.js'
import type { KnowledgeProvider } from '../src/knowledge/provider.js'

const cases = [
	{ name: 'BMP text', description: 'a'.repeat(5_000), expected: `T\n${'a'.repeat(3_998)}` },
	{ name: 'supplementary text', description: '😀'.repeat(2_500), expected: `T\n${'😀'.repeat(1_999)}` },
	{ name: 'a surrogate at the boundary', description: `x${'😀'.repeat(2_500)}`, expected: `T\nx${'😀'.repeat(1_998)}` },
]

for (const fixture of cases) {
	test(`knowledge preparation persists a bounded complete query for ${fixture.name}`, async () => {
		const root = mkdtempSync(join(tmpdir(), 'hm-kq-'))
		const db = new DB(join(root, 'test.db'))
		try {
			const config = configSchema.parse({
				provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'test', apiToken: 'fixture' },
				projects: [{ slug: 'project', repoPath: root, baseBranch: 'main' }],
				knowledge: {
					providers: [
						{ id: 'fixture', type: 'hold', socketPath: join(root, 'hold.sock'), capabilityFile: join(root, 'cap') },
					],
				},
			})
			const item = new ItemCommands(db.items, config).createSolveItem({ projectSlug: 'project', title: 'T' })
			let receivedQuery = ''
			const provider: KnowledgeProvider = {
				id: 'fixture',
				type: 'fixture',
				protocolVersion: 1,
				async prepareBrief(input) {
					receivedQuery = input.query
					return {
						briefRef: 'fixture-brief',
						revision: 'fixture-revision',
						generatedAt: '2026-01-01T00:00:00.000Z',
						context: 'K',
						contextHash: createHash('sha256').update('K').digest('hex'),
						sources: [],
					}
				},
				async submitCandidates() {
					throw new Error('This fixture must not submit candidates')
				},
			}
			const integration = new KnowledgeIntegration(
				config,
				profileId => ({
					id: profileId,
					name: 'Fixture',
					createdAt: '2026-01-01T00:00:00.000Z',
					enabledProjects: ['project'],
					knowledgeBindings: [
						{
							projectSlug: 'project',
							providerId: 'fixture',
							providerProjectId: 'opaque-project',
							characterBudget: 100,
							allowSharedProject: false,
						},
					],
					archivedAt: null,
				}),
				new KnowledgeProviderRegistry([provider]),
			)
			const prepared = await integration.prepareContext(db.knowledge, {
				profileId: item.profileId,
				itemId: item.id,
				projectSlug: 'project',
				purpose: 'solve',
				taskContext: { title: 'T', description: fixture.description },
				binding: integration.bindingFor(item.profileId, 'project'),
			})
			assert.equal(receivedQuery, fixture.expected)
			assert.equal(prepared.snapshot?.query, fixture.expected)
			assert.ok(receivedQuery.length <= 4_000)
			assert.ok(!/[\uD800-\uDBFF]$/.test(receivedQuery))
			assert.equal(prepared.snapshot?.context, 'K')
		} finally {
			db.close()
			rmSync(root, { recursive: true, force: true })
		}
	})
}
