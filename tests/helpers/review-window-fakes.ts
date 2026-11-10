// Fake Electron BaseWindow / WebContentsView for DocumentReviewWindows tests (docs/plans/helm-open/spec.md,
// Per-view access keys). Only what window.ts touches, with Electron's semantics that matter here: a container's
// `close` is cancellable and emits `closed`, and closing a container never destroys its views' webContents.
import { EventEmitter } from 'node:events'

export interface FixtureFrame {
	dead: boolean
	isDestroyed(): boolean
	send(channel: string, ...args: unknown[]): void
}
let nextContentsId = 0
export class FixtureContents extends EventEmitter {
	readonly id = ++nextContentsId
	dead = false
	/** Channels delivered through the live main frame, in order. */
	readonly sent: string[] = []
	focusCount = 0
	/** Test switch: the view's undocked DevTools window has focus. */
	devToolsFocused = false
	readonly loads: string[] = []
	/** Test switch: make the next loadURL reject. */
	failLoad = false
	mainFrame: FixtureFrame = this.frame()
	private frame(): FixtureFrame {
		const sent = this.sent
		return {
			dead: false,
			isDestroyed() {
				return this.dead
			},
			send(channel: string) {
				if (!this.dead) sent.push(channel)
			},
		}
	}
	isDestroyed() {
		return this.dead
	}
	isDevToolsFocused() {
		return !this.dead && this.devToolsFocused
	}
	setWindowOpenHandler() {}
	async loadURL(url: string) {
		this.loads.push(url)
		if (this.failLoad) throw new Error('ERR_FAILED')
	}
	focus() {
		this.focusCount++
	}
	/** Test switch: close() ends the page on a later task, as Electron's WebContents.close() does. */
	deferDestroy = false
	private closing = false
	close() {
		if (this.dead || this.closing) return
		if (this.deferDestroy) {
			this.closing = true
			setImmediate(() => this.destroyNow())
			return
		}
		this.destroyNow()
	}
	private destroyNow() {
		if (this.dead) return
		this.dead = true
		this.mainFrame.dead = true
		this.emit('destroyed')
	}
	/** A renderer reload: the old main frame (and every event that captured it) is obsolete. */
	reloadFrame() {
		this.mainFrame.dead = true
		this.mainFrame = this.frame()
	}
}
export class FixtureView {
	readonly webContents = new FixtureContents()
	visible = true
	backgroundColor = ''
	bounds = { x: 0, y: 0, width: 0, height: 0 }
	setBounds(bounds: { x: number; y: number; width: number; height: number }) {
		this.bounds = bounds
	}
	setVisible(visible: boolean) {
		this.visible = visible
	}
	setBackgroundColor(color: string) {
		this.backgroundColor = color
	}
}
export const createdWindows: FixtureContainer[] = []
export class FixtureContainer extends EventEmitter {
	static focusedWindow: FixtureContainer | null = null
	static getFocusedWindow() {
		return FixtureContainer.focusedWindow && !FixtureContainer.focusedWindow.dead
			? FixtureContainer.focusedWindow
			: null
	}
	dead = false
	readonly calls: string[] = []
	title: string
	readonly backgroundColor: string
	readonly children: FixtureView[] = []
	readonly contentView = {
		addChildView: (view: FixtureView) => {
			if (this.children.includes(view)) throw new Error('A view is added twice.')
			this.children.push(view)
		},
		removeChildView: (view: FixtureView) => {
			const index = this.children.indexOf(view)
			if (index >= 0) this.children.splice(index, 1)
		},
	}
	private lone: FixtureContents | null = null
	constructor(options?: { title?: string; backgroundColor?: string }) {
		super()
		this.title = options?.title ?? ''
		this.backgroundColor = options?.backgroundColor ?? '#FFFFFF'
		createdWindows.push(this)
	}
	/** Test convenience: the first view's webContents (a lone one for a container with no view, e.g. a foreign sender). */
	get webContents(): FixtureContents {
		const first = this.children[0]?.webContents
		if (first) return first
		this.lone ??= new FixtureContents()
		return this.lone
	}
	reloadFrame() {
		this.webContents.reloadFrame()
	}
	isDestroyed() {
		return this.dead
	}
	show() {
		this.calls.push('show')
	}
	showInactive() {
		this.calls.push('showInactive')
	}
	focus() {
		this.calls.push('focus')
		FixtureContainer.focusedWindow = this
		this.emit('focus')
	}
	getBackgroundColor() {
		return this.backgroundColor
	}
	setTitle(title: string) {
		this.title = title
	}
	getContentBounds() {
		return { x: 0, y: 0, width: 1180, height: 800 }
	}
	close() {
		if (this.dead) return true
		let prevented = false
		this.emit('close', {
			preventDefault() {
				prevented = true
			},
		})
		if (prevented) return false
		this.destroy()
		return true
	}
	destroy() {
		if (this.dead) return
		this.dead = true
		if (FixtureContainer.focusedWindow === this) FixtureContainer.focusedWindow = null
		this.emit('closed')
	}
}
