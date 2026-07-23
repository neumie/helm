import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `app.setName()` changes Electron's internal name only. An unpackaged
 * `electron .` run is still the downloaded Electron.app, whose Info.plist
 * supplies the native macOS application-menu label.
 */
export function macElectronBrandingPlan(projectDir, productName, platform = process.platform) {
	if (platform !== 'darwin') return null
	const infoPlist = join(projectDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist')
	return {
		infoPlist,
		commands: [
			['-replace', 'CFBundleDisplayName', '-string', productName, infoPlist],
			['-replace', 'CFBundleName', '-string', productName, infoPlist],
		],
	}
}

/**
 * @param {string} [projectDir]
 * @param {NodeJS.Platform} [platform]
 * @param {(file: string, args: readonly string[], options: { stdio: 'inherit' }) => unknown} [run]
 */
export function brandMacosElectron(projectDir = process.cwd(), platform = process.platform, run = execFileSync) {
	if (platform !== 'darwin') return false
	let packageDocument
	try {
		packageDocument = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))
	} catch (error) {
		throw new Error('Could not read app package.json for Electron branding', { cause: error })
	}
	const productName = packageDocument?.productName
	if (typeof productName !== 'string' || productName === '') throw new Error('app package.json must define productName')
	const plan = macElectronBrandingPlan(projectDir, productName, platform)
	for (const args of plan.commands) run('/usr/bin/plutil', args, { stdio: 'inherit' })
	return true
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) brandMacosElectron()
