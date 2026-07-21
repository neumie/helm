import type { MenuItemConstructorOptions } from 'electron'

export const APP_NAME = 'Helm'

/** Explicit macOS application menu: Electron's `appMenu` role can retain the
 * executable name in unpackaged runs, which exposes "Electron" in the menu bar. */
export function macApplicationMenu(): MenuItemConstructorOptions {
	return {
		label: APP_NAME,
		submenu: [
			{ role: 'about', label: `About ${APP_NAME}` },
			{ type: 'separator' },
			{ role: 'services' },
			{ type: 'separator' },
			{ role: 'hide', label: `Hide ${APP_NAME}` },
			{ role: 'hideOthers' },
			{ role: 'unhide' },
			{ type: 'separator' },
			{ role: 'quit', label: `Quit ${APP_NAME}` },
		],
	}
}

export default { APP_NAME, macApplicationMenu }
