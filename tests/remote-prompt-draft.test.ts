import assert from 'node:assert/strict'
import test from 'node:test'
import promptModule from '../app/src/renderer/remote/prompt-draft.js'
import type { PromptDraft } from '../app/src/renderer/remote/prompt-draft.js'
const { admitPrompt, editPrompt, settlePrompt, choosePrompt } = promptModule
const draft = (text = '  exact raw\r\ntext  '): PromptDraft => ({ text, editToken: Symbol() })

test('admission captures exact bounded raw text and owns an immediate empty editor', () => {
	const d = draft()
	const token = d.editToken
	assert.equal(admitPrompt(d, 'one'), true)
	assert.equal(d.text, '')
	assert.notEqual(d.editToken, token)
	assert.equal(d.recovery?.rawText, '  exact raw\r\ntext  ')
	assert.equal(d.recovery?.clearedAtToken, d.editToken)
	assert.equal(admitPrompt(d, 'two'), false)
})
test('blank and oversize admission are entirely nonmutating; exact max bound is retained', () => {
	for (const text of [' \r\n ', 'x'.repeat(16385)]) {
		const d = draft(text)
		const before = { ...d }
		assert.equal(admitPrompt(d, 'one'), false)
		assert.deepEqual(d, before)
	}
	const d = draft('x'.repeat(16384))
	assert.equal(admitPrompt(d, 'one'), true)
	settlePrompt(d, 'one', 'rejected')
	assert.equal(d.text.length, 16384)
})
test('known rejection restores untouched exact raw text with a fresh ownership token', () => {
	const d = draft()
	admitPrompt(d, 'one')
	const cleared = d.editToken
	settlePrompt(d, 'one', 'rejected')
	assert.equal(d.text, '  exact raw\r\ntext  ')
	assert.notEqual(d.editToken, cleared)
	assert.equal(d.recovery, undefined)
})
for (const edit of ['  exact raw\r\ntext  ', 'newer', '']) {
	test(`newer editor ownership survives success: ${JSON.stringify(edit)}`, () => {
		const d = draft()
		admitPrompt(d, 'one')
		editPrompt(d, 'intermediate')
		editPrompt(d, edit)
		const token = d.editToken
		settlePrompt(d, 'one', 'dispatched')
		assert.equal(d.text, edit)
		assert.equal(d.editToken, token)
		assert.equal(d.recovery, undefined)
	})
	test(`newer editor ownership makes rejection/acknowledgement a local choice: ${JSON.stringify(edit)}`, () => {
		const d = draft()
		admitPrompt(d, 'one')
		editPrompt(d, 'intermediate')
		editPrompt(d, edit)
		const token = d.editToken
		settlePrompt(d, 'one', 'rejected')
		assert.equal(d.text, edit)
		assert.equal(d.editToken, token)
		assert.equal(d.recovery?.state, 'choice')
		assert.equal(admitPrompt(d, 'two'), false)
	})
}
test('unknown remains awaiting until explicit settlement; acknowledgement shares exact rejection ownership rules', () => {
	const d = draft()
	admitPrompt(d, 'one')
	const recovery = d.recovery
	assert.equal(recovery?.state, 'awaiting')
	assert.equal(d.text, '')
	settlePrompt(d, 'wrong', 'rejected')
	assert.equal(d.recovery, recovery)
	settlePrompt(d, 'one', 'rejected')
	assert.equal(d.text, '  exact raw\r\ntext  ')
})
for (const restore of [false, true])
	test(`local choice ${restore ? 'restores' : 'keeps'} without effects and refuses stale slots`, () => {
		const d = draft()
		admitPrompt(d, 'one')
		editPrompt(d, 'newer')
		settlePrompt(d, 'one', 'rejected')
		const recovery = d.recovery
		assert.ok(recovery)
		assert.equal(choosePrompt(d, { ...recovery }, restore), false)
		assert.equal(choosePrompt(d, recovery, restore), true)
		assert.equal(d.text, restore ? '  exact raw\r\ntext  ' : 'newer')
		assert.equal(choosePrompt(d, recovery, restore), false)
		admitPrompt(d, 'two')
		assert.equal(choosePrompt(d, recovery, restore), false)
		assert.equal(d.recovery?.commandId, 'two')
	})
test('passive recovery survives unrelated Stop/Answer settlement and late original success', () => {
	const d = draft()
	admitPrompt(d, 'one')
	editPrompt(d, 'newer')
	settlePrompt(d, 'one', 'rejected')
	const recovery = d.recovery
	for (const id of ['interrupt', 'answer', 'one']) {
		settlePrompt(d, id, 'dispatched')
		settlePrompt(d, id, 'rejected')
		assert.equal(d.recovery, recovery)
	}
	assert.equal(d.text, 'newer')
})
