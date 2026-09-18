import assert from 'node:assert/strict'
import test from 'node:test'
import {
	remoteSubagentActivityCapabilitySchema,
	remoteSubagentActivityFrameSchema,
} from '../src/remote/subagent-activity-protocol.js'

const sessionId = '018f3f5f-5b7a-7abc-8def-0123456789ab'
const providerId = '018f3f5f-5b7a-7abc-8def-abcdef012345'

test('accepts Pi v7 session and provider UUIDs', () => {
	const result = remoteSubagentActivityFrameSchema.safeParse({
		binding: { version: 1, scope: 'session', sessionId, providerId, sequence: 1 },
		activity: { availability: 'available', coverage: 'limited', active: false },
	})
	assert.equal(result.success, true)
})

test('capability and frame wire schemas reject extra fields', () => {
	const frame = {
		binding: { version: 1, scope: 'session', sessionId, providerId, sequence: 1 },
		activity: { availability: 'unavailable', coverage: 'unavailable', active: null },
		extra: true,
	}
	assert.equal(remoteSubagentActivityFrameSchema.safeParse(frame).success, false)
	assert.equal(
		remoteSubagentActivityCapabilitySchema.safeParse({
			version: 1,
			scope: 'session',
			sessionId,
			providerId,
			readActivity: () => null,
			extra: true,
		}).success,
		false,
	)
})
