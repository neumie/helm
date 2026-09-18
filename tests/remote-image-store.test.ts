import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { type TestContext, test } from 'node:test'
import { IMAGE_PROCESSED_MAX_BYTES, type ImageStoreBinding } from '../src/remote/image-input-protocol.js'
import { RemoteImageStore } from '../src/remote/image-store.js'
import { baselineJpeg, largeJpeg } from './fixtures/remote-image-input.js'
const command = '00000000-0000-0000-0000-000000000099'
function owner(index = 1, device: string | null = 'device'): ImageStoreBinding {
	return {
		target: {
			sessionId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
			incarnation: command,
			scopeId: null,
			generation: 1,
		},
		hostEpoch: command,
		deviceId: device ?? undefined,
		grantRevision: device ? 1 : undefined,
		supportRevision: Symbol(),
	}
}
function harness(t: TestContext) {
	let now = 1000
	let alive = true
	let countdown = 0
	let callback: (() => void) | undefined
	const store = new RemoteImageStore({
		now: () => now,
		isBindingLive: () => {
			if (countdown > 0 && --countdown === 0) {
				const action = callback
				callback = undefined
				action?.()
			}
			return alive
		},
	})
	t.after(() => store.dispose())
	return {
		store,
		setNow: (value: number) => {
			now = value
		},
		setAlive: (value: boolean) => {
			alive = value
		},
		arm: (action: () => void, calls = 1) => {
			callback = action
			countdown = calls
		},
	}
}
function stage(store: RemoteImageStore, binding: ImageStoreBinding, data = baselineJpeg, exact = true) {
	const reservation = store.reserve(binding, exact ? data.length : undefined)
	reservation.append(data)
	return reservation.commit()
}
function bindLarge(t: TestContext) {
	const h = harness(t)
	const binding = owner()
	const data = largeJpeg()
	const ref = stage(h.store, binding, data)
	assert.equal(h.store.bind([ref], binding, command, 11000), true)
	return { ...h, binding, ref, data }
}
test('global read admission refuses a fifth principal without changing usage', t => {
	const { store } = harness(t)
	const images = Array.from({ length: 5 }, (_, index) => {
		const binding = owner(index + 1, `reader${index}`)
		const ref = stage(store, binding)
		assert.equal(store.bind([ref], binding, command, 11000), true)
		return { binding, ref }
	})
	const reads = images.slice(0, 4).map(({ binding, ref }) => store.openRead(ref, binding, command))
	for (const read of reads) assert.ok(read)
	const before = store.usage()
	assert.equal(store.openRead(images[4].ref, images[4].binding, command), null)
	assert.deepEqual(store.usage(), before)
	reads[0]?.release()
	const admitted = store.openRead(images[4].ref, images[4].binding, command)
	assert.ok(admitted)
	admitted.release()
	for (const read of reads) read?.release()
	assert.equal(store.usage().reads, 0)
})
test('global upload admission refuses a fifth principal before allocation', t => {
	const { store } = harness(t)
	const uploads = Array.from({ length: 4 }, (_, index) => store.reserve(owner(index + 1, `uploader${index}`)))
	const before = store.usage()
	assert.equal(before.uploads, 4)
	assert.throws(() => store.reserve(owner(5, 'fifth')))
	assert.deepEqual(store.usage(), before)
	for (const upload of uploads) upload.cancel()
	assert.equal(store.usage().allocatedBytes, 0)
})
test('upload expiry is six seconds, with a positive control just before its boundary', t => {
	const { store, setNow } = harness(t)
	const binding = owner()
	const expired = store.reserve(binding, baselineJpeg.length)
	expired.append(baselineJpeg)
	setNow(7000)
	assert.throws(() => expired.commit())
	assert.equal(store.usage().allocatedBytes, 0)
	const fresh = store.reserve(binding, baselineJpeg.length)
	setNow(12999)
	fresh.append(baselineJpeg)
	assert.equal(fresh.commit().bytes, baselineJpeg.length)
})

test('known length mismatch cancels but unknown length keeps full capacity charged', t => {
	const { store } = harness(t)
	const binding = owner()
	const short = store.reserve(binding, baselineJpeg.length + 1)
	short.append(baselineJpeg)
	assert.throws(() => short.commit())
	assert.equal(store.usage().allocatedBytes, 0)
	const ref = stage(store, binding, baselineJpeg, false)
	assert.equal(store.usage().retainedBytes, IMAGE_PROCESSED_MAX_BYTES)
	assert.equal(store.bind([ref], binding, command, 11000), true)
	store.retireCommand(binding, command)
	assert.equal(store.usage().allocatedBytes, 0)
})
test('issued cancelled/committed objects no longer own retired backing buffers', t => {
	const { store } = harness(t)
	const binding = owner()
	const held = []
	for (let i = 0; i < 12; i++) {
		const reservation = store.reserve(binding)
		// Deliberate white-box lifetime check: accounting alone did not catch a retained backing allocation.
		const resource = [...(store as unknown as { resources: Set<{ buffer: Uint8Array | undefined }> }).resources][0]
		assert.ok(resource.buffer)
		held.push(reservation)
		if (i % 2) {
			reservation.append(baselineJpeg)
			reservation.commit()
			store.invalidate(() => true)
		} else reservation.cancel()
		assert.equal(resource.buffer, undefined)
		assert.equal(store.usage().allocatedBytes, 0)
	}
	for (const reservation of held) {
		reservation.cancel()
		assert.throws(() => reservation.commit())
	}
})
test('owner capacity counts pending reservations and unknown-length backing', t => {
	const { store } = harness(t)
	const binding = owner()
	for (let i = 0; i < 4; i++) stage(store, binding, baselineJpeg, false)
	const pending = store.reserve(binding)
	const before = store.usage()
	assert.throws(() => store.reserve(binding)) // 9MiB, even though upload slot2 is free.
	assert.deepEqual(store.usage(), before)
	pending.cancel()
	stage(store, binding, baselineJpeg, false)
	assert.throws(() => store.reserve(binding))
})
test('owner handle limit includes reservations; complete owner changes have independent caps', t => {
	const { store } = harness(t)
	const binding = owner()
	for (let i = 0; i < 7; i++) stage(store, binding)
	const pending = store.reserve(binding, baselineJpeg.length)
	assert.throws(() => store.reserve(binding, baselineJpeg.length))
	const next = { ...binding, target: { ...binding.target, generation: 2 } }
	const independent = store.reserve(next, baselineJpeg.length)
	independent.cancel()
	pending.cancel()
})
test('development principal sums unknown-length backing across different owners', t => {
	const { store } = harness(t)
	for (let i = 1; i <= 8; i++) stage(store, owner(i, null), baselineJpeg, false)
	assert.equal(store.usage().allocatedBytes, 12 * 1024 * 1024)
	assert.throws(() => store.reserve(owner(9, null)))
})
test('global allocation and handle caps include reservations', t => {
	const { store } = harness(t)
	for (let i = 1; i <= 42; i++) stage(store, owner(i, `device${i}`), baselineJpeg, false)
	assert.equal(store.usage().allocatedBytes, 63 * 1024 * 1024)
	assert.throws(() => store.reserve(owner(43, 'another')))
	store.invalidate(() => true)
	for (let i = 1; i <= 127; i++) stage(store, owner(i, `device${i}`))
	const pending = store.reserve(owner(128, 'last'), baselineJpeg.length)
	assert.throws(() => store.reserve(owner(129, 'too-many'), baselineJpeg.length))
	pending.cancel()
	assert.equal(store.usage().handles, 127)
})
test('command expiry replaces staging expiry in both directions', t => {
	const { store, setNow } = harness(t)
	const binding = owner()
	const ref = stage(store, binding)
	setNow(60_000)
	assert.equal(store.bind([ref], binding, command, 69_000), true)
	setNow(62_000)
	const lease = store.openRead(ref, binding, command)
	assert.ok(lease)
	lease.release()
	setNow(69_000)
	assert.equal(store.openRead(ref, binding, command), null)
	assert.equal(store.usage().allocatedBytes, 0)
	const next = stage(store, binding)
	assert.equal(store.bind([next], binding, command, 70_000), true)
	setNow(70_000)
	assert.equal(store.openRead(next, binding, command), null)
	assert.equal(store.usage().allocatedBytes, 0)
})
test('nonfinite deadlines and partial reference failures cannot bind any image', t => {
	const { store } = harness(t)
	const binding = owner()
	const a = stage(store, binding)
	const b = stage(store, binding)
	for (const deadline of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
		assert.equal(store.bind([a], binding, command, deadline), false)
	assert.equal(store.bind([a, { ...b, sha256: '0'.repeat(64) }], binding, command, 11000), false)
	assert.equal(store.bind([a, b], binding, command, 11000), true)
	assert.equal(store.bind([a, b], binding, command, 11000), false)
})
for (const operation of ['reserve', 'commit', 'read'] as const)
	test(`reentrant disposal fences ${operation}`, t => {
		const { store, arm } = harness(t)
		const binding = owner()
		if (operation === 'reserve') {
			arm(() => store.dispose())
			assert.throws(() => store.reserve(binding))
		} else if (operation === 'commit') {
			const upload = store.reserve(binding, baselineJpeg.length)
			upload.append(baselineJpeg)
			arm(() => store.dispose())
			assert.throws(() => upload.commit())
		} else {
			const ref = stage(store, binding)
			assert.equal(store.bind([ref], binding, command, 11000), true)
			arm(() => store.dispose(), 2) // prune callback succeeds, admission callback disposes.
			assert.equal(store.openRead(ref, binding, command), null)
		}
		assert.equal(store.usage().allocatedBytes, 0)
		assert.throws(() => store.reserve(binding))
	})
test('current liveness, not an unrelated callback or invalid deadline, refuses binding', t => {
	const { store, setAlive } = harness(t)
	const binding = owner()
	const ref = stage(store, binding)
	setAlive(false)
	assert.equal(store.bind([ref], binding, command, 11000), false)
	assert.equal(store.usage().allocatedBytes, 0)
	setAlive(true)
	assert.equal(store.bind([ref], binding, command, 11000), false)
	const fresh = stage(store, binding)
	assert.equal(store.bind([fresh], binding, command, 11000), true)
})
for (const mode of ['retire', 'invalidate', 'dispose', 'expire', 'reentrant'] as const)
	test(`a partial read throws, rather than succeeding with EOF, after ${mode}`, t => {
		const { store, binding, ref, setNow, arm } = bindLarge(t)
		const lease = store.openRead(ref, binding, command)
		assert.ok(lease)
		assert.equal(lease.nextChunk()?.byteLength, 65536)
		if (mode === 'retire') store.retireCommand(binding, command)
		if (mode === 'invalidate') store.invalidate(() => true)
		if (mode === 'dispose') store.dispose()
		if (mode === 'expire') setNow(3000)
		if (mode === 'reentrant') arm(() => store.invalidate(() => true))
		assert.throws(() => lease.nextChunk())
		assert.throws(() => lease.nextChunk())
		lease.release()
		lease.release()
		assert.equal(store.usage().reads, 0)
	})
test('private reads are bounded, release is idempotent, and returned chunks cannot corrupt stored bytes', t => {
	const { store, binding, ref, data } = bindLarge(t)
	const a = store.openRead(ref, binding, command)
	const b = store.openRead(ref, binding, command)
	assert.ok(a)
	assert.ok(b)
	assert.equal(store.openRead(ref, binding, command), null)
	const returned = a.nextChunk()
	assert.ok(returned)
	returned.fill(0)
	a.release()
	a.release()
	assert.throws(() => a.nextChunk())
	b.release()
	const reread = store.openRead(ref, binding, command)
	assert.ok(reread)
	const hash = createHash('sha256')
	let bytes = 0
	for (let chunk = reread.nextChunk(); chunk !== null; chunk = reread.nextChunk()) {
		hash.update(chunk)
		bytes += chunk.byteLength
		assert.ok(chunk.byteLength <= 65536)
	}
	assert.equal(bytes, data.length)
	assert.equal(hash.digest('hex'), ref.sha256)
	assert.equal(reread.nextChunk(), null)
	reread.release()
	assert.equal(store.usage().reads, 0)
})
test('the last cancellation clears the lazy timer and a disposed reservation never commits', t => {
	const { store } = harness(t)
	const binding = owner()
	const upload = store.reserve(binding)
	const timer = () => (store as unknown as { timer: unknown }).timer
	assert.notEqual(timer(), undefined)
	upload.cancel()
	assert.equal(timer(), undefined)
	const later = store.reserve(binding, baselineJpeg.length)
	later.append(baselineJpeg)
	store.dispose()
	assert.equal(timer(), undefined)
	assert.throws(() => later.commit())
})
