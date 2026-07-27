import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(projectDir, 'native', 'window-zoom-guard')
const source = join(sourceDir, 'native-window-zoom-guard.mm')
const output = join(sourceDir, 'build', 'Release', 'helm_native_window_zoom_guard.node')
const force = process.argv.includes('--force')

if (
	process.platform === 'darwin' &&
	(force || !existsSync(output) || statSync(output).mtimeMs < statSync(source).mtimeMs)
) {
	const require = createRequire(import.meta.url)
	const electronVersion = require('electron/package.json').version
	const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js')
	execFileSync(
		process.execPath,
		[
			nodeGyp,
			'rebuild',
			'--directory',
			sourceDir,
			`--target=${electronVersion}`,
			`--arch=${process.arch}`,
			'--dist-url=https://electronjs.org/headers',
		],
		{ cwd: projectDir, stdio: 'inherit' },
	)
}
