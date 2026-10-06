import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { appearance } from './appearance'
import { mountSidebarLayout } from './sidebar-layout'
import { mountSidebar } from './sidebar/SidebarRoot'
import { mountTerminalWorkspace } from './terminal-workspace'

// Apply the persisted theme/scale/font-size before anything paints or mounts.
appearance.init()

function el<T extends HTMLElement>(id: string): T {
	const node = document.getElementById(id)
	if (!node) throw new Error(`missing #${id}`)
	return node as T
}

const leftPane = el<HTMLElement>('left')

// ---------- native sidebar ----------
// The sidebar owns the daemon-connection signal (waiting card when
// unreachable; silence when connected) — the topbar carries no dot/branding.

mountSidebar(leftPane)

// The workspace receives the preload-captured bridge explicitly. ADR-0003's
// canonical ID-based placement module owns placement; runtime Tab/xterm objects
// are only ID-keyed projection adapters.
const workspace = mountTerminalWorkspace({ root: document, helm: window.helm, appearance })

// Width/visibility are renderer presentation preferences, never placement mutations.
mountSidebarLayout({ root: document, fitActive: () => workspace.fitActive() })

// Profile activation reloads this renderer after its bridge fence and buffer
// flush. The mount remains profile-token-bound through window.helm for its full
// lifetime; no other namespace can reuse it.
void workspace.ready
