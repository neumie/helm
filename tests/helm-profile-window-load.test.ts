import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import profileWindowLoadModule from '../app/src/profile-window-load.ts'
const { reloadOrCreateProfileWindow } = profileWindowLoadModule

class FakeWebContents extends EventEmitter {
	destroyed = false
	reloadCount = 0

	isDestroyed(): boolean {
		return this.destroyed
	}

	isLoading(): boolean {
		return false
	}

	reload(): void {
		this.reloadCount += 1
	}
}

class FakeWindow extends EventEmitter {
	destroyed = false
	readonly webContents = new FakeWebContents()

	isDestroyed(): boolean {
		return this.destroyed
	}
}

function fixture(existing: FakeWindow | null = new FakeWindow()) {
	const timers: Array<() => void> = []
	const cleared: number[] = []
	let created = 0
	let loaded = 0
	let epoch = 4
	const createdWindow = new FakeWindow()
	const promise = reloadOrCreateProfileWindow({
		existing,
		createWindow: () => {
			created += 1
			return createdWindow
		},
		epoch: 4,
		currentEpoch: () => epoch,
		onLoaded: () => {
			loaded += 1
		},
		timeoutMs: 15_000,
		setTimer: (callback: () => void) => {
			timers.push(callback)
			return timers.length as unknown as ReturnType<typeof setTimeout>
		},
		clearTimer: (timer: ReturnType<typeof setTimeout>) => cleared.push(timer as unknown as number),
	})
	return {
		promise,
		window: existing ?? createdWindow,
		created: () => created,
		loaded: () => loaded,
		timers,
		cleared,
		set epoch(value: number) {
			epoch = value
		},
	}
}

test('profile renderer reload settles successfully only for its current epoch', async () => {
	const f = fixture()
	assert.equal(f.window.webContents.reloadCount, 1)
	f.window.webContents.emit('did-finish-load')
	await f.promise
	assert.equal(f.loaded(), 1)
	assert.deepEqual(f.cleared, [1])
})

test('profile renderer reload rejects did-fail-load', async () => {
	const f = fixture()
	f.window.webContents.emit('did-fail-load', {}, -105, 'Name not resolved')
	await assert.rejects(f.promise, /Profile renderer load failed \(-105\): Name not resolved/)
	assert.equal(f.loaded(), 0)
	assert.deepEqual(f.cleared, [1])
})

test('profile renderer reload rejects if its window closes', async () => {
	const f = fixture()
	f.window.emit('closed')
	await assert.rejects(f.promise, /window closed during reload/)
	assert.equal(f.loaded(), 0)
	assert.deepEqual(f.cleared, [1])
})

test('profile renderer reload rejects on its bounded timeout', async () => {
	const f = fixture()
	assert.equal(f.timers.length, 1)
	const fireTimeout = f.timers[0]
	assert.ok(fireTimeout)
	fireTimeout()
	await assert.rejects(f.promise, /Timed out waiting for profile renderer reload/)
	assert.equal(f.loaded(), 0)
	assert.deepEqual(f.cleared, [1])
})

test('profile renderer creates a missing window and settles its load without reloading it', async () => {
	const f = fixture(null)
	assert.equal(f.created(), 1)
	assert.equal(f.window.webContents.reloadCount, 0)
	f.window.webContents.emit('did-finish-load')
	await f.promise
	assert.equal(f.loaded(), 1)
})
