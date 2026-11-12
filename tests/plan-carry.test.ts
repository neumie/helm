import assert from 'node:assert/strict'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { PlanWorkspace } from '../src/plan/workspace.js'

function fixture() {
	const root = mkdtempSync('/tmp/hm-carry-')
	const source = new PlanWorkspace(join(root, 'checkout'), 'plan')
	const target = new PlanWorkspace(join(root, 'worktree'), 'plan-renamed')
	mkdirSync(join(source.dir, 'issues'), { recursive: true })
	return { root, source, target, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('carryPlanFrom copies public plan documents and tickets with their mtimes, nothing else', () => {
	const f = fixture()
	try {
		writeFileSync(join(f.source.dir, 'prd.md'), 'prd')
		writeFileSync(join(f.source.dir, 'context.md'), 'context')
		writeFileSync(join(f.source.dir, 'issues', '01.md'), 'ticket')
		writeFileSync(join(f.source.dir, 'solver-result.json'), '{}')
		writeFileSync(join(f.source.dir, '.planning-prompt.txt'), 'prompt')
		writeFileSync(join(f.source.dir, '.helm-knowledge-context.md'), 'private')
		writeFileSync(join(f.source.dir, 'notes.txt'), 'not markdown')
		const old = new Date('2026-01-02T03:04:05Z')
		utimesSync(join(f.source.dir, 'prd.md'), old, old)

		const result = f.target.carryPlanFrom(f.source)

		assert.deepEqual(result, { copied: ['context.md', 'issues/01.md', 'prd.md'], kept: [], skipped: [] })
		assert.equal(readFileSync(join(f.target.dir, 'prd.md'), 'utf8'), 'prd')
		assert.equal(readFileSync(join(f.target.dir, 'issues', '01.md'), 'utf8'), 'ticket')
		assert.equal(statSync(join(f.target.dir, 'prd.md')).mtime.getTime(), old.getTime())
		for (const name of ['solver-result.json', '.planning-prompt.txt', '.helm-knowledge-context.md', 'notes.txt']) {
			assert.equal(existsSync(join(f.target.dir, name)), false, name)
		}
		// The source is only read.
		assert.equal(readFileSync(join(f.source.dir, 'solver-result.json'), 'utf8'), '{}')
	} finally {
		f.cleanup()
	}
})

test('carryPlanFrom never replaces a file the worktree already has and never follows symlinks', () => {
	const f = fixture()
	try {
		writeFileSync(join(f.source.dir, 'prd.md'), 'from main')
		writeFileSync(join(f.source.dir, 'spec.md'), 'same')
		writeFileSync(join(f.root, 'secret.md'), 'outside the plan')
		symlinkSync(join(f.root, 'secret.md'), join(f.source.dir, 'linked.md'))
		mkdirSync(f.target.dir, { recursive: true })
		writeFileSync(join(f.target.dir, 'prd.md'), 'committed on the base branch')
		writeFileSync(join(f.target.dir, 'spec.md'), 'same')
		symlinkSync(join(f.root, 'secret.md'), join(f.target.dir, 'README.md'))
		writeFileSync(join(f.source.dir, 'README.md'), 'readme')

		const result = f.target.carryPlanFrom(f.source)

		assert.deepEqual(result, { copied: [], kept: ['README.md', 'prd.md'], skipped: ['linked.md'] })
		assert.equal(readFileSync(join(f.target.dir, 'prd.md'), 'utf8'), 'committed on the base branch')
		assert.equal(readFileSync(join(f.root, 'secret.md'), 'utf8'), 'outside the plan')
		assert.equal(existsSync(join(f.target.dir, 'linked.md')), false)
	} finally {
		f.cleanup()
	}
})

test('carryPlanFrom is a no-op without a source plan and refuses an oversized plan', () => {
	const f = fixture()
	try {
		const empty = new PlanWorkspace(join(f.root, 'nowhere'), 'plan')
		assert.deepEqual(f.target.carryPlanFrom(empty), { copied: [], kept: [], skipped: [] })
		writeFileSync(join(f.source.dir, 'huge.md'), Buffer.alloc(1024 * 1024 + 1, 97))
		assert.throws(() => f.target.carryPlanFrom(f.source), /exceeds/)
		assert.equal(existsSync(join(f.target.dir, 'huge.md')), false)
	} finally {
		f.cleanup()
	}
})
