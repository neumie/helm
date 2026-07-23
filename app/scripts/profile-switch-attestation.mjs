#!/usr/bin/env node
/**
 * macOS release canary for profile switching. It deliberately owns only the
 * isolated process topology and fake daemon; Electron drives its normal
 * coordinator through the explicit guarded main-process mode.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const valueArg = prefix => process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) ?? null
const requireElectron = args.has('--require-electron')
const requireDtach = args.has('--require-dtach')
const keepArtifacts = args.has('--keep-artifacts')
const outputPath = valueArg('--output=')
const timeoutMs = Number(valueArg('--timeout-ms=') ?? 90_000)

function atomicWrite(file, value) {
	mkdirSync(dirname(file), { recursive: true })
	const temporary = `${file}.tmp-${process.pid}`
	writeFileSync(temporary, JSON.stringify(value, null, 2))
	renameSync(temporary, file)
}

function resolveDtach() {
	const candidates = ['/opt/homebrew/bin/dtach', '/usr/local/bin/dtach', '/opt/local/bin/dtach', '/usr/bin/dtach']
	for (const dir of (process.env.PATH ?? '').split(':')) candidates.push(join(dir, 'dtach'))
	return candidates.find(candidate => {
		try {
			return statSync(candidate).isFile()
		} catch {
			return false
		}
	}) ?? null
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
	await run()
}

async function run() {
	const root = mkdtempSync(join(tmpdir(), 'hpsa-'))
	const socketRoot = join(root, 's')
	const userDataDir = join(root, 'user-data')
	const childEvidencePath = join(root, 'child-evidence.json')
	const finalEvidencePath = outputPath ? resolve(outputPath) : join(tmpdir(), `helm-profile-switch-attestation-${process.pid}.json`)
	const marker = `helm-profile-attestation-${process.pid}-${Date.now()}`
	const targetId = 'profile-aaaaaaaaaaaa'
	let child = null
	let server = null
	let serverClosed = false
	let childExited = false
	let holdersTerminated = false
	let daemonState = null
	let evidence = null
	try {
		daemonState = await startFakeDaemon(targetId)
		server = daemonState.server
		const termCmd = Buffer.from(`printf '%s\\n' '${marker}'`, 'utf8').toString('base64')
		const env = { ...process.env, HELM_URL: daemonState.baseUrl, HELM_SOCKET_DIR: socketRoot, HELM_CLOSE_GRACE_MS: '100' }
		delete env.ELECTRON_RUN_AS_NODE
		child = await spawnElectron(electron, [
			appRoot,
			`--user-data-dir=${userDataDir}`,
			`--term-cmd=${termCmd}`,
			`--profile-switch-attestation=${childEvidencePath}`,
			`--profile-switch-attestation-marker=${marker}`,
		], env, timeoutMs)
		childExited = true
		try {
			evidence = JSON.parse(readFileSync(childEvidencePath, 'utf8'))
		} catch (error) {
			throw new Error(`Electron exited without attestation evidence: ${String(error)}`)
		}
		if (child.code !== 0) throw new Error(`Electron exited ${child.code}: ${child.stderr.slice(-4000)}`)
		if (evidence.result !== 'passed') throw new Error(`Electron attestation failed: ${evidence.error ?? 'unknown error'}`)
		if (daemonState.activationCalls.join(',') !== `${targetId},work`) {
			throw new Error(`Unexpected daemon activation sequence: ${daemonState.activationCalls.join(',')}`)
		}
		if (evidence.daemon?.readyProfiles?.join(',') !== `${targetId},work`) {
			throw new Error(`Unexpected bridge readiness sequence: ${evidence.daemon?.readyProfiles?.join(',')}`)
		}
		evidence.daemon.activationCalls = daemonState.activationCalls
		evidence.daemon.mixedSnapshotObserved = daemonState.mixedSnapshotObserved
	} catch (error) {
		if (!evidence) {
			evidence = {
				schemaVersion: 1,
				result: 'failed',
				platform: process.platform,
				error: error instanceof Error ? error.message : String(error),
				paths: { userDataDir, socketRoot },
			}
		} else {
			evidence.result = 'failed'
			evidence.error = error instanceof Error ? error.message : String(error)
		}
	} finally {
		if (child && !childExited) await stopChild(child)
		if (server) {
			await new Promise(resolveServer => server.close(() => resolveServer()))
			serverClosed = true
		}
		holdersTerminated = await terminateOwnedSocketHolders(socketRoot)
		const removeRoot = !keepArtifacts
		if (removeRoot) rmSync(root, { recursive: true, force: true })
		if (!evidence) evidence = { schemaVersion: 1, result: 'failed', platform: process.platform, error: 'No evidence produced.' }
		evidence.cleanup = {
			electronExited: childExited || child?.code !== null,
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
	return { id, name: id === 'work' ? 'Work' : 'Attestation B', createdAt: '2026-01-01T00:00:00.000Z', enabledProjects: [], archivedAt: null }
}

async function startFakeDaemon(targetId) {
	let activeProfileId = 'work'
	let generation = 1
	const activationCalls = []
	let mixedSnapshotObserved = false
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
			protocolVersion: 33,
			buildId: 'profile-attestation',
			uptime: 1,
			queue: { paused: false, pending: 0, active: 0, maxConcurrency: 1, activeTasks: [] },
			projects: [],
			pollInterval: 60,
			profile: profile(activeProfileId),
			profileGeneration: generation,
		})
		if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, { data: status() })
		if (req.method === 'GET' && url.pathname === '/api/items') return send(res, 200, { data: [] })
		if (req.method === 'GET' && url.pathname === '/api/profiles') return send(res, 200, { data: state() })
		if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { data: null })
		if (req.method === 'POST' && url.pathname === '/api/daemon/restart') return send(res, 409, { error: 'attestation daemon is not managed' })
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
	return { server, baseUrl: `http://127.0.0.1:${address.port}`, activationCalls, mixedSnapshotObserved }
}

function spawnElectron(command, argv, env, timeout) {
	return new Promise((resolveChild, reject) => {
		const child = spawn(command, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', data => (stdout += data))
		child.stderr.on('data', data => (stderr += data))
		const timer = setTimeout(() => {
			child.kill('SIGTERM')
			reject(new Error(`Electron attestation timed out after ${timeout}ms: ${stderr.slice(-4000)}`))
		}, timeout)
		child.once('error', error => {
			clearTimeout(timer)
			reject(error)
		})
		child.once('exit', code => {
			clearTimeout(timer)
			resolveChild({ child, code, stdout, stderr })
		})
	})
}

async function stopChild(record) {
	if (!record.child || record.child.exitCode !== null) return
	record.child.kill('SIGTERM')
	await new Promise(resolveStop => setTimeout(resolveStop, 500))
	if (record.child.exitCode === null) record.child.kill('SIGKILL')
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

function execLines(command, args) {
	return new Promise(resolveLines => {
		execFile(command, args, { timeout: 5_000 }, (_error, stdout) => {
			resolveLines(stdout.split('\n').map(line => Number.parseInt(line.trim(), 10)).filter(pid => Number.isFinite(pid) && pid > 0))
		})
	})
}

async function terminateOwnedSocketHolders(root) {
	let touched = false
	for (const socket of socketFiles(root)) {
		if (relative(root, socket).startsWith('..')) throw new Error(`Refusing to inspect non-owned socket: ${socket}`)
		const pids = new Set([...(await execLines('lsof', ['-t', '--', socket])), ...(await execLines('pgrep', ['-f', socket]))])
		for (const pid of pids) {
			if (pid === process.pid) continue
			try {
				process.kill(pid, 'SIGTERM')
				touched = true
			} catch {
				// Process already exited.
			}
		}
	}
	return touched || socketFiles(root).length === 0
}
