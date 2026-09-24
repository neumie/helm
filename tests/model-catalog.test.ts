import assert from 'node:assert/strict'
import test from 'node:test'
import { buildConfigDocument } from '../src/config-document.js'
import { configSchema } from '../src/config.js'
import { MODEL_CATALOG, modelGuidance, resolveHelperInvocation } from '../src/solver/models.js'

test('Astra remains curated for Codex and Pi with frontier guidance', () => {
	assert.deepEqual(MODEL_CATALOG.codex[0], { id: 'gpt-6-astra', label: 'Astra' })
	assert.ok(
		MODEL_CATALOG.pi.some(model => model.id === 'openai-codex/gpt-6-astra' && model.label === 'OpenAI Codex · Astra'),
	)
	assert.deepEqual(resolveHelperInvocation('claude', 'claude', 'gpt-6-astra'), {
		agent: 'codex',
		model: 'gpt-6-astra',
	})
	assert.deepEqual(resolveHelperInvocation('claude', 'claude', 'openai-codex/gpt-6-astra'), {
		agent: 'pi',
		model: 'openai-codex/gpt-6-astra',
	})
	assert.match(modelGuidance('gpt-6-astra') ?? '', /complex, multi-step work/)
	assert.match(modelGuidance('openai-codex/gpt-6-astra') ?? '', /Pi is running GPT-6 Astra/)
})

test('GPT-6 Sol and Opus 5.5 are available through the shared catalog and own their CLI', () => {
	assert.ok(MODEL_CATALOG.codex.some(model => model.id === 'gpt-6-sol' && model.label === 'Sol (GPT-6)'))
	assert.ok(MODEL_CATALOG.pi.some(model => model.id === 'openai-codex/gpt-6-sol'))
	assert.ok(MODEL_CATALOG.claude.some(model => model.id === 'claude-opus-5-5' && model.label === 'Opus 5.5'))
	assert.ok(MODEL_CATALOG.pi.some(model => model.id === 'anthropic/claude-opus-5-5'))
	assert.deepEqual(resolveHelperInvocation('claude', 'claude', 'gpt-6-sol'), {
		agent: 'codex',
		model: 'gpt-6-sol',
	})
	assert.deepEqual(resolveHelperInvocation('claude', 'claude', 'openai-codex/gpt-6-sol'), {
		agent: 'pi',
		model: 'openai-codex/gpt-6-sol',
	})
	assert.deepEqual(resolveHelperInvocation('codex', 'codex', 'claude-opus-5-5'), {
		agent: 'claude',
		model: 'claude-opus-5-5',
	})
	assert.deepEqual(resolveHelperInvocation('codex', 'codex', 'anthropic/claude-opus-5-5'), {
		agent: 'pi',
		model: 'anthropic/claude-opus-5-5',
	})
	assert.match(modelGuidance('gpt-6-sol') ?? '', /GPT-6 Sol/)
	assert.match(modelGuidance('openai-codex/gpt-6-sol') ?? '', /GPT-6 Sol/)
	assert.match(modelGuidance('claude-opus-5-5') ?? '', /Opus 5.5/)
	assert.match(modelGuidance('anthropic/claude-opus-5-5') ?? '', /Opus 5.5/)

	const config = configSchema.parse({
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'sample', apiToken: 'test-token' },
		projects: [{ slug: 'sample', repoPath: '/tmp/sample', baseBranch: 'main' }],
		solver: { agent: 'pi', model: 'openai-codex/gpt-6-sol' },
	})
	const dashboard = buildConfigDocument(config, config).dashboard
	assert.equal(dashboard.solver.model, 'openai-codex/gpt-6-sol')
	assert.ok(dashboard.modelCatalog.pi.some(model => model.id === 'openai-codex/gpt-6-sol'))
	assert.ok(dashboard.modelCatalog.pi.some(model => model.id === 'anthropic/claude-opus-5-5'))
})
