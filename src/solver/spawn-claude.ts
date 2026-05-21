import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { taskCancelled } from '../util/errors.js'
import { log } from '../util/logger.js'

export interface SpawnClaudeOptions {
	args: string[]
	cwd: string
	prompt: string
	timeoutMs: number
	signal?: AbortSignal
	logPath?: string
	label?: string
}

export interface SpawnClaudeResult {
	exitCode: number | null
	stdout: string
	stderr: string
}

export function spawnClaude(options: SpawnClaudeOptions): Promise<SpawnClaudeResult> {
	const { args, cwd, prompt, timeoutMs, signal, logPath, label = 'claude' } = options

	return new Promise<SpawnClaudeResult>((resolve, reject) => {
		if (signal?.aborted) {
			reject(taskCancelled())
			return
		}

		const child = spawn('claude', args, {
			cwd,
			env: { ...process.env },
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: timeoutMs,
		})

		const logStream = logPath ? createWriteStream(logPath, { flags: 'a' }) : null
		const stdoutChunks: Buffer[] = []
		const stderrChunks: Buffer[] = []

		child.stdout.on('data', (chunk: Buffer) => {
			stdoutChunks.push(chunk)
			logStream?.write(chunk)
		})
		child.stderr.on('data', (chunk: Buffer) => {
			stderrChunks.push(chunk)
			logStream?.write(chunk)
		})

		const onAbort = () => {
			child.kill('SIGTERM')
			setTimeout(() => {
				if (!child.killed) child.kill('SIGKILL')
			}, 5000)
		}
		signal?.addEventListener('abort', onAbort, { once: true })

		child.stdin.write(prompt)
		child.stdin.end()

		child.on('close', code => {
			signal?.removeEventListener('abort', onAbort)
			logStream?.end()

			const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
			const stderr = Buffer.concat(stderrChunks).toString('utf-8')

			log.info(label, `Claude exited with code ${code}`, {
				stdoutLen: stdout.length,
				stderrLen: stderr.length,
			})

			if (signal?.aborted) {
				reject(taskCancelled())
			} else {
				resolve({ exitCode: code, stdout, stderr })
			}
		})

		child.on('error', err => {
			signal?.removeEventListener('abort', onAbort)
			logStream?.end()
			reject(new Error(`Failed to spawn claude: ${err.message}`))
		})
	})
}
