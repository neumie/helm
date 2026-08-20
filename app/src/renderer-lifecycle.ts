export interface RendererFrameLike {
	isDestroyed(): boolean
	send(channel: string, ...args: unknown[]): void
}

export interface RendererContentsLike {
	isDestroyed(): boolean
	isCrashed?(): boolean
	readonly mainFrame: RendererFrameLike
}

export interface ReloadableRendererContents {
	isDestroyed(): boolean
	reload(): void
}

export interface RendererCrashDetails {
	reason: string
	exitCode: number
}

export interface RendererCrashRecoveryOptions {
	isQuitting(): boolean
	beforeReload(): void
	schedule?(callback: () => void): void
	now?(): number
	maxAttempts?: number
	windowMs?: number
}

export class RendererCrashRecovery {
	private attempts: number[] = []
	private scheduled = false

	constructor(private readonly options: RendererCrashRecoveryOptions) {}

	recover(contents: ReloadableRendererContents, _details: RendererCrashDetails): boolean {
		if (this.options.isQuitting() || contents.isDestroyed() || this.scheduled) return false
		const now = (this.options.now ?? Date.now)()
		const windowMs = this.options.windowMs ?? 60_000
		this.attempts = this.attempts.filter(attempt => now - attempt <= windowMs)
		if (this.attempts.length >= (this.options.maxAttempts ?? 3)) return false
		this.attempts.push(now)
		this.options.beforeReload()
		this.scheduled = true
		const schedule = this.options.schedule ?? (callback => setTimeout(callback, 0))
		schedule(() => {
			this.scheduled = false
			if (!this.options.isQuitting() && !contents.isDestroyed()) contents.reload()
		})
		return true
	}
}

/**
 * Deliver only through a currently-live main frame.
 *
 * WebContents survives renderer crashes and navigation gaps, so its own
 * isDestroyed() flag is insufficient. Electron's WebFrameMain.send catches a
 * disposed-frame exception internally and floods stderr instead of exposing it
 * to our caller; the frame therefore has to be rejected before send().
 */
export function sendToLiveRenderer(
	contents: RendererContentsLike | null | undefined,
	channel: string,
	...args: unknown[]
): boolean {
	let frame: RendererFrameLike
	try {
		if (!contents || contents.isDestroyed() || contents.isCrashed?.()) return false
		frame = contents.mainFrame
		if (frame.isDestroyed()) return false
	} catch {
		// A renderer may disappear while Electron resolves the current frame.
		return false
	}
	frame.send(channel, ...args)
	return true
}
