import assert from 'node:assert/strict'
import test from 'node:test'
import menuModule from '../app/src/app-menu.ts'

const { APP_NAME, macApplicationMenu } = menuModule

test('macOS application menu consistently identifies Helm', () => {
	const menu = macApplicationMenu()
	assert.equal(APP_NAME, 'Helm')
	assert.equal(menu.label, 'Helm')
	const labels = (menu.submenu as Array<{ label?: string }>).flatMap(item => (item.label ? [item.label] : []))
	assert.ok(labels.includes('About Helm'))
	assert.ok(labels.includes('Hide Helm'))
	assert.ok(labels.includes('Quit Helm'))
	assert.equal(
		labels.some(label => label.includes('Electron')),
		false,
	)
})
