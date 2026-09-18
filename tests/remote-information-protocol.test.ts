import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	projectFooterSource,
	projectSidebarSource,
	unavailableFooter,
	unavailableSidebar,
} from '../src/remote/information-projection.js'
import {
	INFORMATION_PUBLISH_BYTES,
	INFORMATION_RESPONSE_BYTES,
	INFORMATION_RESPONSE_RESERVE,
	INFORMATION_SIDEBAR_BYTES,
	informationBytes,
	informationEnvelopeSchema,
	informationResponseSchema,
	informationSectionSchema,
	safeInformationText,
} from '../src/remote/information-protocol.js'

function required<T>(value: T | null | undefined): T {
	assert.ok(value !== null && value !== undefined)
	return value
}

const target = {
	sessionId: '11111111-1111-4111-8111-111111111111',
	incarnation: '22222222-2222-4222-8222-222222222222',
	scopeId: '33333333-3333-4333-8333-333333333333',
	generation: Number.MAX_SAFE_INTEGER,
}
const epoch = '44444444-4444-4444-8444-444444444444'
const binding = { version: 1, scope: 'session', sessionId: target.sessionId, providerId: 'footer-source', sequence: 0 }
const footer = () => ({
	...binding,
	available: true,
	cwd: 'workspace',
	trusted: false,
	sessionName: 'Safe label',
	model: 'Model',
	thinking: 'off',
	inputTokens: 0,
	outputTokens: null,
	contextTokens: 0,
	contextWindow: 100,
	contextPercent: 0,
	goalAvailable: true,
	goalPhase: null,
	omittedStatuses: 0,
	omitted: 0,
})
const section = () => ({
	title: 'Todos',
	scope: 'session',
	availability: 'available',
	coverage: 'complete',
	rows: [{ label: 'Task', value: 'Safe task' as string | number | boolean | null }],
	omitted: 0,
})
const sidebar = () => ({ ...binding, providerId: 'sidebar-source', sections: [section()], omittedProviders: 0 })
const envelope = () => ({
	version: 1,
	hostEpoch: epoch,
	target,
	sequence: Number.MAX_SAFE_INTEGER,
	footer: required(projectFooterSource(footer())).information,
	sidebar: required(projectSidebarSource(sidebar())).information,
})
const response = () => ({
	version: 1,
	hostEpoch: epoch,
	target,
	status: 'available',
	freshForMs: 5000,
	information: envelope(),
})

test('independent named projection preserves real null, false, zero and genuine no-goal without private metadata', () => {
	const projected = required(projectFooterSource(footer()))
	assert.equal(projected.information.fields?.trusted, false)
	assert.equal(projected.information.fields?.inputTokens, 0)
	assert.equal(projected.information.fields?.outputTokens, null)
	assert.equal(projected.information.fields?.goalAvailable, true)
	assert.equal(projected.information.fields?.goalPhase, null)
	assert.equal(Object.keys(required(projected.information.fields)).length, 14) // 13 values + omitted metadata
	assert.equal(informationBytes(envelope()) < INFORMATION_PUBLISH_BYTES, true)
	assert.equal(informationEnvelopeSchema.safeParse(envelope()).success, true)
	assert.doesNotMatch(JSON.stringify(envelope()), /providerId|footer-source|sidebar-source|readInformation/)
	assert.deepEqual(required(projectFooterSource({ ...footer(), available: false })).information, unavailableFooter())
	assert.deepEqual(unavailableSidebar('unsupported'), {
		availability: 'unsupported',
		sections: [],
		omittedProviders: 0,
	})
})

test('captures each descriptor once, does not invoke accessors/toJSON/enumeration, rejects throwing and malformed fields', () => {
	let reads = 0
	let effects = 0
	const source = new Proxy(
		{
			...footer(),
			toJSON() {
				effects++
				throw Error('private')
			},
		},
		{
			getOwnPropertyDescriptor(object, key) {
				if (key === 'sequence') {
					reads++
					return { value: reads === 1 ? 10 : 9, configurable: true }
				}
				return Reflect.getOwnPropertyDescriptor(object, key)
			},
			ownKeys() {
				effects++
				throw Error('enumeration')
			},
		},
	)
	assert.equal(projectFooterSource(source)?.binding.sequence, 10)
	assert.equal(reads, 1)
	assert.equal(effects, 0)
	const accessor = footer()
	Object.defineProperty(accessor, 'model', {
		get() {
			effects++
			return '/private/path'
		},
	})
	assert.equal(projectFooterSource(accessor), null)
	assert.equal(effects, 0)
	assert.equal(
		projectFooterSource(
			new Proxy(
				{},
				{
					getOwnPropertyDescriptor() {
						throw Error('private')
					},
				},
			),
		),
		null,
	)
	assert.equal(projectFooterSource({ ...footer(), goalAvailable: false, goalPhase: 'active' }), null)
	assert.equal(projectFooterSource({ ...footer(), goalPhase: 'private'.repeat(10_000) }), null)
	assert.equal(projectFooterSource({ ...footer(), inputTokens: -1 }), null)
	assert.equal(projectFooterSource({ ...footer(), contextPercent: Number.POSITIVE_INFINITY }), null)
	assert.equal(projectFooterSource({ ...footer(), sequence: Number.MAX_SAFE_INTEGER + 1 }), null)
})

test('credential/path/control filtering keeps safe label compatibility and valid Unicode', () => {
	for (const value of [
		'Bearer example',
		'Bearer:example',
		'Bearer=example',
		'bEaReR : example',
		'x bearer example',
		'password=x',
		'token:secret',
		'/tmp/private',
		'relative/path',
		'file:private',
		'x\u001b',
		'x\ud800',
		'<html>',
		'sk-secret',
	]) {
		assert.equal(safeInformationText(value), false, value)
		assert.equal(projectFooterSource({ ...footer(), model: value }), null, value)
	}
	for (const value of ['Tokenization', 'Secretariat', 'Passwordless rollout', 'Safe label', 'Work 🛠']) {
		assert.equal(safeInformationText(value), true, value)
		assert.equal(projectFooterSource({ ...footer(), model: value })?.information.fields?.model, value)
	}
})

test('sidebar isolates malformed, unavailable and unsupported sections, detaches rows and preserves limited zero', () => {
	const value = sidebar()
	value.sections.push({ ...section(), rows: [{ label: 'Unsafe', value: '/private/path' }] })
	value.sections.push({ ...section(), title: 'Jobs', coverage: 'limited', rows: [{ label: 'Running', value: 0 }] })
	value.sections.push({
		...section(),
		title: 'Subagents',
		availability: 'unsupported',
		coverage: 'unavailable',
		rows: [],
	})
	const projected = required(projectSidebarSource(value))
	assert.equal(projected.information.sections[0].availability, 'available')
	assert.equal(projected.information.sections[1].availability, 'unavailable')
	assert.deepEqual(projected.information.sections[1].rows, [])
	assert.equal(projected.information.sections[2].coverage, 'limited')
	assert.equal(projected.information.sections[2].rows[0].value, 0)
	assert.equal(projected.information.sections[3].availability, 'unsupported')
	value.sections[0].rows[0].value = 'Changed'
	assert.equal(projected.information.sections[0].rows[0].value, 'Safe task')
	const throwing = new Proxy(
		{},
		{
			getOwnPropertyDescriptor() {
				throw Error('private')
			},
		},
	)
	assert.equal(
		projectSidebarSource({ ...sidebar(), sections: [section(), throwing] })?.information.sections[0].availability,
		'available',
	)
	assert.equal(
		projectSidebarSource({ ...sidebar(), sections: [section(), throwing] })?.information.sections[1].availability,
		'unavailable',
	)
	assert.equal(projectSidebarSource({ ...sidebar(), omittedProviders: undefined }), null)
})

test('strict ingress rejects hidden keys, stale failed-source fields and inconsistent semantic states', () => {
	for (const bad of [
		{ ...envelope(), secret: 'private' },
		{ ...envelope(), footer: { ...envelope().footer, providerId: 'private' } },
		{ ...envelope(), footer: { availability: 'unavailable', fields: envelope().footer.fields } },
		{ ...envelope(), footer: { availability: 'available', fields: null } },
		{ ...envelope(), sidebar: { ...envelope().sidebar, availability: 'unavailable' } },
		{
			...envelope(),
			sidebar: {
				availability: 'available',
				sections: [{ ...section(), coverage: 'complete', omitted: 1 }],
				omittedProviders: 0,
			},
		},
	])
		assert.equal(informationEnvelopeSchema.safeParse(bad).success, false)
})

test('footer reservation and complete sidebar producer budget include identity, escaping and all sections', () => {
	const rows = (count: number) => Array.from({ length: count }, () => ({ label: 'L', value: 'v' }))
	const sections = [24, 24, 24, 11].map(count => ({ ...section(), rows: rows(count) }))
	assert.equal(projectSidebarSource({ ...sidebar(), sections })?.information.sections.length, 4)
	assert.equal(projectSidebarSource({ ...sidebar(), sections: [...sections, { ...section(), rows: rows(1) }] }), null)
	assert.equal(
		projectSidebarSource({ ...sidebar(), sections: Array.from({ length: 8 }, () => ({ ...section(), rows: [] })) }),
		null,
	)
	assert.equal(
		projectSidebarSource({ ...sidebar(), sections: [{ ...section(), rows: rows(25) }] })?.information.sections[0]
			.availability,
		'unavailable',
	)
	const wide = sections.map(s => ({
		...s,
		rows: s.rows.map(() => ({ label: '"'.repeat(80), value: '😀'.repeat(80) })),
	}))
	const raw = {
		...sidebar(),
		sessionId: 'S'.repeat(1024),
		providerId: 'P'.repeat(128),
		sequence: Number.MAX_SAFE_INTEGER,
		sections: wide,
	}
	assert.equal(informationBytes(raw) > INFORMATION_SIDEBAR_BYTES, true)
	assert.equal(projectSidebarSource(raw), null)
	assert.equal(
		informationEnvelopeSchema.safeParse({
			...envelope(),
			sidebar: {
				availability: 'available',
				sections: [...sections, { ...section(), rows: rows(1) }],
				omittedProviders: 0,
			},
		}).success,
		false,
	)
})

test('reachable encoded maxima fit complete response reserve; oversized sidebar is adversarial, not producer-reachable', () => {
	const makeSource = (width: number) => ({
		...sidebar(),
		sessionId: 'S'.repeat(1024),
		providerId: 'P'.repeat(128),
		sequence: Number.MAX_SAFE_INTEGER,
		omittedProviders: 10_000,
		sections: [24, 24, 24, 11, 0, 0, 0].map(count => ({
			...section(),
			title: 'T'.repeat(80),
			rows: Array.from({ length: count }, () => ({ label: '"'.repeat(80), value: '😀'.repeat(width) })),
		})),
	})
	let largest = envelope()
	let sourceBytes = 0
	for (let width = 1; width <= 80; width++) {
		const source = makeSource(width)
		const projected = projectSidebarSource(source)
		if (projected) {
			largest = { ...envelope(), sidebar: projected.information }
			sourceBytes = informationBytes(source)
		}
	}
	assert.equal(sourceBytes > INFORMATION_SIDEBAR_BYTES - 4 * 83, true)
	const maximumFooter = required(
		projectFooterSource({
			...footer(),
			cwd: '😀'.repeat(80),
			sessionName: '😀'.repeat(80),
			model: '😀'.repeat(80),
			inputTokens: Number.MAX_SAFE_INTEGER,
			outputTokens: Number.MAX_SAFE_INTEGER,
			contextTokens: Number.MAX_SAFE_INTEGER,
			contextWindow: Number.MAX_SAFE_INTEGER,
			contextPercent: 100,
			omittedStatuses: 10_000,
			omitted: 10_000,
		}),
	)
	largest.footer = maximumFooter.information
	assert.equal(informationEnvelopeSchema.safeParse(largest).success, true)
	assert.equal(informationBytes(largest) < INFORMATION_PUBLISH_BYTES, true)
	const oversized = { availability: 'available', sections: makeSource(80).sections, omittedProviders: 10_000 }
	assert.equal(informationBytes(oversized) > INFORMATION_PUBLISH_BYTES, true)
	assert.equal(informationEnvelopeSchema.safeParse({ ...envelope(), sidebar: oversized }).success, false)
	const wrapped = { ...response(), information: largest }
	assert.equal(informationResponseSchema.safeParse(wrapped).success, true)
	assert.equal(informationBytes(wrapped) <= INFORMATION_RESPONSE_BYTES, true)
	assert.equal(informationBytes(wrapped) - informationBytes(largest) <= INFORMATION_RESPONSE_RESERVE, true)
	// Current independent producer bounds outrank the defensive 31/32KiB ceilings.
	// This does not claim a reachable valid source can hit either whole-wire ceiling.
})

test('section title limit is 80 UTF-16 units, independently of label80 and value160', () => {
	const bounded = { ...section(), title: 'T'.repeat(80), rows: [{ label: 'L'.repeat(80), value: 'V'.repeat(160) }] }
	assert.equal(informationSectionSchema.safeParse(bounded).success, true)
	assert.equal(informationSectionSchema.safeParse({ ...bounded, title: 'T'.repeat(81) }).success, false)
	assert.equal(informationSectionSchema.safeParse({ ...bounded, title: '😀'.repeat(40) }).success, true)
	assert.equal(informationSectionSchema.safeParse({ ...bounded, title: `${'😀'.repeat(40)}X` }).success, false)
	assert.equal(projectSidebarSource({ ...sidebar(), sections: [bounded] })?.information.sections[0].title.length, 80)
	assert.equal(
		projectSidebarSource({ ...sidebar(), sections: [{ ...bounded, title: 'T'.repeat(81) }] })?.information.sections[0]
			.availability,
		'unavailable',
	)
})

test('response binds complete owner and epoch with positive bounded remaining host freshness', () => {
	assert.equal(informationResponseSchema.safeParse(response()).success, true)
	for (const bad of [
		{ ...response(), freshForMs: 0 },
		{ ...response(), freshForMs: 5001 },
		{ ...response(), hostEpoch: target.sessionId },
		{ ...response(), target: { ...target, generation: 1 } },
		{ ...response(), target: { ...target, incarnation: target.sessionId } },
		{ ...response(), target: { ...target, scopeId: null } },
		{ ...response(), target: { ...target, sessionId: target.incarnation } },
		{ ...response(), status: 'unavailable' },
	])
		assert.equal(informationResponseSchema.safeParse(bad).success, false)
	for (const status of ['unsupported', 'unavailable']) {
		assert.equal(
			informationResponseSchema.safeParse({ ...response(), status, freshForMs: 0, information: null }).success,
			true,
		)
		assert.equal(
			informationResponseSchema.safeParse({ ...response(), status, freshForMs: 1, information: null }).success,
			false,
		)
	}
})
