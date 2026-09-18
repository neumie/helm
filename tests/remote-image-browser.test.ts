import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error -- app modules load as CommonJS objects under the root tsx test runner.
import imageDraftModule from '../app/src/renderer/remote/image-draft.js'
// @ts-expect-error -- app modules load as CommonJS objects under the root tsx test runner.
import imagePreparationModule from '../app/src/renderer/remote/image-preparation.js'
// @ts-expect-error -- app modules load as CommonJS objects under the root tsx test runner.
import promptModule from '../app/src/renderer/remote/prompt-draft.js'
import type { PromptDraft } from '../app/src/renderer/remote/prompt-draft.js'
import { baselineJpeg, progressiveJpeg, smallPng } from './fixtures/remote-image-input.js'

type ImageDraftModule = typeof import('../app/src/renderer/remote/image-draft.js')
type ImagePreparationModule = typeof import('../app/src/renderer/remote/image-preparation.js')
type PromptModule = typeof import('../app/src/renderer/remote/prompt-draft.js')
const { ImageDraftResources } = imageDraftModule as ImageDraftModule
const { prepareSelectedImages } = imagePreparationModule as ImagePreparationModule
const { admitPrompt, choosePrompt, editPrompt, editPromptImages, settlePrompt } = promptModule as PromptModule

function manager() {
	const created: string[] = []
	const revoked: string[] = []
	let id = 0
	return {
		resources: new ImageDraftResources(
			() => {
				const value = `blob:test-${++id}`
				created.push(value)
				return value
			},
			value => revoked.push(value),
		),
		created,
		revoked,
	}
}

const digest = async (bytes: Uint8Array) =>
	Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))).toString('hex')

function dependencies(encoded: Uint8Array = baselineJpeg, decodedSize = 192) {
	const closed: number[] = []
	const encodes: Array<{ width: number; height: number; quality: number }> = []
	return {
		closed,
		encodes,
		value: {
			now: () => 0,
			decode: async () => ({
				width: decodedSize,
				height: decodedSize,
				source: {} as CanvasImageSource,
				close: () => closed.push(1),
			}),
			encode: async (_source: CanvasImageSource, width: number, height: number, quality: number) => {
				encodes.push({ width, height, quality })
				return new Blob([new Uint8Array(encoded)], { type: 'image/jpeg' })
			},
			digest,
		},
	}
}

test('reservation counts prospective bytes, commits exact Blob preview ownership and revokes once', () => {
	const { resources, created, revoked } = manager()
	const reservation = resources.reserve(1)
	assert.ok(reservation)
	assert.deepEqual(resources.usage(), {
		retainedCount: 0,
		retainedBytes: 0,
		reservedCount: 1,
		reservedBytes: 1_572_864,
	})
	const blob = new Blob([new Uint8Array(baselineJpeg)], { type: 'image/jpeg' })
	const image = reservation.create(blob, { width: 192, height: 192, sha256: 'a'.repeat(64) })
	assert.equal(image.blob, blob)
	assert.deepEqual(reservation.commit(), [image])
	assert.equal(resources.usage().retainedBytes, blob.size)
	image.dispose()
	image.dispose()
	assert.deepEqual(created, ['blob:test-1'])
	assert.deepEqual(revoked, ['blob:test-1'])
	assert.equal(resources.usage().retainedCount, 0)
})

test('one preparation reservation at a time and the root 16-image limit fail without eviction', () => {
	const { resources } = manager()
	const active = resources.reserve(4)
	assert.ok(active)
	assert.equal(resources.reserve(1), null)
	active.dispose()
	assert.ok(resources.reserve(16))
})

test('PNG source is fully inspected before decode and exact processed JPEG is published atomically', async () => {
	const { resources } = manager()
	const reservation = resources.reserve(1)
	assert.ok(reservation)
	const deps = dependencies(progressiveJpeg, 1)
	const source = new File([new Uint8Array(smallPng())], 'screen.png', { type: 'image/png' })
	const [image] = await prepareSelectedImages([source], reservation, deps.value)
	assert.ok(image)
	assert.equal(image.blob.type, 'image/jpeg')
	assert.equal(image.bytes, progressiveJpeg.length)
	assert.equal(image.sha256, await digest(progressiveJpeg))
	assert.deepEqual(deps.encodes, [{ width: 1, height: 1, quality: 0.9 }])
	assert.equal(deps.closed.length, 1)
	image.dispose()
})

test('a failed file retires the complete staged batch and leaves no processed ownership', async () => {
	const { resources, revoked } = manager()
	const reservation = resources.reserve(2)
	assert.ok(reservation)
	const deps = dependencies()
	const good = new File([new Uint8Array(baselineJpeg)], 'first.jpg', { type: 'image/jpeg' })
	const unsupported = new File([new Uint8Array([1, 2, 3])], 'second.webp', { type: 'image/webp' })
	await assert.rejects(prepareSelectedImages([good, unsupported], reservation, deps.value), /PNG or JPEG/)
	assert.equal(resources.usage().retainedCount, 0)
	assert.equal(resources.usage().reservedCount, 0)
	assert.deepEqual(revoked, ['blob:test-1'])
})

test('late decoder completion after cancellation closes without publishing a resource', async () => {
	const { resources, created } = manager()
	const outer = new AbortController()
	const reservation = resources.reserve(1, outer.signal)
	assert.ok(reservation)
	let release: (value: {
		width: number
		height: number
		source: CanvasImageSource
		close(): void
	}) => void = () => {}
	let decodeStarted = () => {}
	const started = new Promise<void>(resolve => {
		decodeStarted = resolve
	})
	const decode = new Promise<{
		width: number
		height: number
		source: CanvasImageSource
		close(): void
	}>(resolve => {
		release = resolve
	})
	let closed = 0
	const task = prepareSelectedImages(
		[new File([new Uint8Array(progressiveJpeg)], 'late.jpg', { type: 'image/jpeg' })],
		reservation,
		{
			now: () => 0,
			decode: () => {
				decodeStarted()
				return decode
			},
			encode: async () => new Blob([new Uint8Array(progressiveJpeg)], { type: 'image/jpeg' }),
			digest,
		},
	)
	await started
	outer.abort()
	await assert.rejects(task)
	assert.equal(resources.reserve(1), null)
	assert.deepEqual(resources.usage(), {
		retainedCount: 0,
		retainedBytes: 0,
		reservedCount: 1,
		reservedBytes: 1_572_864,
	})
	release({ width: 1, height: 1, source: {} as CanvasImageSource, close: () => closed++ })
	await new Promise(resolve => setTimeout(resolve, 0))
	assert.equal(closed, 1)
	assert.deepEqual(created, [])
	const successor = resources.reserve(1)
	assert.ok(successor)
	successor.dispose()
	assert.equal(resources.usage().reservedCount, 0)
})

test('deadline fences publication but keeps successor blocked until held native decode settles', async () => {
	const { resources } = manager()
	const reservation = resources.reserve(1)
	assert.ok(reservation)
	let now = 0
	let release: (value: {
		width: number
		height: number
		source: CanvasImageSource
		close(): void
	}) => void = () => {}
	let entered = () => {}
	const started = new Promise<void>(resolve => {
		entered = resolve
	})
	const decode = new Promise<{
		width: number
		height: number
		source: CanvasImageSource
		close(): void
	}>(resolve => {
		release = resolve
	})
	const task = prepareSelectedImages(
		[new File([new Uint8Array(progressiveJpeg)], 'deadline.jpg', { type: 'image/jpeg' })],
		reservation,
		{
			now: () => now,
			decode: () => {
				now = 10_001
				entered()
				return decode
			},
			encode: async () => new Blob([new Uint8Array(progressiveJpeg)], { type: 'image/jpeg' }),
			digest,
		},
	)
	await started
	await assert.rejects(task, /timed out/)
	assert.equal(resources.reserve(1), null)
	release({ width: 1, height: 1, source: {} as CanvasImageSource, close() {} })
	await new Promise(resolve => setTimeout(resolve, 0))
	const successor = resources.reserve(1)
	assert.ok(successor)
	successor.dispose()
})

test('prompt recovery moves the complete image bundle and disposes only the losing owner', () => {
	const { resources, revoked } = manager()
	const reservation = resources.reserve(2)
	assert.ok(reservation)
	const first = reservation.create(new Blob([new Uint8Array(baselineJpeg)], { type: 'image/jpeg' }), {
		width: 192,
		height: 192,
		sha256: '1'.repeat(64),
	})
	const second = reservation.create(new Blob([new Uint8Array(progressiveJpeg)], { type: 'image/jpeg' }), {
		width: 1,
		height: 1,
		sha256: '2'.repeat(64),
	})
	reservation.commit()
	const draft: PromptDraft = { text: ' exact caption ', images: [first, second], editToken: Symbol() }
	assert.equal(admitPrompt(draft, 'command'), true)
	assert.deepEqual(draft.images, [])
	assert.deepEqual(draft.recovery?.images, [first, second])
	editPrompt(draft, 'newer')
	settlePrompt(draft, 'command', 'rejected')
	assert.equal(draft.recovery?.state, 'choice')
	const replacement = resources.reserve(1)
	assert.ok(replacement)
	const newer = replacement.create(new Blob([new Uint8Array(progressiveJpeg)], { type: 'image/jpeg' }), {
		width: 1,
		height: 1,
		sha256: '3'.repeat(64),
	})
	replacement.commit()
	editPromptImages(draft, [newer])
	const recovery = draft.recovery
	assert.ok(recovery)
	assert.equal(choosePrompt(draft, recovery, true), true)
	assert.deepEqual(draft.images, [first, second])
	assert.equal(revoked.includes(newer.objectUrl), true)
	assert.equal(revoked.includes(first.objectUrl), false)
	settlePrompt(draft, 'command', 'dispatched')
})
