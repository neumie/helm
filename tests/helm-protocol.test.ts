// helm:// deep-link parsing (app/src/protocol.ts) — the contract between the
// extension's link (`helm://item/<id>`) and the app's open-url handler. The
// legacy `vigil://` scheme (pre-rename links) must parse identically.
// Default-import + destructure: the app is a CJS-context package under tsx.

import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error -- app is CommonJS under tsx; runtime exports arrive on the default object.
import helmProtocolModule from '../app/src/protocol.ts'

type HelmProtocolModule = typeof import('../app/src/protocol.ts')
const { parseHelmDestination, parseHelmItemUrl } = helmProtocolModule as HelmProtocolModule

test('parses profile-qualified item destinations', () => {
	assert.deepEqual(parseHelmDestination('helm://profile/profile-0123456789ab/item/abc-123'), {
		profileId: 'profile-0123456789ab',
		itemId: 'abc-123',
	})
	assert.equal(parseHelmItemUrl('helm://profile/profile-0123456789ab/item/abc-123'), 'abc-123')
})

test('parses helm://item/<id>', () => {
	assert.equal(parseHelmItemUrl('helm://item/abc-123'), 'abc-123')
	assert.equal(parseHelmItemUrl('helm://item/01973f2a.4d'), '01973f2a.4d')
})

test('parses legacy vigil://item/<id> identically', () => {
	assert.equal(parseHelmItemUrl('vigil://item/abc-123'), 'abc-123')
	assert.equal(parseHelmItemUrl('vigil://item/01973f2a.4d'), '01973f2a.4d')
})

test('decodes percent-encoded ids', () => {
	assert.equal(parseHelmItemUrl('helm://item/a%20b'), 'a b')
})

test('rejects everything that is not exactly one item segment', () => {
	assert.equal(parseHelmItemUrl('helm://item/'), null)
	assert.equal(parseHelmItemUrl('helm://item'), null)
	assert.equal(parseHelmItemUrl('helm://item/a/b'), null)
	assert.equal(parseHelmItemUrl('helm://profile/work/item/a/b'), null)
	assert.equal(parseHelmItemUrl('helm://profile/work/task/a'), null)
	assert.equal(parseHelmItemUrl('helm://settings/x'), null)
	assert.equal(parseHelmItemUrl('vigil://settings/x'), null)
	assert.equal(parseHelmItemUrl('https://item/abc'), null)
	assert.equal(parseHelmItemUrl('not a url'), null)
})
