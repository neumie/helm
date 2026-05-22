import { createRoot, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { Widget } from './Widget'
import { WIDGET_STYLES } from './widget.styles'

function extractTaskId(): string | null {
	const params = new URLSearchParams(window.location.search)
	const path = window.location.pathname

	if (path.includes('project-detail')) {
		return params.get('task') ?? null
	}
	if (path.includes('task-detail')) {
		return params.get('id') ?? null
	}
	return params.get('task') ?? null
}

// Mount into shadow DOM
const host = document.createElement('div')
host.id = 'vigil-widget-host'
const shadow = host.attachShadow({ mode: 'closed' })

const style = document.createElement('style')
style.textContent = WIDGET_STYLES
shadow.appendChild(style)

const mountEl = document.createElement('div')
shadow.appendChild(mountEl)
document.body.appendChild(host)

// Create reactive root and mount
createRoot(() => {
	const [taskId, setTaskId] = createSignal<string | null>(extractTaskId())

	let lastUrl = ''
	function update() {
		const url = window.location.href
		if (url === lastUrl) return
		lastUrl = url
		setTaskId(extractTaskId())
	}

	window.addEventListener('popstate', update)
	window.addEventListener('hashchange', update)

	const origPushState = history.pushState.bind(history)
	const origReplaceState = history.replaceState.bind(history)

	history.pushState = (...args: Parameters<typeof history.pushState>) => {
		origPushState(...args)
		lastUrl = ''
		update()
	}

	history.replaceState = (...args: Parameters<typeof history.replaceState>) => {
		origReplaceState(...args)
		lastUrl = ''
		update()
	}

	setInterval(update, 1000)

	render(() => <Widget taskId={taskId} />, mountEl)
})
