import assert from 'node:assert/strict'
import test from 'node:test'
// tsx loads app modules through the project CJS bridge in Node tests.
// @ts-expect-error default-import convention for that bridge
import rendererLifecycleModule from '../app/src/renderer-lifecycle.ts'
type RendererLifecycleModule = typeof import('../app/src/renderer-lifecycle.ts')
const { RendererCrashRecovery, sendToLiveRenderer } = rendererLifecycleModule as RendererLifecycleModule

test('renderer delivery refuses a disposed main frame even while WebContents remains alive', () => {
	let sends = 0
	const contents = {
		isDestroyed: () => false,
		isCrashed: () => false,
		mainFrame: {
			isDestroyed: () => true,
			send: () => {
				sends += 1
			},
		},
	}

	assert.equal(sendToLiveRenderer(contents, 'pty:data', 4, 'chunk', 'work:1'), false)
	assert.equal(sends, 0)
})

test('renderer crash recovery detaches PTY clients before asynchronously reloading', () => {
	const effects: string[] = []
	const scheduled: Array<() => void> = []
	const recovery = new RendererCrashRecovery({
		isQuitting: () => false,
		beforeReload: () => effects.push('detach'),
		schedule: (callback: () => void) => scheduled.push(callback),
	})
	const contents = {
		isDestroyed: () => false,
		reload: () => effects.push('reload'),
	}

	assert.equal(recovery.recover(contents, { reason: 'crashed', exitCode: 5 }), true)
	assert.deepEqual(effects, ['detach'])
	assert.equal(scheduled.length, 1)
	scheduled[0]?.()
	assert.deepEqual(effects, ['detach', 'reload'])
})

test('renderer crash recovery stops after three attempts in one minute', () => {
	let clock = 1_000
	let detaches = 0
	const scheduled: Array<() => void> = []
	const recovery = new RendererCrashRecovery({
		isQuitting: () => false,
		beforeReload: () => {
			detaches += 1
		},
		schedule: callback => scheduled.push(callback),
		now: () => clock,
		maxAttempts: 3,
		windowMs: 60_000,
	})
	const contents = { isDestroyed: () => false, reload: () => {} }

	for (let attempt = 0; attempt < 3; attempt += 1) {
		assert.equal(recovery.recover(contents, { reason: 'crashed', exitCode: 5 }), true)
		scheduled.shift()?.()
	}
	assert.equal(recovery.recover(contents, { reason: 'crashed', exitCode: 5 }), false)
	assert.equal(detaches, 3)

	clock += 60_001
	assert.equal(recovery.recover(contents, { reason: 'crashed', exitCode: 5 }), true)
	assert.equal(detaches, 4)
})
