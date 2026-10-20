import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildPrompt } from '../src/solver/prompt-builder.js'

test('buildPrompt asks source-backed runs to pick up earlier session handoffs', () => {
	const dir = mkdtempSync(join(tmpdir(), 'helm-handoff-'))
	try {
		const ctx = { planDirName: 'handoff-plan', worktreePath: dir }
		const sourced = { title: 'Follow up', metadata: { Source: 'e35d2d17-0891-4690-be30-1c32f97c2e85' } }

		assert.ok(buildPrompt(sourced, ctx).includes('run /clientcare-session-handoff in Pick up mode'))
		assert.ok(
			buildPrompt(sourced, ctx, { agent: 'pi' }).includes('run /skill:clientcare-session-handoff in Pick up mode'),
		)
		assert.ok(buildPrompt(sourced, ctx, { agent: 'codex' }).includes('clientcare-session-handoff/SKILL.md'))

		const sourceless = buildPrompt({ title: 'Captured prompt' }, ctx)
		assert.ok(!sourceless.includes('clientcare-session-handoff'))
		assert.ok(sourceless.includes('complexity assessment, and execution.\n\nIMPORTANT'))
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
