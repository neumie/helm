import assert from 'node:assert/strict'
import test from 'node:test'
import selectionModule from '../app/src/renderer/sidebar/run-selection.ts'
import type { AppConfig, DashboardItem } from '../app/src/shared-helm.ts'

const { buildPlanBody, buildRunBody, effectiveRunSelection, selectAgent } = selectionModule
const item = { solverAgent: 'codex', solverModel: 'gpt-x', solverWorkspace: 'main' } as unknown as DashboardItem
const config = {
	solver: { agent: 'claude', model: 'claude-default', workspace: 'worktree' },
	modelCatalog: { claude: [{ id: 'claude-default', label: 'Claude' }], codex: [{ id: 'gpt-x', label: 'GPT' }] },
} as AppConfig

test('run selection preserves absent, value, and null reset semantics', () => {
	assert.equal(buildRunBody({}), undefined)
	assert.deepEqual(buildRunBody({ agent: 'claude', model: null, workspace: null }), {
		solverAgent: 'claude',
		solverModel: null,
		solverWorkspace: null,
	})
	assert.equal(effectiveRunSelection(item, config, {}).workspace, 'main')
})

test('planning carries stored selections while an untouched run body stays absent', () => {
	assert.deepEqual(buildPlanBody(item, {}), { solverAgent: 'codex', solverModel: 'gpt-x', solverWorkspace: 'main' })
	assert.deepEqual(buildPlanBody(item, { model: null }), {
		solverAgent: 'codex',
		solverModel: null,
		solverWorkspace: 'main',
	})
})

test('switching agent clears a foreign touched model', () => {
	assert.equal(selectAgent({ model: 'gpt-x' }, 'claude', config).model, null)
})
