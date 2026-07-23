export interface ProfileWindowWebContents {
	isDestroyed(): boolean
	isLoading(): boolean
	reload(): void
	once(event: 'did-finish-load' | 'did-fail-load', listener: (...args: any[]) => void): void
	removeListener(event: 'did-finish-load' | 'did-fail-load', listener: (...args: any[]) => void): void
}

export interface ProfileWindowLike {
	isDestroyed(): boolean
	webContents: ProfileWindowWebContents
	once(event: 'closed', listener: () => void): void
	removeListener(event: 'closed', listener: () => void): void
}

export interface ProfileWindowReloadOptions {
	existing: ProfileWindowLike | null
	createWindow(): ProfileWindowLike
	epoch: number
	currentEpoch(): number | null
	onLoaded(): void
	timeoutMs: number
	setTimer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>
	clearTimer?(timer: ReturnType<typeof setTimeout>): void
}

/**
 * Wait for the specific renderer load initiated by a profile commit. Kept
 * Electron-free so failed loads, closes, timeouts, and create-vs-reload can be
 * verified without launching a desktop process.
 */
export function reloadOrCreateProfileWindow(options: ProfileWindowReloadOptions): Promise<void> {
	const existing = options.existing && !options.existing.isDestroyed() ? options.existing : null
	const win = existing ?? options.createWindow()
	const setTimer = options.setTimer ?? setTimeout
	const clearTimer = options.clearTimer ?? clearTimeout
	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (error?: Error): void => {
			if (settled) return
			settled = true
			clearTimer(timeout)
			win.webContents.removeListener('did-finish-load', onLoaded)
			win.webContents.removeListener('did-fail-load', onFailed)
			win.removeListener('closed', onClosed)
			if (error) reject(error)
			else resolve()
		}
		const onLoaded = (): void => {
			if (options.currentEpoch() !== options.epoch || win.isDestroyed()) return
			options.onLoaded()
			finish()
		}
		const onFailed = (_event: unknown, errorCode: number, errorDescription: string): void =>
			finish(new Error(`Profile renderer load failed (${errorCode}): ${errorDescription}`))
		const onClosed = (): void => finish(new Error('Profile renderer window closed during reload.'))
		const timeout = setTimer(() => finish(new Error('Timed out waiting for profile renderer reload.')), options.timeoutMs)
		win.webContents.once('did-finish-load', onLoaded)
		win.webContents.once('did-fail-load', onFailed)
		win.once('closed', onClosed)
		if (existing) win.webContents.reload()
	})
}
