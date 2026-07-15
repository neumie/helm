import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error -- app modules load as CommonJS objects under the root tsx test runner.
import appProtocolModule from '../app/src/protocol-version.ts'
import { DAEMON_BUILD_ID, DAEMON_PROTOCOL_VERSION } from '../src/protocol.ts'

type AppProtocolModule = typeof import('../app/src/protocol-version.ts')
const { EXPECTED_DAEMON_BUILD_ID, EXPECTED_DAEMON_PROTOCOL_VERSION } = appProtocolModule as AppProtocolModule

test('desktop app and daemon wire protocol revisions stay aligned', () => {
	assert.equal(EXPECTED_DAEMON_PROTOCOL_VERSION, DAEMON_PROTOCOL_VERSION)
	assert.equal(EXPECTED_DAEMON_BUILD_ID, DAEMON_BUILD_ID)
})
