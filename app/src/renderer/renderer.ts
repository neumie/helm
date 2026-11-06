import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { mountAgentDock } from './agent-dock-layout'
import { appearance } from './appearance'
import {
	clearLegacyLeftColumnPreference,
	focusActiveTerminal,
	memoryLeftColumnMode,
	mountLeftColumn,
	mountSignalsShortcut,
} from './left-column'
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

// ---------- left column: Signals, with Settings one click away (§3.25) ----------
// There is no task list. The Signals header's Settings button swaps the column to the sidebar
// app rooted at Settings (profiles, scheduled runs, appearance…); Back from its root returns.
// Every launch starts in Signals: the mode is not stored.

clearLegacyLeftColumnPreference(window.localStorage)
const signalsApi = window.helm.signals
const columnMode = memoryLeftColumnMode('signals')
const column = mountLeftColumn({
	left: leftPane,
	mode: columnMode,
	mountSignals: host =>
		mountSignals(host, {
			service: createSignalsService(signalsApi),
			dock: createDockService(window.helm.agentDock),
			onOpenSettings: () => columnMode.set('settings'),
			onLeave: () => focusActiveTerminal(document),
			mod: window.helm.platform === 'darwin' ? 'cmd' : 'ctrl',
		}),
	mountSettings: host => {
		mountSidebar(host, {
			base: 'settings',
			onExit: () => columnMode.set('signals'),
			shown: { get: () => columnMode.get() === 'settings', subscribe: columnMode.subscribe },
		})
		return undefined
	},
})

// The workspace receives the preload-captured bridge explicitly. ADR-0003's
// canonical ID-based placement module owns placement; runtime Tab/xterm objects
// are only ID-keyed projection adapters.
const workspace = mountTerminalWorkspace({ root: document, helm: window.helm, appearance })

// Width/visibility are renderer presentation preferences, never placement mutations. The daemon task
// watch follows a task list on screen, and this column has none, so it stays off; main polls Signals
// only while Signals is on screen.
const layout = mountSidebarLayout({
	root: document,
	fitActive: () => workspace.fitActive(),
	column: {
		mode: column.mode,
		subscribe: column.subscribe,
		setSignalsVisible: visible => signalsApi.setVisible(visible),
	},
})
mountSignalsShortcut({
	window,
	platform: window.helm.platform,
	column,
	showColumn: () => layout.show(),
	focusTerminal: () => focusActiveTerminal(document),
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
