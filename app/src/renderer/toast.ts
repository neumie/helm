// Toast notifications — compact bottom-right notices, stacking, helm design language.
// Reusable: any renderer feature can call showToast(); the soft-close Undo is
// just the first consumer. Styles live in styles.css under "toasts"; motion
// respects prefers-reduced-motion via the global media query there.

export interface ToastAction {
	label: string
	onClick: () => void
}

export interface ToastOptions {
	message: string
	/** Muted second line under the message. */
	detail?: string
	/** Optional action button (e.g. "Undo"). */
	action?: ToastAction
	/** Auto-dismiss after this many ms. Default 4000. */
	ttlMs?: number
	/** Show a quiet inset countdown hairline draining over ttlMs. */
	countdown?: boolean
}

export interface ToastHandle {
	dismiss(): void
}

const EXIT_MS = 160 // must cover the leave transition (120ms) plus slack

let container: HTMLDivElement | null = null

function ensureContainer(): HTMLDivElement {
	if (container?.isConnected) return container
	container = document.createElement('div')
	container.id = 'toasts'
	container.setAttribute('role', 'status')
	container.setAttribute('aria-live', 'polite')
	document.body.appendChild(container)
	return container
}

export function showToast(options: ToastOptions): ToastHandle {
	const host = ensureContainer()
	const ttl = options.ttlMs ?? 4000

	const el = document.createElement('div')
	el.className = 'toast'

	const body = document.createElement('div')
	body.className = 'toast-body'
	const message = document.createElement('div')
	message.className = 'toast-msg'
	message.textContent = options.message
	body.appendChild(message)
	if (options.detail) {
		const detail = document.createElement('div')
		detail.className = 'toast-detail'
		detail.textContent = options.detail
		body.appendChild(detail)
	}
	el.appendChild(body)

	if (options.action) {
		const button = document.createElement('button')
		button.className = 'toast-action'
		button.textContent = options.action.label
		button.addEventListener('click', event => {
			event.stopPropagation()
			options.action?.onClick()
		})
		el.appendChild(button)
	}

	let countdownEl: HTMLDivElement | null = null
	if (options.countdown) {
		countdownEl = document.createElement('div')
		countdownEl.className = 'toast-countdown'
		el.appendChild(countdownEl)
	}

	host.appendChild(el)

	let dismissed = false
	let ttlTimer: number | null = null

	const dismiss = (): void => {
		if (dismissed) return
		dismissed = true
		if (ttlTimer !== null) clearTimeout(ttlTimer)
		el.classList.remove('shown')
		el.classList.add('leaving')
		// transitionend is unreliable when the tab is hidden; a timer always fires.
		setTimeout(() => el.remove(), EXIT_MS)
	}

	// Double rAF: element must be laid out with its initial (hidden) styles
	// before the transition to .shown can animate.
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			if (dismissed) return
			el.classList.add('shown')
			if (countdownEl) {
				countdownEl.style.transition = `transform ${ttl}ms linear`
				countdownEl.style.transform = 'scaleX(0)'
			}
		})
	})

	ttlTimer = window.setTimeout(dismiss, ttl)
	return { dismiss }
}
