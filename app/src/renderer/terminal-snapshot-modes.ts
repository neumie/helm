import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm'

/** Mouse encoding omitted by SerializeAddon.
 * Observe xterm's parser (not PTY chunks), so split markers and resets match
 * the emulator. Never consume an escape or replay stale alternate content. */
export class TerminalSnapshotModesAddon implements ITerminalAddon {
	private mouseEncoding: 1006 | 1016 | null = null
	private handlers: IDisposable[] = []

	activate(terminal: Terminal): void {
		for (const final of ['h', 'l']) {
			this.handlers.push(
				terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
					for (const mode of params) {
						if (mode === 1006 || mode === 1016) this.mouseEncoding = final === 'h' ? mode : null
					}
					return false
				}),
			)
		}
		this.handlers.push(
			terminal.parser.registerEscHandler({ final: 'c' }, () => {
				this.mouseEncoding = null
				return false
			}),
		)
	}

	serialize(): string {
		// Reattached apps retain their input parser, but do not resend startup
		// DECSETs. Keep the exact encoding; do not alter the buffer/content policy.
		return this.mouseEncoding === null ? '' : `\x1b[?${this.mouseEncoding}h`
	}

	dispose(): void {
		for (const handler of this.handlers) handler.dispose()
		this.handlers = []
		this.mouseEncoding = null
	}
}
