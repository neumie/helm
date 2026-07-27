import assert from 'node:assert/strict'
import test from 'node:test'
import selectionModule from '../app/src/renderer/sidebar/run-selection.ts'
import type { AppConfig, DashboardItem } from '../app/src/shared-helm.ts'

const { buildPlanBody, buildRunBody, effectiveRunSelection, selectAgent, selectionSummary } = selectionModule
const item = {
	solverAgent: 'codex',
	solverModel: 'gpt-x',
	solverEffort: 'high',
	solverWorkspace: 'main',
} as unknown as DashboardItem
const config = {
	solver: { agent: 'claude', model: 'claude-default', workspace: 'worktree' },
	modelCatalog: {
		claude: [{ id: 'claude-default', label: 'Claude' }],
		codex: [{ id: 'gpt-x', label: 'GPT' }],
		pi: [{ id: 'openai-codex/gpt-x', label: 'Pi · GPT' }],
	},
} as AppConfig

test('run selection preserves absent, value, and null reset semantics', () => {
	assert.equal(buildRunBody({}), undefined)
	assert.deepEqual(buildRunBody({ agent: 'claude', model: null, effort: 'max', workspace: null }), {
		solverAgent: 'claude',
		solverModel: null,
		solverEffort: 'max',
		solverWorkspace: null,
	})
	assert.equal(effectiveRunSelection(item, config, {}).workspace, 'main')
})

test('planning carries stored selections while an untouched run body stays absent', () => {
	assert.deepEqual(buildPlanBody(item, {}), {
		solverAgent: 'codex',
		solverModel: 'gpt-x',
		solverEffort: 'high',
		solverWorkspace: 'main',
	})
	assert.deepEqual(buildPlanBody(item, { model: null }), {
		solverAgent: 'codex',
		solverModel: null,
		solverEffort: 'high',
		solverWorkspace: 'main',
	})
})

test('switching agent clears foreign models while Pi retains max effort', () => {
	assert.equal(selectAgent({ model: 'gpt-x' }, 'claude', config).model, null)
	assert.equal(selectAgent({}, 'claude', config, 'gpt-x').model, null)
	assert.equal(selectAgent({}, 'pi', config, 'claude-default').model, null)
	assert.equal(selectAgent({ effort: 'max' }, 'codex', config).effort, null)
	assert.equal(selectAgent({ effort: 'max' }, 'pi', config).effort, 'max')
	assert.equal(
		selectionSummary({ ...effectiveRunSelection(item, config, {}), agent: 'pi' }),
		'Pi · gpt-x · High effort · Main',
	)
})
