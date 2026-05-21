import { type TaskRecord, api } from './api'

const STATUS_COLORS: Record<string, string> = {
	queued: '#808080',
	processing: '#569cd6',
	completed: '#6a9955',
	failed: '#f14c4c',
	cancelled: '#cca700',
	skipped: '#5a5a5a',
}

const TIER_COLORS: Record<string, string> = {
	trivial: '#6a9955',
	simple: '#569cd6',
	complex: '#cca700',
	unclear: '#f14c4c',
}

export class VigilWidget {
	private shadow: ShadowRoot
	private container: HTMLDivElement
	private content: HTMLDivElement
	private expanded = false
	private currentTaskId: string | null = null
	private task: TaskRecord | null = null
	private loading = false
	private error: string | null = null
	private pollInterval: ReturnType<typeof setInterval> | null = null
	private projects: string[] = []

	constructor() {
		this.container = document.createElement('div')
		this.container.id = 'vigil-widget-host'
		this.shadow = this.container.attachShadow({ mode: 'closed' })

		const style = document.createElement('style')
		style.textContent = STYLES
		this.shadow.appendChild(style)

		this.content = document.createElement('div')
		this.shadow.appendChild(this.content)

		document.body.appendChild(this.container)
		this.loadProjects()
		this.render()
	}

	private async loadProjects() {
		try {
			const config = await api.config()
			this.projects = config.projects.map(p => p.slug)
		} catch (err) {
			console.warn('[vigil] Failed to load projects:', err)
			this.projects = []
			this.error = 'Cannot connect to Vigil'
		}
		this.render()
	}

	setTaskId(taskId: string | null) {
		if (taskId === this.currentTaskId) return
		this.currentTaskId = taskId
		this.error = null
		this.stopPolling()
		if (taskId) {
			this.lookup()
			this.startPolling()
		} else {
			this.task = null
			this.render()
		}
	}

	private startPolling() {
		this.pollInterval = setInterval(() => this.lookup(), 5000)
	}

	private stopPolling() {
		if (this.pollInterval) {
			clearInterval(this.pollInterval)
			this.pollInterval = null
		}
	}

	private async lookup() {
		if (!this.currentTaskId) return
		const taskId = this.currentTaskId
		try {
			const result = await api.findTask(taskId)
			if (this.currentTaskId !== taskId) return
			const changed =
				result?.status !== this.task?.status ||
				result?.tier !== this.task?.tier ||
				result?.prUrl !== this.task?.prUrl ||
				result?.id !== this.task?.id ||
				(result === null) !== (this.task === null)
			this.task = result
			const hadError = this.error !== null
			this.error = null
			if (changed || hadError) this.render()
		} catch (err) {
			if (this.currentTaskId !== taskId) return
			const msg = err instanceof Error ? err.message : 'Connection failed'
			if (msg !== this.error) {
				this.error = msg
				this.render()
			}
		}
	}

	private async action(fn: () => Promise<unknown>) {
		try {
			await fn()
			await this.lookup()
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Action failed'
			this.render()
		}
	}

	private async solve() {
		const taskId = this.currentTaskId
		if (!taskId || this.projects.length === 0) return
		await this.action(() => api.createTask(taskId))
	}

	destroy() {
		this.stopPolling()
		this.container.remove()
	}

	private render() {
		const html = this.expanded ? this.renderCard() : this.renderPill()
		if (this.content.innerHTML === html) return
		this.content.innerHTML = html
		this.bind()
	}

	private bind() {
		this.shadow.getElementById('pill')?.addEventListener('click', () => {
			this.expanded = true
			this.render()
		})
		this.shadow.getElementById('close')?.addEventListener('click', () => {
			this.expanded = false
			this.render()
		})
		this.shadow.getElementById('solve')?.addEventListener('click', () => this.solve())
		this.shadow.getElementById('start')?.addEventListener('click', () => this.action(() => api.resumeQueue()))
		this.shadow.getElementById('retry')?.addEventListener('click', () => {
			const t = this.task
			if (t) this.action(() => api.retry(t.id))
		})
		this.shadow.getElementById('cancel')?.addEventListener('click', () => {
			const t = this.task
			if (t) this.action(() => api.cancel(t.id))
		})
		this.shadow.getElementById('skip')?.addEventListener('click', () => {
			const t = this.task
			if (t) this.action(() => api.setStatus(t.id, 'skipped'))
		})
		this.shadow.getElementById('delete')?.addEventListener('click', async () => {
			const t = this.task
			if (!t) return
			await api.deleteTask(t.id)
			this.task = null
			this.expanded = false
			this.render()
		})
	}

	private renderPill(): string {
		const t = this.task

		if (!this.currentTaskId) {
			return `<div class="pill" id="pill"><span class="brand">V</span><span class="pill-text muted">No task</span></div>`
		}

		if (this.error && !t) {
			return `<div class="pill" id="pill"><span class="dot" style="background:#f14c4c"></span><span class="pill-text" style="color:#f14c4c">Error</span></div>`
		}

		if (this.loading) {
			return `<div class="pill" id="pill"><span class="brand">V</span><span class="pill-text muted">Loading...</span></div>`
		}

		if (!t) {
			if (this.projects.length > 0) {
				return `<div class="pill pill-action" id="solve"><span class="brand">V</span><span class="pill-text" style="color:#007acc">Solve</span></div>`
			}
			return `<div class="pill" id="pill"><span class="dot" style="background:#5a5a5a"></span><span class="pill-text muted">Not tracked</span></div>`
		}

		const sc = STATUS_COLORS[t.status] ?? '#808080'
		const glow = t.status === 'processing' ? `box-shadow:0 0 6px ${sc}` : ''

		return `<div class="pill" id="pill"><span class="dot" style="background:${sc};${glow}"></span><span class="pill-text">${t.status}</span></div>`
	}

	private renderCard(): string {
		const t = this.task

		if (this.error && !t) {
			return `
				<div class="card">
					<div class="card-header">
						<span class="brand">Vigil</span>
						<span class="close" id="close">&times;</span>
					</div>
					<div class="card-body">
						<div class="card-error">${this.error}</div>
						<div class="card-summary">Make sure Vigil is running.</div>
					</div>
				</div>`
		}

		if (!t) {
			return `
				<div class="card">
					<div class="card-header">
						<span class="brand">Vigil</span>
						<span class="close" id="close">&times;</span>
					</div>
					<div class="card-body">
						<div class="card-text">Task not tracked by Vigil.</div>
						${
							this.projects.length > 0
								? `<div class="card-actions"><button class="btn btn-primary" id="solve">Solve with Vigil</button></div>`
								: `<div class="card-summary">No projects configured.</div>`
						}
					</div>
				</div>`
		}

		const sc = STATUS_COLORS[t.status] ?? '#808080'
		const tc = t.tier ? (TIER_COLORS[t.tier] ?? '#808080') : null
		const glow = t.status === 'processing' ? `box-shadow:0 0 6px ${sc}` : ''

		let primary = ''
		let secondary = ''
		if (t.status === 'queued') {
			primary = `<button class="btn btn-primary" id="start">Start</button>`
			secondary = `<button class="btn btn-muted" id="skip">Skip</button>`
		} else if (t.status === 'processing') {
			primary = `<button class="btn btn-danger" id="cancel">Cancel</button>`
		} else {
			primary = `<button class="btn btn-primary" id="retry">Re-queue</button>`
			secondary = `<button class="btn btn-danger" id="delete">Delete</button>`
		}
		const actions = primary + secondary

		return `
			<div class="card">
				<div class="card-header">
					<div class="card-badges">
						<span class="dot" style="background:${sc};${glow}"></span>
						<span class="badge" style="color:${sc};background:${sc}20">${t.status}</span>
						${tc ? `<span class="badge" style="color:${tc};background:${tc}20">${t.tier}</span>` : ''}
					</div>
					<span class="close" id="close">&times;</span>
				</div>
				<div class="card-body">
					${t.solverSummary ? `<div class="card-summary">${t.solverSummary}</div>` : ''}
					${t.errorMessage ? `<div class="card-error">${t.errorMessage}</div>` : ''}
					${t.prUrl ? `<div class="card-pr"><a class="link" href="${t.prUrl}" target="_blank">${formatPr(t.prUrl)}</a></div>` : ''}
					<div class="card-actions">${actions}</div>
				</div>
			</div>`
	}
}

function formatPr(url: string): string {
	const m = url.match(/\/pull\/(\d+)/)
	return m ? `PR #${m[1]}` : 'Pull Request'
}

const STYLES = `
	* { box-sizing: border-box; margin: 0; padding: 0; }
	:host { all: initial; }

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
	.pill-action { border-color: #007acc40; }
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
	.pill-text.muted { color: #5a5a5a; }

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
	.btn-danger { border-color: #f14c4c40; color: #f14c4c; }
	.btn-muted { border-color: #5a5a5a; color: #808080; }
	.btn-accent { border-color: #007acc40; color: #007acc; }
`
