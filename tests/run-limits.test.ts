import assert from 'node:assert/strict'
import test from 'node:test'
import { buildConfigDocument, parseConfigUpdate } from '../src/config-document.js'
import { configSchema } from '../src/config.js'

const base = {
	provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'helm', apiToken: 'test' },
	projects: [{ slug: 'helm', repoPath: '/repo' }],
}

test('run limits preserve legacy defaults and accept independent whole-number budgets', () => {
	const defaults = configSchema.parse(base)
	assert.equal(defaults.solver.concurrency, 2)
	assert.equal(defaults.solver.loopConcurrency, 1)
	const saved = parseConfigUpdate({ ...base, solver: { concurrency: 5, loopConcurrency: 3 } }, defaults)
	assert.ok(saved.success)
	assert.equal(saved.data.solver.concurrency, 5)
	assert.equal(saved.data.solver.loopConcurrency, 3)
	const restored = configSchema.parse(JSON.parse(JSON.stringify(saved.data)))
	assert.equal(restored.solver.loopConcurrency, 3)
	for (const solver of [
		{ concurrency: null, loopConcurrency: 12 },
		{ concurrency: 20, loopConcurrency: null },
		{ concurrency: null, loopConcurrency: null },
	]) {
		const unlimited = parseConfigUpdate({ ...base, solver }, defaults)
		assert.ok(unlimited.success)
		const restored = configSchema.parse(JSON.parse(JSON.stringify(unlimited.data)))
		assert.equal(restored.solver.concurrency, solver.concurrency)
		assert.equal(restored.solver.loopConcurrency, solver.loopConcurrency)
		assert.equal(buildConfigDocument(restored, restored).dashboard.solver.concurrency, solver.concurrency)
	}
})

test('run limits reject invalid values at the config save boundary', () => {
	const current = configSchema.parse(base)
	for (const field of ['concurrency', 'loopConcurrency']) {
		for (const invalid of [0, -1, 1.5, '2', 'unlimited', Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			assert.equal(
				parseConfigUpdate({ ...base, solver: { [field]: invalid } }, current).success,
				false,
				`${field}: ${invalid}`,
			)
		}
		for (const valid of [1, 10, 11, 100, null]) {
			assert.equal(parseConfigUpdate({ ...base, solver: { [field]: valid } }, current).success, true)
		}
	}
})

test('Config Document exposes both run limits once in their own Settings section', () => {
	const config = configSchema.parse({ ...base, solver: { concurrency: 4, loopConcurrency: 2 } })
	const doc = buildConfigDocument(config, config)
	const section = doc.edit.sections.find(section => section.id === 'run-limits')
	assert.ok(section)
	assert.equal(section.title, 'Run limits')
	assert.deepEqual(
		section.controls.map(control => control.type === 'field' && control.unlimited),
		[{ finiteDefault: 2 }, { finiteDefault: 1 }],
	)
	assert.match(section.description ?? '', /across all profiles/)
	assert.match(section.description ?? '', /restart/)
	assert.deepEqual(
		section.controls.map(control => control.path),
		[
			['solver', 'concurrency'],
			['solver', 'loopConcurrency'],
		],
	)
	for (const field of ['concurrency', 'loopConcurrency']) {
		const controls = doc.edit.sections.flatMap(section => section.controls)
		assert.equal(controls.filter(control => control.path.join('.') === `solver.${field}`).length, 1)
	}
	assert.equal(doc.dashboard.solver.concurrency, 4)
	assert.equal(doc.dashboard.solver.loopConcurrency, 2)
})
