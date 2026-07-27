interface NativeWindowZoomAddon {
	install(): boolean
	arm(nativeWindowHandle: Buffer): boolean
}

let addon: NativeWindowZoomAddon | null = null

function loadAddon(): NativeWindowZoomAddon {
	addon ??=
		require('../native/window-zoom-guard/build/Release/helm_native_window_zoom_guard.node') as NativeWindowZoomAddon
	return addon
}

export function installNativeWindowZoomGuard(platform: NodeJS.Platform = process.platform): boolean {
	if (platform !== 'darwin') return false
	if (loadAddon().install() !== true) throw new Error('Native macOS window zoom guard did not install')
	return true
}

export function guardNativeTabDoubleClick(nativeWindowHandle: Buffer): boolean {
	if (process.platform !== 'darwin') return false
	return loadAddon().arm(nativeWindowHandle)
}

export default { guardNativeTabDoubleClick, installNativeWindowZoomGuard }
