// Wiring of "Claude in Helm terminals" for Electron main (no Electron import:
// main.ts injects paths and callbacks, so this stays testable under node).
//
//   <socket namespace root>/claude-remote.sock       hub socket (root dir 0700, socket 0600)
//   <socket namespace root>/claude-remote/           0700: preload.cjs, hook-client.cjs, node.sh
//   <userData>/claude-remote/secret                  0600 HMAC secret for terminal tokens
//   <userData>/claude-remote/excluded.json           dispatcher session ids (0600)
//   <userData>/agent-dock/claude-remote.json         {socket, owner} for `helm dock show` (0600)
//
// The runtime copies live under the socket root because Bun splits BUN_OPTIONS
// on whitespace (an `Application Support` path cannot be preloaded). A missing
// preload makes every Bun program in the terminal fail ("preload not found",
// verified with claude 2.1.316), so the copies are rewritten whenever they are
// missing: at every terminal spawn and every RUNTIME_CHECK_MS while Helm runs.
// (Deleted while Helm is NOT running, claude in old terminals fails to start
// until Helm runs again: documented gap.)
//
// The socket root must be a real 0700 directory owned by this user (not a
// symlink); otherwise the hub stays off and terminals get no hooks.

import { spawn } from 'node:child_process'
import {
	constants,
	accessSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { delimiter, join } from 'node:path'
import {
	CLAUDE_HUB_OWNER_FILE,
	CLAUDE_HUB_RUNTIME_DIR,
	CLAUDE_HUB_SOCKET_NAME,
} from '../../../src/agent-dock/claude-hub-wire'
import { HelmClaudeHub } from './hub'
import type { TerminalRef } from './hub-core'
import {
	type ClaudeRemoteRuntime,
	claudeHubTokens,
	claudeRemoteTerminalEnvironment,
	loadOrCreateClaudeHubSecret,
} from './token'

export const PRELOAD_FILE = 'claude-remote-preload.cjs'
export const HOOK_FILE = 'claude-remote-hook.cjs'
const DTACH_PUSH_TIMEOUT_MS = 3_000
/** How often the runtime copies are checked (and rewritten when something deleted them). */
export const RUNTIME_CHECK_MS = 60_000

const NODE_CANDIDATES = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']

function executable(file: string): boolean {
	try {
		accessSync(file, constants.X_OK)
		return statSync(file).isFile()
	} catch {
		return false
	}
}

/** A Node for the hook client: the usual install paths, then PATH; null when none. */
export function resolveHookNode(pathEnv = process.env.PATH ?? ''): string | null {
	for (const candidate of NODE_CANDIDATES) if (executable(candidate)) return candidate
	for (const dir of pathEnv.split(delimiter)) if (dir && executable(join(dir, 'node'))) return join(dir, 'node')
	return null
}

/** A private directory: real dir (no symlink), this user's, mode 0700. Throws otherwise. */
export function assertPrivateDir(dir: string): void {
	const info = lstatSync(dir)
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dir} is not a directory`)
	if (typeof process.getuid === 'function' && info.uid !== process.getuid())
		throw new Error(`${dir} is owned by another user`)
	if ((info.mode & 0o777) !== 0o700) throw new Error(`${dir} is not private (0700)`)
}

function writeAtomic(file: string, data: string, mode: number): void {
	const temp = `${file}.${process.pid}.tmp`
	writeFileSync(temp, data, { mode })
	chmodSync(temp, mode)
	renameSync(temp, file)
}

export interface ClaudeRemoteOptions {
	/** sessions.socketNamespaceRoot(): HELM_SOCKET_DIR or /tmp/helm-<uid>. */
	socketRoot: string
	/** Where build.mjs put the preload and hook client (app/dist). */
	distDir: string
	userDataDir: string
	agentDockDir: string
	/** Electron's own binary: the hook client runs on it (ELECTRON_RUN_AS_NODE) when no node is installed. */
	electronPath: string
	activeProfileId(): string | null
	/** Writes to an attached Helm tab's pty; false when no tab holds this terminal. */
	writeAttached(ref: TerminalRef, data: string): boolean
	/** dtach socket of a terminal (parked tabs get the reply through `dtach -p`). */
	dtachSocket(ref: TerminalRef): string | null
	dtachBinary(): string | null
	terminalName?(ref: TerminalRef): string | undefined
	log?(message: string): void
}

export interface ClaudeRemote {
	hub: HelmClaudeHub
	/** Null when the runtime files could not be written: terminals then get no hooks. */
	runtime: ClaudeRemoteRuntime | null
	/** The extra environment for one new terminal (both spawn sites). */
	environment(env: Record<string, string>, ref: TerminalRef | null): Record<string, string>
	start(): Promise<boolean>
	stop(): void
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** `dtach -p <socket>` with `data` on stdin: types into a session no Helm tab is attached to. */
export function dtachPush(dtach: string, socket: string, data: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(dtach, ['-p', socket], { stdio: ['pipe', 'ignore', 'pipe'] })
		let stderr = ''
		const timer = setTimeout(() => {
			child.kill('SIGKILL')
			reject(new Error('dtach -p timed out'))
		}, DTACH_PUSH_TIMEOUT_MS)
		child.stderr?.on('data', chunk => {
			stderr = `${stderr}${chunk}`.slice(-300)
		})
		child.on('error', error => {
			clearTimeout(timer)
			reject(error)
		})
		child.on('exit', code => {
			clearTimeout(timer)
			if (code === 0) resolve()
			else reject(new Error(`dtach -p exited ${code}: ${stderr.trim()}`))
		})
		child.stdin?.end(data)
	})
}

export function createClaudeRemote(options: ClaudeRemoteOptions): ClaudeRemote {
	const log = options.log ?? ((message: string) => console.warn(`[helm] claude hub: ${message}`))
	const socketPath = join(options.socketRoot, CLAUDE_HUB_SOCKET_NAME)
	const stateDir = join(options.userDataDir, 'claude-remote')
	const tokens = claudeHubTokens(loadOrCreateClaudeHubSecret(join(stateDir, 'secret')))

	let runtime: ClaudeRemoteRuntime | null = null
	let rootPrivate = false
	/** Runtime files and their contents, rewritten when missing. */
	const files: Array<{ path: string; data: string; mode: number }> = []
	const dir = join(options.socketRoot, CLAUDE_HUB_RUNTIME_DIR)
	const ensureFiles = (): boolean => {
		try {
			assertPrivateDir(options.socketRoot)
			if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 })
			assertPrivateDir(dir)
			for (const file of files) if (!existsSync(file.path)) writeAtomic(file.path, file.data, file.mode)
			return true
		} catch (error) {
			log(`runtime files unavailable: ${(error as Error).message}`)
			return false
		}
	}
	try {
		mkdirSync(options.socketRoot, { recursive: true, mode: 0o700 })
		chmodSync(options.socketRoot, 0o700)
		assertPrivateDir(options.socketRoot)
		rootPrivate = true
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		chmodSync(dir, 0o700)
		assertPrivateDir(dir)
		const preloadPath = join(dir, 'preload.cjs')
		const hookPath = join(dir, 'hook-client.cjs')
		files.push(
			{ path: preloadPath, data: readFileSync(join(options.distDir, PRELOAD_FILE), 'utf8'), mode: 0o600 },
			{ path: hookPath, data: readFileSync(join(options.distDir, HOOK_FILE), 'utf8'), mode: 0o600 },
		)
		let nodePath = resolveHookNode()
		if (!nodePath) {
			// No Node installed: run the hook client on Electron's own runtime.
			nodePath = join(dir, 'node.sh')
			const quoted = `'${options.electronPath.replace(/'/g, "'\\''")}'`
			files.push({ path: nodePath, data: `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quoted} "$@"\n`, mode: 0o700 })
		}
		for (const file of files) writeAtomic(file.path, file.data, file.mode)
		runtime = { socketPath, preloadPath, hookPath, nodePath, tokens }
	} catch (error) {
		log(`runtime files unavailable, terminals get no Claude hooks: ${(error as Error).message}`)
	}
	let checkTimer: NodeJS.Timeout | null = null

	const deliver = async (ref: TerminalRef, chunks: string[], gapMs: number): Promise<'pty' | 'push'> => {
		let via: 'pty' | 'push' | null = null
		for (const [index, chunk] of chunks.entries()) {
			if (index > 0) await sleep(gapMs)
			if (via !== 'push' && options.writeAttached(ref, chunk)) {
				via = 'pty'
				continue
			}
			if (via === 'pty') throw new Error('The Helm tab detached while the reply was typed.')
			const dtach = options.dtachBinary()
			const socket = options.dtachSocket(ref)
			if (!dtach || !socket) throw Object.assign(new Error('This terminal is not reachable.'), { status: 409 })
			await dtachPush(dtach, socket, chunk)
			via = 'push'
		}
		return via ?? 'pty'
	}

	const hub = new HelmClaudeHub({
		socketPath,
		tokens,
		activeProfileId: options.activeProfileId,
		deliver,
		ownerFile: join(options.agentDockDir, CLAUDE_HUB_OWNER_FILE),
		excludedFile: join(stateDir, 'excluded.json'),
		terminalName: options.terminalName,
		log,
	})

	return {
		hub,
		runtime,
		// A terminal gets the preload only while its file is there (a missing one breaks every Bun program).
		environment: (env, ref) => claudeRemoteTerminalEnvironment(env, ref, runtime && ensureFiles() ? runtime : null),
		start: async () => {
			// Never listen in a socket root another user could have prepared.
			if (!rootPrivate) return false
			checkTimer ??= setInterval(() => {
				if (runtime) ensureFiles()
			}, RUNTIME_CHECK_MS)
			checkTimer.unref?.()
			return hub.start()
		},
		stop: () => {
			if (checkTimer) clearInterval(checkTimer)
			checkTimer = null
			hub.stop()
		},
	}
}
