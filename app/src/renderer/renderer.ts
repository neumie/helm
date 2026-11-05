import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { mountAgentDock } from './agent-dock-layout'
import { appearance } from './appearance'
import { focusActiveTerminal, mountDeepLinkReveal, mountLeftColumn, mountSignalsShortcut } from './left-column'
import { mountSidebarLayout } from './sidebar-layout'
import { mountSidebar } from './sidebar/SidebarRoot'
import { mountSignals } from './signals/Signals'
import { createDockService, createSignalsService } from './signals/services'
import { mountTerminalWorkspace } from './terminal-workspace'

// Apply the persisted theme/scale/font-size before anything paints or mounts.
appearance.init()

function el<T extends HTMLElement>(id: string): T {
	const node = document.getElementById(id)
	if (!node) throw new Error(`missing #${id}`)
	return node as T
}

const leftPane = el<HTMLElement>('left')

// ---------- left column: Signals (default) or the native task sidebar ----------
// The task sidebar owns the daemon-connection signal (waiting card when
// unreachable; silence when connected) — the topbar carries no dot/branding.
// Both surfaces stay mounted; an older preload without the Signals bridge keeps Tasks only.

const signalsApi = window.helm.signals
const column = mountLeftColumn({
	left: leftPane,
	mountTasks: host => {
		mountSidebar(host)
		return undefined
	},
	...(signalsApi
		? {
				mountSignals: (host: HTMLElement) =>
					mountSignals(host, {
						service: createSignalsService(signalsApi),
						dock: createDockService(window.helm.agentDock),
						onShowTasks: () => column.setMode('tasks'),
						onLeave: () => focusActiveTerminal(document),
						mod: window.helm.platform === 'darwin' ? 'cmd' : 'ctrl',
					}),
			}
		: {}),
})

// The workspace receives the preload-captured bridge explicitly. ADR-0003's
// canonical ID-based placement module owns placement; runtime Tab/xterm objects
// are only ID-keyed projection adapters.
const workspace = mountTerminalWorkspace({ root: document, helm: window.helm, appearance })

// Width/visibility are renderer presentation preferences, never placement mutations. The daemon task
// watch follows the task sidebar only; main polls Signals only while Signals is on screen.
const layout = mountSidebarLayout({
	root: document,
	fitActive: () => workspace.fitActive(),
	column: {
		mode: column.mode,
		subscribe: column.subscribe,
		setSignalsVisible: visible => signalsApi?.setVisible(visible),
	},
})
mountSignalsShortcut({
	window,
	platform: window.helm.platform,
	column,
	showColumn: () => layout.show(),
	focusTerminal: () => focusActiveTerminal(document),
})
// helm://item/<id> lands in the task sidebar: the column switches to Tasks and shows, so a deep
// link never opens behind Signals (the sidebar's own listener resets its stack to list → detail).
mountDeepLinkReveal({
	onOpenItem: listener => window.helm.nav.onOpenItem(listener),
	column,
	showColumn: () => layout.show(),
})

// Read-only Okena Claude agent dock. An older preload without the bridge leaves
// #agent-dock hidden and the terminal pane full height.
const agentDock = window.helm.agentDock
if (agentDock)
	mountAgentDock({
		root: document,
		fitActive: () => workspace.fitActive(),
		api: agentDock,
		platform: window.helm.platform,
		revealTerminal: sessionId => workspace.revealTerminal(sessionId),
	})

// Profile activation reloads this renderer after its bridge fence and buffer
// flush. The mount remains profile-token-bound through window.helm for its full
// lifetime; no other namespace can reuse it.
void workspace.ready
