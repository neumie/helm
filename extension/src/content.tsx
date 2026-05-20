import { createSignal, createRoot } from 'solid-js'
import { render } from 'solid-js/web'
import { Widget } from './Widget'

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

// Styles
const STYLES = `
	* { box-sizing: border-box; margin: 0; padding: 0; }

	.pill {
		position: fixed;
		bottom: 20px;
		left: 20px;
		z-index: 999999;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		background: #252526;
		border: 1px solid #3c3c3c;
		border-radius: 16px;
		padding: 5px 12px 5px 8px;
		cursor: pointer;
		box-shadow: 0 2px 8px rgba(0,0,0,0.3);
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		transition: background 150ms, transform 150ms;
	}
	.pill:hover { background: #2d2d2d; transform: translateY(-1px); }
	.pill-action { border-color: rgba(0, 122, 204, 0.4); }
	.pill-action:hover { border-color: #007acc; }

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.brand {
		color: #007acc;
		font-size: 11px;
		font-weight: 700;
		flex-shrink: 0;
	}

	.pill-text {
		color: #ccc;
		font-size: 11px;
		font-weight: 500;
	}
	.muted { color: #5a5a5a; }

	.card {
		position: fixed;
		bottom: 20px;
		left: 20px;
		z-index: 999999;
		width: 300px;
		background: #252526;
		border: 1px solid #3c3c3c;
		border-radius: 10px;
		box-shadow: 0 4px 20px rgba(0,0,0,0.5);
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		overflow: hidden;
		animation: slideUp 150ms ease-out;
	}

	@keyframes slideUp {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
		border-bottom: 1px solid #3c3c3c;
	}

	.card-badges {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.badge {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 1px 6px;
		border-radius: 3px;
	}

	.card-header-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.header-link {
		color: #569cd6;
		text-decoration: none;
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.header-link:hover { text-decoration: underline; }

	.close {
		color: #5a5a5a;
		font-size: 16px;
		cursor: pointer;
		line-height: 1;
		padding: 0 2px;
	}
	.close:hover { color: #ccc; }

	.card-body { padding: 12px 14px; }

	.card-text {
		font-size: 12px;
		color: #d4d4d4;
		line-height: 1.4;
		margin-bottom: 10px;
	}

	.card-summary {
		font-size: 11px;
		color: #9d9d9d;
		line-height: 1.5;
		margin-bottom: 10px;
	}

	.card-error {
		font-size: 11px;
		color: #f14c4c;
		margin-bottom: 10px;
	}

	.card-pr { margin-bottom: 10px; }

	.card-plan {
		font-size: 11px;
		color: #9d9d9d;
		line-height: 1.5;
		margin-bottom: 10px;
		padding: 8px;
		background: #1e1e1e;
		border-left: 2px solid #569cd6;
		border-radius: 2px;
	}
	.card-plan-line { margin-bottom: 4px; }
	.card-plan-line:last-child { margin-bottom: 0; }
	.card-plan code {
		background: #2d2d2d;
		padding: 1px 4px;
		border-radius: 2px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 10px;
		color: #d4d4d4;
	}

	.link {
		color: #569cd6;
		text-decoration: none;
		font-size: 11px;
	}
	.link:hover { text-decoration: underline; }

	.card-actions {
		display: flex;
		gap: 6px;
	}

	.btn {
		padding: 4px 10px;
		border: 1px solid;
		border-radius: 3px;
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		background: none;
		font-family: inherit;
		transition: background 150ms;
	}
	.btn:hover { background: #3c3c3c; }
	.btn-primary { border-color: #007acc; color: #007acc; }
	.btn-danger { border-color: rgba(241, 76, 76, 0.4); color: #f14c4c; }
	.btn-muted { border-color: #5a5a5a; color: #808080; }
`

// Mount into shadow DOM
const host = document.createElement('div')
host.id = 'vigil-widget-host'
const shadow = host.attachShadow({ mode: 'closed' })

const style = document.createElement('style')
style.textContent = STYLES
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
