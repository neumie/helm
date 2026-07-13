import { spawn } from 'node:child_process'
import { createWriteStream, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { HelmConfig, ProjectConfig } from '../config.js'
import type { ItemPayload } from '../items/schema.js'
import { isCancellation, phaseError, taskCancelled } from '../util/errors.js'

export type RalphPayload = Extract<ItemPayload, { kind: 'ralph' }>
export type HardenPayload = Extract<ItemPayload, { kind: 'harden' }>
export type LoopPayload = RalphPayload | HardenPayload

export interface LoopRunParams {
	projectConfig: ProjectConfig
	solverConfig: HelmConfig['solver']
	itemId: string
	itemTitle: string
	payload: LoopPayload
	worktreePath: string
	branchName: string
	planDirName: string
	outputLogPath: string
	signal?: AbortSignal
	onRunId: (runId: string) => void
}

export interface LoopRunResult {
	runId: string | null
	exitCode: number
}

export interface LoopRunner {
	runLoop(params: LoopRunParams): Promise<LoopRunResult>
}

function prdNameFromPath(prdPath: string): string {
	const normalized = prdPath.replace(/\\/g, '/').replace(/\/+$/, '')
	if (normalized.endsWith('/prd.md')) return basename(dirname(normalized))
	if (normalized.startsWith('docs/plans/')) return normalized.split('/')[2] || normalized
	if (normalized.endsWith('.md')) return basename(normalized, '.md')
	return normalized
}

function parseRunIdLine(line: string): string | null {
	const trimmed = line.trim()
	if (!trimmed) return null
	const labelled = trimmed.match(/^Run (?:ID|registered):\s*(\S+)/i)
	if (labelled) return labelled[1]
	const assigned = trimmed.match(/^run_id[=:]\s*(\S+)/i)
	if (assigned) return assigned[1]
	return /^(?:ralph|harden)-[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null
}

function ralphArgs(payload: RalphPayload, solverConfig: HelmConfig['solver']): string[] {
	const mode = payload.mode ?? 'once'
	const args = [
		'ralph',
		'--prd',
		prdNameFromPath(payload.prdPath),
		'--mode',
		mode,
		'--provider',
		payload.provider ?? solverConfig.agent,
		'--model',
		payload.model ?? solverConfig.model ?? 'default',
		'--effort',
		payload.effort ?? 'default',
		'--yes',
	]
	if (mode === 'afk') args.push('--iterations', String(payload.iterations ?? 10))
	if (payload.noOversee) args.push('--no-oversee')
	return args
}

function hardenArgs(payload: HardenPayload): string[] {
	const args = ['harden', payload.target, '--loop']
	if (payload.rounds) args.push('--rounds', String(payload.rounds))
	return args
}

function almanacArgs(payload: LoopPayload, solverConfig: HelmConfig['solver']): string[] {
	switch (payload.kind) {
		case 'ralph':
			return ralphArgs(payload, solverConfig)
		case 'harden':
			return hardenArgs(payload)
	}
}

export class AlmanacLoopRunner implements LoopRunner {
	async runLoop(params: LoopRunParams): Promise<LoopRunResult> {
		if (params.signal?.aborted) throw taskCancelled()

		const loopKind = params.payload.kind
		const args = almanacArgs(params.payload, params.solverConfig)
		let runId: string | null = null
		const emitRunId = (candidate: string | null) => {
			if (!candidate || runId) return
			runId = candidate
			params.onRunId(candidate)
		}

		const stopFile = `${params.worktreePath}/.${loopKind}-stop`
		const requestStop = () => {
			writeFileSync(stopFile, '', 'utf-8')
		}
		params.signal?.addEventListener('abort', requestStop, { once: true })

		const logStream = createWriteStream(params.outputLogPath, { flags: 'a' })
		let stdoutBuffer = ''

		try {
			const child = spawn('almanac', args, {
				cwd: params.worktreePath,
				env: process.env,
				stdio: ['ignore', 'pipe', 'pipe'],
			})

			const exitCode = await new Promise<number>((resolve, reject) => {
				child.stdout.setEncoding('utf-8')
				child.stdout.on('data', (chunk: string) => {
					logStream.write(chunk)
					stdoutBuffer += chunk
					let newline = stdoutBuffer.indexOf('\n')
					while (newline !== -1) {
						const line = stdoutBuffer.slice(0, newline)
						stdoutBuffer = stdoutBuffer.slice(newline + 1)
						emitRunId(parseRunIdLine(line))
						newline = stdoutBuffer.indexOf('\n')
					}
				})
				child.stderr.on('data', chunk => {
					logStream.write(chunk)
				})
				child.on('error', err => {
					reject(err)
				})
				child.on('close', code => {
					emitRunId(parseRunIdLine(stdoutBuffer))
					resolve(code ?? 0)
				})
			})

			if (params.signal?.aborted) throw taskCancelled()
			if (exitCode !== 0) throw phaseError('loop', `almanac ${loopKind} exited with code ${exitCode}`)
			if (!runId) throw phaseError('loop', `almanac ${loopKind} did not emit a run id`)
			return { runId, exitCode }
		} catch (err) {
			if (isCancellation(err)) throw err
			throw phaseError('loop', `almanac ${loopKind} failed: ${err instanceof Error ? err.message : err}`)
		} finally {
			params.signal?.removeEventListener('abort', requestStop)
			await new Promise<void>(resolve => {
				logStream.end(() => resolve())
			})
		}
	}
}
