#!/usr/bin/env node
/**
 * macOS release canary for profile switching. It deliberately owns only the
 * isolated process topology and fake daemon; Electron drives its normal
 * coordinator through the explicit guarded main-process mode.
 */
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	findConflictingHelmDesktopPids,
	isAttestedDtachCommand,
	terminateOwnedProcessGroup,
} from './profile-switch-attestation-safety.mjs'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const valueArg = prefix => process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) ?? null
const requireElectron = args.has('--require-electron')
const requireDtach = args.has('--require-dtach')
const keepArtifacts = args.has('--keep-artifacts')
const outputPath = valueArg('--output=')
const timeoutMs = Number(valueArg('--timeout-ms=') ?? 90_000)

function builtAppIdentity() {
	const protocolSource = readFileSync(join(appRoot, 'src', 'protocol-version.ts'), 'utf8')
	const buildSource = readFileSync(join(appRoot, 'src', 'build-id.generated.ts'), 'utf8')
	const protocol = /EXPECTED_DAEMON_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(protocolSource)?.[1]
	const buildId = /HELM_BUILD_ID\s*=\s*'([^']+)'/.exec(buildSource)?.[1]
	if (!protocol || !buildId) throw new Error('Could not read the built Helm protocol identity')
	return { protocolVersion: Number(protocol), buildId }
}

function atomicWrite(file, value) {
	mkdirSync(dirname(file), { recursive: true })
	const temporary = `${file}.tmp-${process.pid}`
	writeFileSync(temporary, JSON.stringify(value, null, 2))
	renameSync(temporary, file)
}

function resolveDtach() {
	const candidates = ['/opt/homebrew/bin/dtach', '/usr/local/bin/dtach', '/opt/local/bin/dtach', '/usr/bin/dtach']
	for (const dir of (process.env.PATH ?? '').split(':')) candidates.push(join(dir, 'dtach'))
	return (
		candidates.find(candidate => {
			try {
				return statSync(candidate).isFile()
			} catch {
				return false
			}
		}) ?? null
	)
}

function skipped(reason) {
	const evidence = { schemaVersion: 1, result: 'skipped', skipReason: reason, platform: process.platform }
	if (outputPath) atomicWrite(resolve(outputPath), evidence)
	process.stdout.write(`${JSON.stringify({ evidencePath: outputPath ? resolve(outputPath) : null, ...evidence })}\n`)
}

function requiredFailure(reason) {
	const evidence = { schemaVersion: 1, result: 'failed', error: reason, platform: process.platform }
	if (outputPath) atomicWrite(resolve(outputPath), evidence)
	process.stderr.write(`[profile-switch-attestation] ${reason}\n`)
	process.exitCode = 1
}

const electron = join(appRoot, 'node_modules', '.bin', 'electron')
const electronExecutable = join(
	appRoot,
	'node_modules',
	'electron',
	'dist',
	'Electron.app',
	'Contents',
	'MacOS',
	'Electron',
)
const dtach = resolveDtach()
const unavailable =
	process.platform !== 'darwin'
		? 'macOS runner unavailable'
		: !existsSync(electron)
			? 'Electron unavailable (run bun install in app/)'
			: !dtach
				? 'dtach unavailable'
				: !existsSync(join(appRoot, 'dist', 'main.cjs'))
					? 'Electron app is not built (run cd app && bun run build)'
					: null
if (unavailable) {
	if (requireElectron || requireDtach) requiredFailure(unavailable)
	else skipped(unavailable)
} else {
	const conflicts = await conflictingHelmDesktopPids()
	if (conflicts === null) {
		skipped('Electron/Helm desktop safety preflight unavailable; refusing to launch the attestation')
	} else {
		if (conflicts.length > 0) {
			skipped(`Electron/Helm desktop already running (pids: ${conflicts.join(', ')}); attestation not launched`)
		} else {
			await run()
		}
	}
}

async function run() {
	const root = mkdtempSync(join(tmpdir(), 'hpsa-'))
	chmodSync(root, 0o700)
	const socketRoot = join(root, 's')
	const userDataDir = join(root, 'user-data')
	const homeDir = join(root, 'home')
	const xdgConfigHome = join(homeDir, '.config')
	const xdgStateHome = join(homeDir, '.local', 'state')
	const xdgCacheHome = join(homeDir, '.cache')
	const xdgDataHome = join(homeDir, '.local', 'share')
	const xdgRuntimeDir = join(homeDir, '.runtime')
	const childEvidencePath = join(root, 'child-evidence.json')
	for (const directory of [
		socketRoot,
		userDataDir,
		homeDir,
		xdgConfigHome,
		xdgStateHome,
		xdgCacheHome,
		xdgDataHome,
		xdgRuntimeDir,
	]) {
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		chmodSync(directory, 0o700)
	}
	const capability = randomBytes(32).toString('hex')
	writeFileSync(join(root, '.attestation-capability'), capability, { mode: 0o600 })
	const localControlPath = join(root, '.local-api-token')
	writeFileSync(localControlPath, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 })
	const finalEvidencePath = outputPath
		? resolve(outputPath)
		: join(tmpdir(), `helm-profile-switch-attestation-${process.pid}.json`)
	const marker = `helm-profile-attestation-${process.pid}-${Date.now()}`
	const targetId = 'profile-aaaaaaaaaaaa'
	let electronRun = null
	let server = null
	let serverClosed = false
	let childExited = false
	let processGroupEmpty = true
	let holdersTerminated = false
	let daemonState = null
	let evidence = null
	try {
		daemonState = await startFakeDaemon(targetId, builtAppIdentity())
		server = daemonState.server
		const termCmd = Buffer.from(`printf '%s\\n' '${marker}'`, 'utf8').toString('base64')
		const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...baseEnv } = process.env
		const env = {
			...baseEnv,
			HOME: homeDir,
			ZDOTDIR: homeDir,
			HISTFILE: join(homeDir, '.zsh_history'),
			XDG_CONFIG_HOME: xdgConfigHome,
			XDG_STATE_HOME: xdgStateHome,
			XDG_CACHE_HOME: xdgCacheHome,
			XDG_DATA_HOME: xdgDataHome,
			XDG_RUNTIME_DIR: xdgRuntimeDir,
			HELM_URL: daemonState.baseUrl,
			HELM_AUTH_FILE: localControlPath,
			HELM_SOCKET_DIR: socketRoot,
			HELM_CLOSE_GRACE_MS: '100',
			HELM_TERMINAL_AGENT_STATUS: '0',
			HELM_PROFILE_SWITCH_ATTESTATION_ROOT: root,
			HELM_PROFILE_SWITCH_ATTESTATION_CAPABILITY: capability,
		}
		const latestConflicts = await conflictingHelmDesktopPids()
		if (latestConflicts === null) throw new Error('Electron/Helm desktop safety preflight became unavailable')
		if (latestConflicts.length > 0) {
			throw new Error(`Electron/Helm desktop started during attestation setup (pids: ${latestConflicts.join(', ')})`)
		}
		electronRun = spawnElectron(
			electron,
			[
				appRoot,
				`--user-data-dir=${userDataDir}`,
				`--term-cmd=${termCmd}`,
				`--profile-switch-attestation=${childEvidencePath}`,
				`--profile-switch-attestation-marker=${marker}`,
			],
			env,
			timeoutMs,
		)
		// Retain the complete ownership record before awaiting: timeout/error
		// cleanup must signal only this canary's private process group.
		processGroupEmpty = false
		const child = await electronRun.completed
		childExited = true
		await stopChild(electronRun)
		processGroupEmpty = true
		try {
			evidence = JSON.parse(readFileSync(childEvidencePath, 'utf8'))
		} catch (error) {
			throw new Error(`Electron exited without attestation evidence: ${String(error)}`)
		}
		if (child.code !== 0) throw new Error(`Electron exited ${child.code}: ${child.stderr.slice(-4000)}`)
		if (evidence.result !== 'passed')
			throw new Error(`Electron attestation failed: ${evidence.error ?? 'unknown error'}`)
		if (daemonState.activationCalls.join(',') !== `${targetId},work`) {
			throw new Error(`Unexpected daemon activation sequence: ${daemonState.activationCalls.join(',')}`)
		}
		if (evidence.daemon?.readyProfiles?.join(',') !== `${targetId},work`) {
			throw new Error(`Unexpected bridge readiness sequence: ${evidence.daemon?.readyProfiles?.join(',')}`)
		}
		evidence.daemon.activationCalls = daemonState.activationCalls
	} catch (error) {
		if (!evidence) {
			evidence = {
				schemaVersion: 1,
				result: 'failed',
				platform: process.platform,
				error: error instanceof Error ? error.message : String(error),
				paths: { userDataDir, socketRoot, homeDir },
			}
		} else {
			evidence.result = 'failed'
			evidence.error = error instanceof Error ? error.message : String(error)
		}
	} finally {
		let cleanupError = null
		if (electronRun && !processGroupEmpty) {
			try {
				await stopChild(electronRun)
				processGroupEmpty = true
			} catch (error) {
				cleanupError = error instanceof Error ? error.message : String(error)
			}
		}
		if (server) {
			await new Promise(resolveServer => server.close(() => resolveServer()))
			serverClosed = true
		}
		try {
			holdersTerminated = await terminateOwnedSocketHolders(socketRoot)
			if (!holdersTerminated) {
				cleanupError = `${cleanupError ? `${cleanupError} ` : ''}Could not prove every harness socket holder terminated.`
			}
		} catch (error) {
			const socketError = error instanceof Error ? error.message : String(error)
			cleanupError = `${cleanupError ? `${cleanupError} ` : ''}${socketError}`
			holdersTerminated = false
		}
		if (!evidence)
			evidence = { schemaVersion: 1, result: 'failed', platform: process.platform, error: 'No evidence produced.' }
		if (cleanupError) {
			evidence.result = 'failed'
			evidence.error = `${evidence.error ? `${evidence.error} ` : ''}Cleanup refused: ${cleanupError}`
		}
		const removeRoot = !keepArtifacts && processGroupEmpty && holdersTerminated
		if (removeRoot) rmSync(root, { recursive: true, force: true })
		evidence.cleanup = {
			electronExited: childExited || (electronRun !== null && electronRun.child.exitCode !== null),
			processGroupEmpty,
			fakeDaemonClosed: serverClosed,
			harnessSocketHoldersTerminated: holdersTerminated,
			tempRootRemoved: removeRoot,
		}
		atomicWrite(finalEvidencePath, evidence)
		process.stdout.write(`${JSON.stringify({ evidencePath: finalEvidencePath, result: evidence.result })}\n`)
		if (evidence.result !== 'passed') process.exitCode = 1
	}
}

function profile(id) {
	return {
		id,
		name: id === 'work' ? 'Work' : 'Attestation B',
		createdAt: '2026-01-01T00:00:00.000Z',
		enabledProjects: [],
		archivedAt: null,
	}
}

async function startFakeDaemon(targetId, appIdentity) {
	let activeProfileId = 'work'
	let generation = 1
	const activationCalls = []
	const state = () => ({
		version: 1,
		generation,
		activeProfileId,
		profiles: [profile('work'), profile(targetId)],
		configuredProjects: [],
	})
	const send = (res, status, data) => {
		res.writeHead(status, { 'content-type': 'application/json' })
		res.end(JSON.stringify(data))
	}
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1')
		const status = () => ({
			protocolVersion: appIdentity.protocolVersion,
			buildId: appIdentity.buildId,
			uptime: 1,
			queue: { paused: false, pending: 0, active: 0, maxConcurrency: 1, activeTasks: [] },
			projects: [],
			pollInterval: 60,
			scheduledRuns: { running: 0 },
			profile: profile(activeProfileId),
			profileGeneration: generation,
		})
		if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { data: status() })
		if (req.method === 'GET' && url.pathname === '/api/items') return send(res, 200, { data: [] })
		if (req.method === 'GET' && url.pathname === '/api/profiles') return send(res, 200, { data: state() })
		if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { data: null })
		if (req.method === 'POST' && url.pathname === '/api/daemon/restart')
			return send(res, 409, { error: 'attestation daemon is not managed' })
		const activate = url.pathname.match(/^\/api\/profiles\/(work|profile-aaaaaaaaaaaa)\/activate$/)
		if (req.method === 'POST' && activate) {
			activeProfileId = activate[1]
			generation += 1
			activationCalls.push(activeProfileId)
			return send(res, 200, { data: { state: state(), applied: true } })
		}
		return send(res, 404, { error: `Unexpected fake daemon request: ${req.method} ${url.pathname}` })
	})
	await new Promise((resolveServer, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => resolveServer())
	})
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Fake daemon did not bind a loopback port.')
	return { server, baseUrl: `http://127.0.0.1:${address.port}`, activationCalls }
}

function spawnElectron(command, argv, env, timeout) {
	// A private process group lets timeout/error cleanup terminate the wrapper,
	// Electron main/helpers, and no unrelated operator-owned process.
	const child = spawn(command, argv, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', data => {
		stdout += data
	})
	child.stderr.on('data', data => {
		stderr += data
	})
	let timedOut = false
	let settle
	const completed = new Promise((resolveChild, reject) => {
		settle = { resolveChild, reject }
	})
	const timer = setTimeout(() => {
		timedOut = true
		void stopChild({ child }).then(
			() => settle.reject(new Error(`Electron attestation timed out after ${timeout}ms: ${stderr.slice(-4000)}`)),
			error => settle.reject(error),
		)
	}, timeout)
	child.once('error', error => {
		clearTimeout(timer)
		if (!timedOut) settle.reject(error)
	})
	child.once('exit', code => {
		clearTimeout(timer)
		if (!timedOut) settle.resolveChild({ child, code, stdout, stderr })
	})
	return { child, completed }
}

async function stopChild(record) {
	if (!record.child?.pid) return
	await terminateOwnedProcessGroup(record.child.pid)
}

function socketFiles(root) {
	const files = []
	const visit = dir => {
		let entries = []
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const file = join(dir, entry.name)
			if (entry.isDirectory()) visit(file)
			else if (entry.name.endsWith('.sock')) files.push(file)
		}
	}
	visit(root)
	return files
}

function readProcessList() {
	return new Promise(resolveList => {
		execFile('ps', ['-axo', 'pid=,command='], { timeout: 5_000 }, (error, stdout) => {
			resolveList(error ? null : stdout)
		})
	})
}

async function conflictingHelmDesktopPids() {
	const processList = await readProcessList()
	if (processList === null) return null
	return findConflictingHelmDesktopPids(processList, {
		electronLauncher: electron,
		electronExecutable,
		appRoot,
		currentPid: process.pid,
	})
}

function execLines(command, args) {
	return new Promise(resolveLines => {
		execFile(command, args, { timeout: 5_000 }, (_error, stdout) => {
			resolveLines(
				stdout
					.split('\n')
					.map(line => Number.parseInt(line.trim(), 10))
					.filter(pid => Number.isFinite(pid) && pid > 0),
			)
		})
	})
}

function processFingerprint(pid) {
	return new Promise(resolveFingerprint => {
		execFile('ps', ['-p', String(pid), '-o', 'lstart=,command='], { timeout: 5_000 }, (error, stdout) => {
			if (error) return resolveFingerprint(null)
			const match = /^(.{24})\s+(.+)$/.exec(stdout.trim())
			resolveFingerprint(match ? { startedAt: match[1], command: match[2] } : null)
		})
	})
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function waitForPidExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return true
		await new Promise(resolveWait => setTimeout(resolveWait, 50))
	}
	return !pidAlive(pid)
}

async function terminateAttestedDtachHolder(pid, socket) {
	const initial = await processFingerprint(pid)
	if (!initial || !isAttestedDtachCommand(initial.command, socket, dtach)) {
		throw new Error(`Refusing to signal unattested pid ${pid} for ${socket}`)
	}
	if (!(await execLines('lsof', ['-t', '--', socket])).includes(pid)) return true
	const beforeTerm = await processFingerprint(pid)
	if (
		!beforeTerm ||
		beforeTerm.startedAt !== initial.startedAt ||
		!isAttestedDtachCommand(beforeTerm.command, socket, dtach) ||
		!(await execLines('lsof', ['-t', '--', socket])).includes(pid)
	) {
		throw new Error(`Lost ownership proof before signaling pid ${pid} for ${socket}`)
	}
	process.kill(pid, 'SIGTERM')
	if (await waitForPidExit(pid, 750)) return true

	const current = await processFingerprint(pid)
	if (
		!current ||
		current.startedAt !== initial.startedAt ||
		!isAttestedDtachCommand(current.command, socket, dtach) ||
		!(await execLines('lsof', ['-t', '--', socket])).includes(pid)
	) {
		throw new Error(`Lost ownership proof before escalating pid ${pid} for ${socket}`)
	}
	process.kill(pid, 'SIGKILL')
	return waitForPidExit(pid, 2_000)
}

async function terminateOwnedSocketHolders(root) {
	for (const socket of socketFiles(root)) {
		if (relative(root, socket).startsWith('..')) throw new Error(`Refusing to inspect non-owned socket: ${socket}`)
		const pids = await execLines('lsof', ['-t', '--', socket])
		if (pids.length === 0) return false
		for (const pid of pids) {
			if (!(await terminateAttestedDtachHolder(pid, socket))) return false
		}
	}
	const deadline = Date.now() + 2_000
	while (Date.now() < deadline) {
		if (socketFiles(root).length === 0) return true
		await new Promise(resolveWait => setTimeout(resolveWait, 50))
	}
	return socketFiles(root).length === 0
}
