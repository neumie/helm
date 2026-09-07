import assert from 'node:assert/strict'
import test from 'node:test'
import { MODEL_CATALOG, modelGuidance, resolveHelperInvocation } from '../src/solver/models.js'

test('Astra is curated for Codex and Pi with frontier guidance', () => {
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
