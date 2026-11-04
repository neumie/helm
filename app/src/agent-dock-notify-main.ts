// Electron side of the dock's background notifications (agent-dock/notifier.ts holds the policy):
// Electron's Notification, app.dock's badge and the main window, passed in structurally so this
// stays testable under node with a mocked Notification class and dock (no Electron import).

import type { AgentDockNotice, AgentDockNotifierOptions } from './agent-dock/notifier'

/** The slice of Electron's Notification used here. */
export interface NativeNotification {
	on(event: 'click' | 'close', listener: () => void): unknown
	show(): void
	close(): void
}

export interface NativeNotificationClass {
	new (options: { title: string; subtitle?: string; body: string; silent?: boolean }): NativeNotification
	isSupported(): boolean
}

/** The slice of BrowserWindow the foreground check reads. */
export interface NotifyWindow {
	isDestroyed(): boolean
	isVisible(): boolean
	isMinimized(): boolean
	isFocused(): boolean
}

export interface AgentDockNotifyMainOptions {
	Notification: NativeNotificationClass
	/** `app.dock` (macOS only; undefined elsewhere: no badge). */
	dock?: { setBadge(text: string): void }
	mainWindow(): NotifyWindow | null
	/** Bring the main window forward (restore if minimized, show if hidden) — main.ts focusAndRestoreMainWindow. */
	focusAndRestore(): void
	/** Push AGENT_DOCK_IPC.openItem to the current main renderer with its profile token. */
	sendOpenItem(itemId: number | null): void
	/** Side-by-side instances keep their 'dev' badge while nothing waits. */
	idleBadge?: string
}

export function agentDockNotifyOptions(options: AgentDockNotifyMainOptions): AgentDockNotifierOptions {
	// Electron drops a notification's click handler once nothing references it: hold every shown one until it closes.
	const shown = new Set<NativeNotification>()
	return {
		idleBadge: options.idleBadge ?? '',
		setBadge: text => options.dock?.setBadge(text),
		isForeground: () => {
			const win = options.mainWindow()
			return win !== null && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()
		},
		show: (notice: AgentDockNotice, onClick: () => void) => {
			if (!options.Notification.isSupported()) return null
			const native = new options.Notification({
				title: notice.title,
				...(notice.subtitle ? { subtitle: notice.subtitle } : {}),
				body: notice.body,
				silent: notice.silent,
			})
			shown.add(native)
			native.on('click', () => {
				shown.delete(native)
				onClick()
			})
			native.on('close', () => shown.delete(native))
			native.show()
			return {
				close: () => {
					shown.delete(native)
					native.close()
				},
			}
		},
		openItem: itemId => {
			options.focusAndRestore()
			options.sendOpenItem(itemId)
		},
	}
}
