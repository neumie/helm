import { spawn } from 'node:child_process'
import { lstatSync, unlinkSync, type Stats } from 'node:fs'
import { join, resolve } from 'node:path'
import { RUNTIME_ARTIFACTS, socketAnswered } from './reclaim.js'

const POLL_MS = 200

export type OwnedHostStatus = 'compatible' | 'incompatible' | 'absent' | 'refused'

/** Process facts the recovery may use. A failed inspection is `null`, never an empty guess. */
export interface OwnedStartInspection {
	runtimePids(): Promise<number[] | null>
	holders(path: string): Promise<number[] | null>
	signal(pid: number): void
	alive(pid: number): boolean
}

/**
 * Operator start may replace only a runtime it can prove it owns. A missing listener
 * is not enough: another runtime process, an unknown socket holder, a failed
 * inspection, or a non-private artifact all stay fail-closed.
 */
export async function recoverOwnedRuntime(input: {
	root: string
	status: () => Promise<OwnedHostStatus>
	inspect: OwnedStartInspection
	now?: () => number
	sleep?: (ms: number) => Promise<void>
	deadlineMs?: number
}): Promise<'ready' | 'cleared'> {
	const now = input.now ?? Date.now
	const sleep = input.sleep ?? (ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)))
	const deadline = now() + (input.deadlineMs ?? 20_000)
	const signaled = new Set<number>()
	while (now() < deadline) {
		const status = await input.status()
		if (status === 'compatible') return 'ready'
		if (status === 'incompatible') {
			const pid = await ownedListener(input.root, input.inspect)
			if (pid === null) throw refusal()
			if (!signaled.has(pid)) {
				signaled.add(pid)
				input.inspect.signal(pid)
			}
			await sleep(POLL_MS)
			continue
		}
		if (status === 'refused') {
			await sleep(POLL_MS)
			continue
		}
		const peers = await input.inspect.runtimePids()
		if (peers === null) {
			await sleep(POLL_MS)
			continue
		}
		if (peers.length > 0) {
			await sleep(POLL_MS)
			continue
		}
		const proof = await abandonedProof(input.root, input.inspect)
		if (proof === 'gone' || proof === 'clear') {
			const again = await input.inspect.runtimePids()
			if (again === null || again.length > 0) {
				await sleep(POLL_MS)
				continue
			}
			clearAbandoned(input.root)
			return 'cleared'
		}
		await sleep(POLL_MS)
	}
	throw refusal()
}

export function runtimePidsFromPs(output: string, runtimePath: string, selfPid: number): number[] {
	const needle = resolve(runtimePath)
	const pids: number[] = []
	for (const line of output.split('\n')) {
		const match = /^(\d+)\s+(.*)$/.exec(line.trim())
		if (!match) continue
		const pid = Number(match[1])
		const command = match[2] ?? ''
		if (!Number.isSafeInteger(pid) || pid <= 0 || pid === selfPid) continue
		if (hasBoundedArg(command, needle)) pids.push(pid)
	}
	return pids
}

export function holderPids(output: string): number[] {
	const pids = new Set<number>()
	for (const line of output.split('\n')) {
		if (!line.startsWith('p')) continue
		const pid = Number(line.slice(1))
		if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid)
	}
	return [...pids]
}

/** Default macOS inspection. It never shells out and never signals from this helper. */
export function hostOwnedStartInspection(runtimePath: string, selfPid = process.pid): OwnedStartInspection {
	return {
		async runtimePids() {
			const output = await capture('ps', ['-ax', '-o', 'pid=', '-o', 'command='])
			return output === null ? null : runtimePidsFromPs(output, runtimePath, selfPid)
		},
		async holders(path) {
			const output = await capture('lsof', ['-nP', '-F', 'p', '--', path])
			return output === null ? null : holderPids(output)
		},
		signal(pid) {
			if (pid === selfPid) return
			try {
				process.kill(pid, 'SIGTERM')
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
			}
		},
		alive(pid) {
			try {
				process.kill(pid, 0)
				return true
			} catch {
				return false
			}
		},
	}
}

function refusal(): Error {
	return new Error('Remote runtime lock exists but no compatible authenticated host answered; refuse to replace it')
}

async function ownedListener(root: string, inspect: OwnedStartInspection): Promise<number | null> {
	const holders = await inspect.holders(join(root, 'control.sock'))
	if (!holders || holders.length !== 1) return null
	const pid = holders[0]
	const peers = await inspect.runtimePids()
	if (pid === undefined || !peers?.includes(pid)) return null
	return pid
}

async function abandonedProof(
	root: string,
	inspect: OwnedStartInspection,
): Promise<'clear' | 'gone' | 'blocked'> {
	const identities = new Map<string, { dev: number; ino: number }>()
	for (const name of RUNTIME_ARTIFACTS) {
		const path = join(root, name)
		const holders = await inspect.holders(path)
		if (holders === null || holders.length > 0) return 'blocked'
		let stat: Stats
		try {
			stat = lstatSync(path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
			return 'blocked'
		}
		if (!privateArtifact(stat, name === 'runtime.lock' ? 'file' : 'socket')) return 'blocked'
		if (name !== 'runtime.lock' && (await socketAnswered(path))) return 'blocked'
		identities.set(path, { dev: stat.dev, ino: stat.ino })
	}
	if (!identities.has(join(root, 'runtime.lock'))) return 'gone'
	for (const [path, expected] of identities) {
		try {
			const again = lstatSync(path)
			if (again.dev !== expected.dev || again.ino !== expected.ino) return 'blocked'
		} catch {
			return 'blocked'
		}
	}
	return 'clear'
}

function clearAbandoned(root: string): void {
	for (const name of RUNTIME_ARTIFACTS) {
		const path = join(root, name)
		let stat: Stats
		try {
			stat = lstatSync(path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
			throw refusal()
		}
		if (!privateArtifact(stat, name === 'runtime.lock' ? 'file' : 'socket')) throw refusal()
		const again = lstatSync(path)
		if (again.dev !== stat.dev || again.ino !== stat.ino) throw refusal()
		unlinkSync(path)
	}
}

function privateArtifact(stat: Stats, kind: 'file' | 'socket'): boolean {
	const uid = process.getuid?.()
	return (
		uid !== undefined &&
		stat.uid === uid &&
		stat.nlink === 1 &&
		!stat.isSymbolicLink() &&
		(kind === 'file' ? stat.isFile() : stat.isSocket()) &&
		(stat.mode & 0o777) === 0o600
	)
}

function hasBoundedArg(command: string, needle: string): boolean {
	let from = 0
	while (from <= command.length) {
		const at = command.indexOf(needle, from)
		if (at < 0) return false
		const before = at === 0 ? ' ' : command[at - 1]
		const after = command[at + needle.length] ?? ' '
		if ((before === ' ' || before === '\t') && (after === ' ' || after === '\t')) return true
		from = at + 1
	}
	return false
}

/** `null` means the inspection failed. An empty string means the command found nothing. */
function capture(command: string, args: string[]): Promise<string | null> {
	return new Promise(resolvePromise => {
		const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
		const parts: Buffer[] = []
		let bytes = 0
		child.stdout.on('data', (part: Buffer) => {
			bytes += part.length
			if (bytes <= 1024 * 1024) parts.push(part)
		})
		child.once('error', () => resolvePromise(null))
		child.once('exit', code => {
			if (bytes > 1024 * 1024) resolvePromise(null)
			else if (code === 0 || code === 1) resolvePromise(Buffer.concat(parts).toString('utf8'))
			else resolvePromise(null)
		})
	})
}
