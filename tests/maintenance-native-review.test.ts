import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import draftsModule from '../app/src/document-review/drafts'
import typesModule from '../app/src/document-review/types'

const { ReviewDraftStore } = draftsModule
const { defaultReviewDraft } = typesModule

function fixture() {
	const root = mkdtempSync('/tmp/hr-draft-discard-')
	const store = new ReviewDraftStore(root)
	return { root, store, close: () => rmSync(root, { recursive: true, force: true }) }
}

test('explicit exact-key discard preserves other scopes, legacy notes and source journal', () => {
	const f = fixture()
	try {
		const source = join(f.root, 'review.md')
		const journal = '# Body\n<!-- helm-review:v1 preserved-source-journal -->'
		writeFileSync(source, journal)
		const baseKey = f.store.key(f.root, source, null)
		const oldKey = f.store.key(f.root, source, 'review:old')
		const retainedKey = f.store.key(f.root, source, 'review:retained')
		const retained = {
			...defaultReviewDraft(),
			instruction: 'Keep this draft',
			annotations: [
				{
					id: 'legacy-note',
					passage: {
						revision: 'a'.repeat(64),
						start: 0,
						end: 4,
						source: 'Body',
						quote: 'Body',
						kind: 'block' as const,
					},
					note: 'Keep this legacy note',
					intent: 'discuss' as const,
					resolved: false,
				},
			],
		}
		f.store.save(baseKey, { ...defaultReviewDraft(), theme: 'light' })
		f.store.save(oldKey, { ...defaultReviewDraft(), instruction: 'Explicitly discarded' })
		f.store.save(retainedKey, retained)
		assert.equal(f.store.discard(oldKey), true)
		assert.equal(f.store.discard(oldKey), false)
		assert.throws(() => f.store.discard('__proto__'), /Invalid review draft key/)
		const reopened = new ReviewDraftStore(f.root)
		assert.deepEqual(reopened.load(oldKey), defaultReviewDraft())
		assert.deepEqual(reopened.load(retainedKey), retained)
		assert.equal(reopened.load(baseKey).theme, 'light')
		assert.equal(Object.keys(JSON.parse(readFileSync(f.store.file, 'utf8'))).length, 2)
		assert.equal(readFileSync(source, 'utf8'), journal)
		assert.equal(
			readdirSync(f.root).some(name => name.endsWith('.tmp')),
			false,
		)
	} finally {
		f.close()
	}
})

test('discard persistence refusal preserves trusted memory and disk until explicit retry', () => {
	const f = fixture()
	try {
		const key = f.store.key('/workspace', '/workspace/review.md', null)
		const draft = { ...defaultReviewDraft(), instruction: 'Do not lose this' }
		f.store.save(key, draft)
		const original = readFileSync(f.store.file)
		chmodSync(f.root, 0o755)
		assert.throws(() => f.store.discard(key), /private review draft folder/)
		assert.deepEqual(f.store.load(key), draft)
		assert.deepEqual(readFileSync(f.store.file), original)
		chmodSync(f.root, 0o700)
		assert.equal(f.store.discard(key), true)
		assert.deepEqual(new ReviewDraftStore(f.root).load(key), defaultReviewDraft())
	} finally {
		f.close()
	}
})

test('only explicit removal reclaims entry capacity, including an already-empty scope', () => {
	const f = fixture()
	try {
		const keys = Array.from({ length: 256 }, (_, index) => f.store.key('/workspace', `/workspace/${index}.md`, null))
		const entries = Object.fromEntries(keys.map(key => [key, defaultReviewDraft()]))
		writeFileSync(f.store.file, JSON.stringify(entries), { mode: 0o600 })
		const store = new ReviewDraftStore(f.root)
		const extra = store.key('/workspace', '/workspace/extra.md', null)
		assert.throws(() => store.save(extra, defaultReviewDraft()), /256-entry limit/)
		const first = keys[0]
		assert.ok(first)
		store.save(first, defaultReviewDraft())
		assert.throws(() => store.save(extra, defaultReviewDraft()), /256-entry limit/)
		assert.equal(store.discard(first), true)
		store.save(extra, defaultReviewDraft())
		const saved = JSON.parse(readFileSync(store.file, 'utf8'))
		assert.equal(Object.keys(saved).length, 256)
		assert.equal(Object.hasOwn(saved, first), false)
		for (const key of keys.slice(1)) assert.deepEqual(saved[key], entries[key])
	} finally {
		f.close()
	}
})

test('byte exhaustion is distinguished from entry exhaustion without discarding drafts', () => {
	const f = fixture()
	try {
		const draft = { ...defaultReviewDraft(), instruction: 'x'.repeat(8000) }
		let refused = false
		for (let index = 0; index < 256; index++) {
			const key = f.store.key('/workspace', `/workspace/${index}.md`, null)
			const before = index ? readFileSync(f.store.file) : null
			try {
				f.store.save(key, draft)
			} catch (error) {
				assert.match(String(error), /1 MiB limit/)
				assert.deepEqual(readFileSync(f.store.file), before)
				assert.deepEqual(f.store.load(key), defaultReviewDraft())
				refused = true
				break
			}
		}
		assert.equal(refused, true)
	} finally {
		f.close()
	}
})

test('explicit empty preference reclamation preserves whitespace, notes and source journals', () => {
	const f = fixture()
	try {
		const source = join(f.root, 'review.md')
		const journal = '# Body\n<!-- helm-review:v1 preserved-source-journal -->'
		writeFileSync(source, journal)
		const keys = Array.from({ length: 256 }, (_, index) => f.store.key(f.root, source, `scope:${index}`))
		const entries = Object.fromEntries(keys.map(key => [key, defaultReviewDraft()]))
		const whitespace = keys[0]
		const nonempty = keys[1]
		const legacy = keys[2]
		assert.ok(whitespace && nonempty && legacy)
		entries[whitespace] = { ...defaultReviewDraft(), instruction: ' \r\n\t' }
		entries[nonempty] = { ...defaultReviewDraft(), instruction: 'Keep text' }
		entries[legacy] = {
			...defaultReviewDraft(),
			annotations: [
				{
					id: 'legacy',
					note: '',
					intent: 'discuss',
					resolved: true,
					passage: { revision: 'a'.repeat(64), start: 0, end: 4, source: 'Body', quote: 'Body', kind: 'block' },
				},
			],
		}
		writeFileSync(f.store.file, JSON.stringify(entries), { mode: 0o600 })
		const store = new ReviewDraftStore(f.root)
		const extra = store.key(f.root, source, 'extra')
		assert.throws(() => store.save(extra, defaultReviewDraft()), /256-entry limit/)
		assert.equal(store.discardEmptyPreferences(), 253)
		const expected = { [whitespace]: entries[whitespace], [nonempty]: entries[nonempty], [legacy]: entries[legacy] }
		assert.deepEqual(JSON.parse(readFileSync(store.file, 'utf8')), expected)
		assert.equal(new ReviewDraftStore(f.root).discardEmptyPreferences(), 0)
		assert.equal(store.discardEmptyPreferences(), 0)
		store.save(extra, { ...defaultReviewDraft(), instruction: 'New draft after reclamation' })
		assert.equal(readFileSync(source, 'utf8'), journal)
		assert.equal(
			readdirSync(f.root).some(name => name.endsWith('.tmp')),
			false,
		)
	} finally {
		f.close()
	}
})

test('failed empty preference reclamation preserves memory and disk for explicit retry', () => {
	const f = fixture()
	try {
		const key = f.store.key('/workspace', '/workspace/review.md', null)
		const empty = { ...defaultReviewDraft(), theme: 'light' as const, paneWidth: 420 }
		f.store.save(key, empty)
		const original = readFileSync(f.store.file)
		chmodSync(f.root, 0o755)
		assert.throws(() => f.store.discardEmptyPreferences(), /private review draft folder/)
		assert.deepEqual(f.store.load(key), empty)
		assert.deepEqual(readFileSync(f.store.file), original)
		chmodSync(f.root, 0o700)
		assert.equal(f.store.discardEmptyPreferences(), 1)
		assert.deepEqual(JSON.parse(readFileSync(f.store.file, 'utf8')), {})
	} finally {
		f.close()
	}
})
