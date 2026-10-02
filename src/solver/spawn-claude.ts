import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { taskCancelled } from '../util/errors.js'
import { log } from '../util/logger.js'

export interface SpawnClaudeOptions {
	command?: string
	args: string[]
	cwd: string
	prompt: string
	timeoutMs: number
	signal?: AbortSignal
	logPath?: string
	label?: string
	displayName?: string
	/** Optional bounded event delivery for native conversation consumers. */
	onStdout?(chunk: Buffer): void
	onDispatched?(): void
	maxOutputBytes?: number
	environment?: NodeJS.ProcessEnv
}

export interface SpawnClaudeResult {
	exitCode: number | null
	stdout: string
	stderr: string
}

export function spawnClaude(options: SpawnClaudeOptions): Promise<SpawnClaudeResult> {
	const {
		command = 'claude',
		args,
		cwd,
		prompt,
		timeoutMs,
		signal,
		logPath,
		label = command,
		displayName = command,
	} = options

	return new Promise<SpawnClaudeResult>((resolve, reject) => {
		if (signal?.aborted) {
			reject(taskCancelled())
			return
		}

		const child = spawn(command, args, {
			cwd,
			env: options.environment ?? { ...process.env },
			stdio: ['pipe', 'pipe', 'pipe'],
		})

		const logStream = logPath ? createWriteStream(logPath, { flags: 'a' }) : null
		const stdoutChunks: Buffer[] = []
		const stderrChunks: Buffer[] = []

		let closed = false
		let exited = false
		const releasePipes = () => {
			child.stdin.destroy()
			child.stdout.destroy()
			child.stderr.destroy()
		}
		let terminationTimer: ReturnType<typeof setTimeout> | null = null
		const onAbort = () => {
			if (closed || terminationTimer) return
			if (exited) {
				releasePipes()
				return
			}
			child.kill('SIGTERM')
			terminationTimer = setTimeout(() => {
				if (!closed) child.kill('SIGKILL')
			}, 5000)
			terminationTimer.unref()
		}
		let timedOut = false
		const deadline = setTimeout(() => {
			timedOut = true
			onAbort()
		}, timeoutMs)
		deadline.unref()
		let outputBytes = 0
		let outputError: Error | null = null
		const admitOutput = (chunk: Buffer): boolean => {
			outputBytes += chunk.length
			if (options.maxOutputBytes !== undefined && outputBytes > options.maxOutputBytes) {
				outputError = new Error('Agent output exceeded its bounded conversation limit')
				onAbort()
				return false
			}
			return true
		}
		child.stdout.on('data', (chunk: Buffer) => {
			if (!admitOutput(chunk)) return
			stdoutChunks.push(chunk)
			logStream?.write(chunk)
			try {
				options.onStdout?.(chunk)
			} catch {
				outputError = new Error('Agent conversation output was invalid')
				onAbort()
			}
		})
		child.stderr.on('data', (chunk: Buffer) => {
			if (!admitOutput(chunk)) return
			stderrChunks.push(chunk)
			logStream?.write(chunk)
		})

		signal?.addEventListener('abort', onAbort, { once: true })

		let inputFailed = false
		child.stdin.on('error', () => {
			inputFailed = true
			// A write failure is never a delivery confirmation or permission to replay.
			if (options.onDispatched) {
				outputError = new Error('Agent input delivery was not confirmed')
				onAbort()
			}
		})
		child.stdin.end(prompt, () => {
			if (!inputFailed && !signal?.aborted && !outputError) options.onDispatched?.()
		})

		child.on('exit', () => {
			exited = true
			if (terminationTimer) releasePipes()
		})
		child.on('close', code => {
			clearTimeout(deadline)
			closed = true
			if (terminationTimer) clearTimeout(terminationTimer)
			signal?.removeEventListener('abort', onAbort)
			logStream?.end()

			const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
			const stderr = Buffer.concat(stderrChunks).toString('utf-8')

			log.info(label, `${displayName} exited with code ${code}`, {
				stdoutLen: stdout.length,
				stderrLen: stderr.length,
			})

			if (signal?.aborted) {
				reject(taskCancelled())
			} else if (outputError) {
				reject(outputError)
			} else if (timedOut) {
				reject(new Error(`${displayName} timed out; its outcome is unconfirmed`))
			} else {
				resolve({ exitCode: code, stdout, stderr })
			}
		})

		child.on('error', err => {
			clearTimeout(deadline)
			closed = true
			if (terminationTimer) clearTimeout(terminationTimer)
			signal?.removeEventListener('abort', onAbort)
			logStream?.end()
			reject(new Error(`Failed to spawn ${displayName}: ${err.message}`))
		})
	})
}
