import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { brandMacosElectron, macElectronBrandingPlan } from '../app/scripts/brand-macos-electron.mjs'

test('unpackaged macOS Electron branding updates the bundle display-name keys', () => {
	const plan = macElectronBrandingPlan('/workspace/helm/app', 'Helm', 'darwin')
	assert.ok(plan)
	assert.equal(plan.infoPlist, '/workspace/helm/app/node_modules/electron/dist/Electron.app/Contents/Info.plist')
	assert.deepEqual(plan.commands, [
		['-replace', 'CFBundleDisplayName', '-string', 'Helm', plan.infoPlist],
		['-replace', 'CFBundleName', '-string', 'Helm', plan.infoPlist],
	])
})

test('Electron bundle branding is a no-op outside macOS', () => {
	assert.equal(macElectronBrandingPlan('/workspace/helm/app', 'Helm', 'linux'), null)
})

test('macOS Electron branding reads productName and executes the planned plist mutations', () => {
	const projectDir = mkdtempSync(join(tmpdir(), 'helm-electron-branding-'))
	const calls: Array<{ file: string; args: string[] }> = []
	try {
		writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ productName: 'Helm' }))
		const branded = brandMacosElectron(
			projectDir,
			'darwin',
			(file: string, args: readonly string[], _options: { stdio: 'inherit' }) => {
				calls.push({ file, args: [...args] })
			},
		)
		assert.equal(branded, true)
		assert.deepEqual(
			calls.map(call => [call.file, ...call.args.slice(0, 4)]),
			[
				['/usr/bin/plutil', '-replace', 'CFBundleDisplayName', '-string', 'Helm'],
				['/usr/bin/plutil', '-replace', 'CFBundleName', '-string', 'Helm'],
			],
		)
	} finally {
		rmSync(projectDir, { recursive: true, force: true })
	}
})
