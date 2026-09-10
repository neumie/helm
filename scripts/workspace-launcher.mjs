import { spawn } from 'node:child_process'

/**
 * Own only the two processes launched here; never discover or kill existing apps/Pi.
 * @typedef {{command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv}} ProcessSpec
 * @param {{remote: ProcessSpec, desktop: ProcessSpec, report?: (message: string) => void, readyTimeoutMs?: number, signal?: AbortSignal}} options
 */
export async function launchWorkspace({ remote, desktop, report = console.log, readyTimeoutMs = 10_000, signal }) {
	signal?.throwIfAborted()
	const children = []
	let stopping
	function launch(spec, ipc) {
		const child = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			env: spec.env ?? process.env,
			stdio: ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
			shell: false,
		})
		const exited = new Promise(resolve => {
			child.once('error', () => resolve({ code: 1, signal: null }))
			child.once('exit', (code, signal) => resolve({ code, signal }))
		})
		const owned = { child, exited }
		children.push(owned)
		return owned
	}
	function stop(signal = 'SIGTERM') {
		if (stopping) return stopping
		stopping = Promise.all(
			children.map(async ({ child, exited }, index) => {
				if (child.exitCode === null && child.signalCode === null) child.kill(signal)
				// Only the new infrastructure host can be escalated. Never force-kill Electron or Pi.
				const timer = index === 0 ? setTimeout(() => child.kill('SIGKILL'), 2000) : undefined
				try {
					return await exited
				} finally {
					clearTimeout(timer)
				}
			}),
		)
		return stopping
	}
	const host = launch(remote, true)
	const abort = () => {
		void stop(signal?.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM')
	}
	signal?.addEventListener('abort', abort, { once: true })
	try {
		const remoteReused = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => finish(new Error('Remote did not become ready')), readyTimeoutMs)
			function finish(error, reused = false) {
				clearTimeout(timer)
				host.child.off('message', onMessage)
				host.child.off('error', onError)
				host.child.off('exit', onExit)
				if (error) reject(error)
				else resolve(reused)
			}
			function onMessage(message) {
				if (message?.type === 'helm-remote-ready') finish(undefined, message.reused === true)
			}
			function onError() {
				finish(new Error('Could not launch Remote'))
			}
			function onExit() {
				finish(new Error('Remote exited before becoming ready'))
			}
			host.child.on('message', onMessage)
			host.child.once('error', onError)
			host.child.once('exit', onExit)
		})
		signal?.throwIfAborted()
		const app = launch(desktop, false)
		await new Promise((resolve, reject) => {
			app.child.once('spawn', resolve)
			app.child.once('error', () => reject(new Error('Could not launch the desktop app')))
		})
		void app.exited.then(result => {
			if (!stopping && host.child.exitCode === null && host.child.signalCode === null)
				report(`Desktop exited (${result.code ?? result.signal}). Remote is still running; Ctrl+C stops the launcher.`)
		})
		if (!remoteReused)
			void host.exited.then(result => {
				if (!stopping && app.child.exitCode === null && app.child.signalCode === null)
					report(`Remote exited (${result.code ?? result.signal}). The desktop app was not stopped.`)
			})
		const finished = (
			remoteReused ? app.exited.then(result => [result]) : Promise.all([app.exited, host.exited])
		).finally(() => signal?.removeEventListener('abort', abort))
		return { stop, desktopExited: app.exited, remoteExited: host.exited, finished }
	} catch (error) {
		signal?.removeEventListener('abort', abort)
		await stop()
		throw error
	}
}
