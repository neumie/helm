import { createIconButton } from './icon-button'
import { ICONS, iconNode } from './icons/icons'
import type { LeftColumnMode } from './left-column'

/**
 * What the column currently holds (left-column.ts: Signals or Settings). Without it the column is
 * the list-rooted task sidebar, as in hosts that mount only that (fixtures, stories).
 */
export interface SidebarLayoutColumn {
	mode(): LeftColumnMode
	subscribe(listener: () => void): () => void
	/** Signals is on screen: column shown, in Signals mode, and the window visible. */
	setSignalsVisible?(visible: boolean): void
}

/**
 * Left-column presentation only: no session, placement or process authority. The column's width and
 * visibility are shared by every surface; "the task sidebar is visible" (`data-sidebar-hidden`, the
 * `helm-sidebar-visibility` event and the daemon task watch) means a task list is on screen, which
 * only a column-less host (fixtures, stories) has. Production's Signals/Settings column keeps it off.
 */
export function mountSidebarLayout({
	root,
	fitActive,
	column,
}: {
	root: Document | HTMLElement
	fitActive: () => void
	column?: SidebarLayoutColumn
}): { dispose(): void; show(): void } {
	const host = root instanceof Document ? root.documentElement : root
	const ownerDocument = host.ownerDocument
	const ownerWindow = ownerDocument.defaultView
	const left = root.querySelector<HTMLElement>('#left')
	const divider = root.querySelector<HTMLElement>('#divider')
	const chrome = root.querySelector<HTMLElement>('.topbar-left')
	if (!ownerWindow || !left || !divider || !chrome) throw new Error('Missing task-sidebar layout shell')
	const read = (key: string): string | null => {
		try {
			return ownerWindow.localStorage.getItem(key)
		} catch {
			return null
		}
	}
	const save = (key: string, value: string): void => {
		try {
			ownerWindow.localStorage.setItem(key, value)
		} catch {
			// Presentation still works when storage is unavailable.
		}
	}
	const storedWidth = Number(read('helm.leftWidth'))
	let preferredWidth = Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : 340
	let hidden = read('helm.sidebarHidden') === 'true'
	let publishedHidden: boolean | null = null
	let publishedSignals: boolean | null = null
	let disposed = false
	let stopDrag: (() => void) | null = null
	const clamp = (width: number): number => Math.min(Math.max(width, 300), 420, Math.floor(ownerWindow.innerWidth * 0.6))
	const toggle = createIconButton({ label: 'Hide task sidebar', glyph: '', className: 'sidebar-toggle' })
	toggle.id = 'sidebar-toggle'
	toggle.setAttribute('aria-controls', 'left')
	toggle.replaceChildren(iconNode(ICONS.sidebarToggle, ownerDocument))
	const dragSpace = ownerDocument.createElement('div')
	dragSpace.className = 'topbar-left-drag-space'
	dragSpace.setAttribute('aria-hidden', 'true')
	chrome.removeAttribute('aria-hidden')
	chrome.append(toggle, dragSpace)
	const properties = ['--left-width', '--sidebar-column-width', '--sidebar-divider-width', '--sidebar-header-width']
	const previousProperties = properties.map(name => [name, host.style.getPropertyValue(name)] as const)
	const mode = (): LeftColumnMode | 'tasks' => column?.mode() ?? 'tasks'
	const publishSignals = (): void => {
		const visible = !disposed && !hidden && mode() === 'signals' && ownerDocument.visibilityState !== 'hidden'
		if (publishedSignals === visible) return
		publishedSignals = visible
		column?.setSignalsVisible?.(visible)
	}
	const apply = (): void => {
		const width = `${clamp(preferredWidth)}px`
		host.style.setProperty('--left-width', width)
		host.style.setProperty('--sidebar-column-width', hidden ? '0px' : width)
		host.style.setProperty('--sidebar-divider-width', hidden ? '0px' : '1px')
		host.style.setProperty('--sidebar-header-width', hidden ? '124px' : width)
		// Move owned focus before hiding its subtree (Chromium accessibility safety).
		if (hidden && (left.contains(ownerDocument.activeElement) || divider === ownerDocument.activeElement))
			toggle.focus()
		left.inert = hidden
		left.hidden = hidden
		divider.hidden = hidden
		const tasksHidden = hidden || mode() !== 'tasks'
		host.dataset.sidebarHidden = tasksHidden ? 'true' : 'false'
		if (publishedHidden !== tasksHidden) {
			publishedHidden = tasksHidden
			ownerWindow.dispatchEvent(new CustomEvent('helm-sidebar-visibility', { detail: { hidden: tasksHidden } }))
			const daemon = (
				ownerWindow as Window & { helm?: { daemon?: { pollWatch?: (watching: boolean) => Promise<unknown> } } }
			).helm?.daemon
			void daemon?.pollWatch?.(!tasksHidden)?.catch(() => undefined)
		}
		publishSignals()
		const current = mode()
		const name = current === 'tasks' ? 'task sidebar' : current === 'settings' ? 'Settings' : 'Signals'
		const label = hidden ? `Show ${name}` : `Hide ${name}`
		toggle.setAttribute('aria-label', label)
		toggle.title = label
		toggle.setAttribute('aria-expanded', String(!hidden))
	}
	const onToggle = (): void => {
		stopDrag?.()
		hidden = !hidden
		apply()
		save('helm.sidebarHidden', String(hidden))
		fitActive()
	}
	const onResize = (): void => {
		apply()
	}
	const onDown = (down: PointerEvent): void => {
		if (hidden || down.button !== 0 || stopDrag) return
		divider.setPointerCapture(down.pointerId)
		ownerDocument.body.classList.add('dragging')
		const move = (event: PointerEvent): void => {
			if (event.pointerId !== down.pointerId) return
			preferredWidth = clamp(event.clientX - host.getBoundingClientRect().left)
			apply()
		}
		const stop = (): void => {
			divider.removeEventListener('pointermove', move)
			divider.removeEventListener('pointerup', stop)
			divider.removeEventListener('pointercancel', stop)
			divider.removeEventListener('lostpointercapture', stop)
			stopDrag = null
			ownerDocument.body.classList.remove('dragging')
			if (divider.hasPointerCapture(down.pointerId)) divider.releasePointerCapture(down.pointerId)
			if (!disposed) {
				save('helm.leftWidth', String(preferredWidth))
				fitActive()
			}
		}
		stopDrag = stop
		divider.addEventListener('pointermove', move)
		divider.addEventListener('pointerup', stop)
		divider.addEventListener('pointercancel', stop)
		divider.addEventListener('lostpointercapture', stop)
	}
	toggle.addEventListener('click', onToggle)
	divider.addEventListener('pointerdown', onDown)
	ownerWindow.addEventListener('resize', onResize)
	ownerDocument.addEventListener('visibilitychange', publishSignals)
	const unsubscribeColumn = column?.subscribe(apply)
	apply()
	return {
		show(): void {
			if (disposed || !hidden) return
			onToggle()
		},
		dispose(): void {
			if (disposed) return
			disposed = true
			hidden = true
			unsubscribeColumn?.()
			ownerDocument.removeEventListener('visibilitychange', publishSignals)
			publishSignals()
			if (publishedHidden !== true) {
				publishedHidden = true
				ownerWindow.dispatchEvent(new CustomEvent('helm-sidebar-visibility', { detail: { hidden: true } }))
				const daemon = (
					ownerWindow as Window & { helm?: { daemon?: { pollWatch?: (watching: boolean) => Promise<unknown> } } }
				).helm?.daemon
				void daemon?.pollWatch?.(false)?.catch(() => undefined)
			}
			stopDrag?.()
			toggle.removeEventListener('click', onToggle)
			divider.removeEventListener('pointerdown', onDown)
			ownerWindow.removeEventListener('resize', onResize)
			toggle.remove()
			dragSpace.remove()
			left.inert = false
			left.hidden = false
			divider.hidden = false
			for (const [name, value] of previousProperties) {
				if (value) host.style.setProperty(name, value)
				else host.style.removeProperty(name)
			}
		},
	}
}
