export interface RunContextDrain {
	drained: Promise<void>
	release(): void
}

export type RunContextDrainResult = { ok: false } | ({ ok: true } & RunContextDrain)

interface EditorBinding {
	itemId: string
	isDestroyed(): boolean
}

/**
 * Electron-free admission, sender binding, and drain policy for Run Context
 * operations. Window creation and profile-token validation remain elsewhere.
 */
export class RunContextAccess {
	private readonly editors = new Map<number, EditorBinding>()
	private readonly inFlight = new Set<Promise<unknown>>()
	private nextLease = 0
	private activeLease: number | null = null

	constructor(private readonly canOpen: () => boolean = () => true) {}

	registerEditor(senderId: number, itemId: string, isDestroyed: () => boolean): void {
		this.editors.set(senderId, { itemId, isDestroyed })
	}

	unregisterEditor(senderId: number): void {
		this.editors.delete(senderId)
	}

	itemIdFor(senderId: number): string {
		const editor = this.editors.get(senderId)
		if (!editor || editor.isDestroyed()) throw new Error('Run context editor is not registered')
		return editor.itemId
	}

	runForEditor<T>(senderId: number, operation: (itemId: string) => Promise<T>): Promise<T> {
		this.assertAdmissionOpen()
		const itemId = this.itemIdFor(senderId)
		const promise = Promise.resolve().then(() => operation(itemId))
		this.inFlight.add(promise)
		void promise.then(
			() => this.inFlight.delete(promise),
			() => this.inFlight.delete(promise),
		)
		return promise
	}

	beginProfileSwitchDrain(hasDirtyEditors: () => boolean, closeCleanEditors: () => void): RunContextDrainResult {
		if (hasDirtyEditors()) return { ok: false }
		const lease = ++this.nextLease
		this.activeLease = lease
		closeCleanEditors()
		const admitted = [...this.inFlight]
		return {
			ok: true,
			drained: Promise.allSettled(admitted).then(() => undefined),
			release: () => {
				// A stale operation must never reopen admission after a later switch
				// has acquired its own drain lease.
				if (this.activeLease === lease) this.activeLease = null
			},
		}
	}

	assertAdmissionOpen(): void {
		if (this.activeLease !== null || !this.canOpen()) {
			throw new Error('Profile is switching — use Run Context afterward')
		}
	}
}

export default { RunContextAccess }
