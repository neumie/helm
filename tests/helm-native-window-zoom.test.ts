import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import nativeWindowZoomModule from '../app/src/native-window-zoom.ts'

type NativeWindowZoomModule = typeof import('../app/src/native-window-zoom.ts')
const { installNativeWindowZoomGuard } = nativeWindowZoomModule as NativeWindowZoomModule

const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')
const loader = readFileSync(new URL('../app/src/native-window-zoom.ts', import.meta.url), 'utf8')
const native = readFileSync(
	new URL('../app/native/window-zoom-guard/native-window-zoom-guard.mm', import.meta.url),
	'utf8',
)
const packageSource = readFileSync(new URL('../app/package.json', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../app/src/preload.ts', import.meta.url), 'utf8')
const renderer = readFileSync(new URL('../app/src/renderer/renderer.ts', import.meta.url), 'utf8')

test('native zoom guard is a no-op outside macOS', () => {
	assert.equal(installNativeWindowZoomGuard('linux'), false)
})

test('macOS loads the fixed allowlisted native addon', () => {
	assert.match(
		loader,
		/require\('\.\.\/native\/window-zoom-guard\/build\/Release\/helm_native_window_zoom_guard\.node'\)/,
	)
})

test('native addon guards tab-armed frame changes without owning all double-clicks', () => {
	assert.match(native, /NSClassFromString\(@"ElectronNSWindow"\)/)
	assert.match(native, /napi_value Arm[\s\S]*guardedWindowNumber = window\.windowNumber/)
	assert.match(native, /@selector\(setFrame:display:\)/)
	assert.match(native, /@selector\(setFrame:display:animate:\)/)
	assert.match(native, /!window\.inLiveResize/)
	assert.doesNotMatch(native, /@selector\(sendEvent:\)/)
	assert.doesNotMatch(native, /@selector\(zoom:\)/)
})

test('only an authenticated tab second press arms the native frame guard', () => {
	assert.match(
		main,
		/ipcMain\.on\('window:guard-tab-double-click',[\s\S]*event\.sender === window\.webContents[\s\S]*sessionIpcGate\.allows\(profileToken\)[\s\S]*guardNativeTabDoubleClick\(window\.getNativeWindowHandle\(\)\)/,
	)
	assert.match(preload, /ipcRenderer\.sendSync\('window:guard-tab-double-click', sessionProfileToken\)/)
	assert.match(
		renderer,
		/if \(event\.detail < 2\) return\s+helm\.tabs\.guardNativeDoubleClick\(\)\s+event\.preventDefault\(\)/,
	)
	assert.equal(renderer.match(/guardNativeDoubleClick\(\)/g)?.length, 1)
})

test('native guard installs before any BrowserWindow is constructed', () => {
	const ready = main.indexOf('void app.whenReady().then')
	const install = main.indexOf('installNativeWindowZoomGuard()', ready)
	const create = main.indexOf('createWindow()', ready)
	assert.ok(ready >= 0 && install > ready && create > install)
})

test('desktop build and install rebuild the native addon', () => {
	assert.match(packageSource, /"build": "[^"]*rebuild-native-window-zoom-guard\.mjs/)
	assert.match(packageSource, /"postinstall": "[^"]*rebuild-native-window-zoom-guard\.mjs --force/)
})

test('application menu exposes no zoom or fullscreen command', () => {
	assert.doesNotMatch(main, /role: 'zoom'/)
	assert.doesNotMatch(main, /role: 'togglefullscreen'/)
})
