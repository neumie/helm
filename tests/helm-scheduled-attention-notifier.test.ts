import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
// tsx loads app modules through the project CJS bridge in Node tests.
// @ts-expect-error default-import convention for that bridge
import notifierModule from '../app/src/scheduled-attention-notifier.ts'
type NotifierModule = typeof import('../app/src/scheduled-attention-notifier.ts')
const { ScheduledAttentionNotifier, scheduledAttentionNotificationCopy, showNativeAttentionNotification } =
	notifierModule as NotifierModule

test('native notification delivery waits for show and rejects asynchronous failure', async () => {
	for (const [event, expected] of [
		['show', true],
		['failed', false],
	] as const) {
		const listeners = new Map<string, () => void>()
		const result = showNativeAttentionNotification(
			{
				once: (name, listener) => listeners.set(name, listener),
				show: () => queueMicrotask(() => listeners.get(event)?.()),
			},
			100,
		)
		assert.equal(await result, expected)
	}
	assert.equal(
		await showNativeAttentionNotification(
			{
				once: () => undefined,
				show: () => undefined,
			},
			1,
		),
		false,
	)
})

const candidate = {
	profileId: 'alpha',
	runId: 'run-1',
	revision: 4,
	scheduleName: 'Nightly review',
	reportSummary: 'Choose the deployment target.',
	notificationClaimedAt: null,
	notificationDeliveredAt: null,
}

async function flush(): Promise<void> {
	await new Promise<void>(resolve => setImmediate(resolve))
	await new Promise<void>(resolve => setImmediate(resolve))
}

function fixture(options: { show?: boolean; switchOk?: boolean; token?: string | null } = {}) {
	const calls: string[] = []
	let click: (() => void) | null = null
	const notifier = new ScheduledAttentionNotifier({
		list: async () => {
			calls.push('list')
			return [candidate]
		},
		claim: async input => {
			calls.push(`claim:${input.revision}`)
			return { ...input, notificationClaimedAt: '2030-01-01T00:00:00.000Z' }
		},
		markDelivered: async input => {
			calls.push(`delivered:${input.revision}`)
			return true
		},
		notification: content => ({
			show: async () => {
				calls.push(`show:${content.title}:${content.body}`)
				return options.show ?? true
			},
			onClick: listener => {
				click = listener
			},
		}),
		focusAndRestore: () => {
			calls.push('focus')
		},
		activateProfile: async profileId => {
			calls.push(`switch:${profileId}`)
			return options.switchOk ?? true
		},
		currentProfileToken: profileId => {
			calls.push(`token:${profileId}`)
			return options.token === undefined ? 'alpha:9' : options.token
		},
		adopt: async input => {
			calls.push(
				`adopt:${input.profileId}:${input.runId}:${input.revision}:${input.adoptionId}:${input.adopter}:${input.profileToken}`,
			)
		},
		newUuid: (() => {
			const values = ['app-adopter', 'fresh-adoption']
			return () => values.shift() ?? 'extra-id'
		})(),
		setTimer: () => ({ unref() {} }) as never,
		clearTimer: () => undefined,
		pollMs: 1,
	})
	return { notifier, calls, click: () => click?.() }
}

test('scheduled attention notifier claims once, shows safe concise copy, marks delivery, and dedupes', async () => {
	const f = fixture()
	assert.deepEqual(scheduledAttentionNotificationCopy(candidate), {
		title: 'Scheduled run needs attention',
		body: 'Nightly review\nChoose the deployment target.',
	})
	f.notifier.start()
	await flush()
	assert.deepEqual(f.calls.slice(0, 3), [
		'list',
		'claim:4',
		'show:Scheduled run needs attention:Nightly review\nChoose the deployment target.',
	])
	assert.equal(f.calls.filter(call => call.startsWith('delivered:')).length, 1)
	await f.notifier.stop()
})

test('show failure never marks delivery and a stopped notifier admits neither polls nor clicks', async () => {
	const f = fixture({ show: false })
	f.notifier.start()
	await flush()
	assert.equal(
		f.calls.some(call => call.startsWith('delivered:')),
		false,
	)
	await f.notifier.stop()
	f.click()
	await flush()
	assert.equal(
		f.calls.some(call => call.startsWith('adopt:')),
		false,
	)
})

test('notification click focuses, waits for a committed switch/current token, then adopts with fresh and stable identities', async () => {
	const f = fixture()
	f.notifier.start()
	await flush()
	f.click()
	await flush()
	assert.deepEqual(f.calls.slice(-4), [
		'focus',
		'switch:alpha',
		'token:alpha',
		'adopt:alpha:run-1:4:fresh-adoption:app-adopter:alpha:9',
	])
	await f.notifier.stop()
})

test('failed switch or missing current token leaves attention unresolved and does not adopt', async () => {
	for (const options of [{ switchOk: false }, { token: null }]) {
		const f = fixture(options)
		f.notifier.start()
		await flush()
		f.click()
		await flush()
		assert.equal(
			f.calls.some(call => call.startsWith('adopt:')),
			false,
		)
		await f.notifier.stop()
	}
})

test('production main wires the main-only notifier beside resident startup and stops it before bridge shutdown', () => {
	const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')
	assert.match(main, /scheduledAttentionNotifier = new ScheduledAttentionNotifier/)
	assert.match(main, /createWindow\(\)[\s\S]*if \(!screenshotPath\) scheduledAttentionNotifier\.start\(\)/)
	assert.match(main, /Promise\.all\(\[scheduledResidency\.stop\(\), scheduledAttentionNotifier\?\.stop\(\)\]\)/)
})
