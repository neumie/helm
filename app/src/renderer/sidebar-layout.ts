import { createIconButton } from './icon-button'

/** Task-pane presentation only: no session, placement or process authority. */
export function mountSidebarLayout({
	root,
	fitActive,
}: {
	root: Document | HTMLElement
	fitActive: () => void
}): { dispose(): void } {
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
	let disposed = false
	let stopDrag: (() => void) | null = null
	const clamp = (width: number): number => Math.min(Math.max(width, 300), 420, Math.floor(ownerWindow.innerWidth * 0.6))
	const toggle = createIconButton({ label: 'Hide task sidebar', glyph: '', className: 'sidebar-toggle' })
	toggle.id = 'sidebar-toggle'
	toggle.setAttribute('aria-controls', 'left')
	const svg = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg')
	svg.setAttribute('width', '16')
	svg.setAttribute('height', '16')
	svg.setAttribute('viewBox', '0 0 20 20')
	svg.setAttribute('fill', 'none')
	svg.setAttribute('stroke', 'currentColor')
	svg.setAttribute('stroke-width', '1.5')
	svg.setAttribute('aria-hidden', 'true')
	const frame = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect')
	frame.setAttribute('x', '3')
	frame.setAttribute('y', '4')
	frame.setAttribute('width', '14')
	frame.setAttribute('height', '12')
	frame.setAttribute('rx', '2')
	const edge = ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path')
	edge.setAttribute('d', 'M8 4v12')
	svg.append(frame, edge)
	toggle.replaceChildren(svg)
	const dragSpace = ownerDocument.createElement('div')
	dragSpace.className = 'topbar-left-drag-space'
	dragSpace.setAttribute('aria-hidden', 'true')
	chrome.removeAttribute('aria-hidden')
	chrome.append(toggle, dragSpace)
	const properties = ['--left-width', '--sidebar-column-width', '--sidebar-divider-width', '--sidebar-header-width']
	const previousProperties = properties.map(name => [name, host.style.getPropertyValue(name)] as const)
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
		const label = hidden ? 'Show task sidebar' : 'Hide task sidebar'
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
	apply()
	return {
		dispose(): void {
			if (disposed) return
			disposed = true
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
