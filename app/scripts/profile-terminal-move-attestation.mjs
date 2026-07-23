#!/usr/bin/env node
// Opt-in, disposable proof for the live-socket assumption behind profile moves.
// It never reads HELM_SOCKET_DIR and never scans Helm/Okena/default namespaces.
// Run: node app/scripts/profile-terminal-move-attestation.mjs --require-dtach

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const requiredDtach = process.argv.includes('--require-dtach')
const requiredElectron = process.argv.includes('--require-electron')
const root = mkdtempSync(join(tmpdir(), 'helm-profile-terminal-move-'))
const userData = join(root, 'user-data')
const sockets = join(root, 'sockets')
const sourceDir = join(sockets, 'source')
const destinationDir = join(sockets, 'destination')
const source = join(sourceDir, 'canary.sock')
const destination = join(destinationDir, 'canary.sock')
let master

function fail(message) {
	console.error(`profile terminal move attestation: ${message}`)
	process.exitCode = 1
}

function commandExists(command) {
	try {
		execFileSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

function waitFor(predicate, label, timeout = 3000) {
	const deadline = Date.now() + timeout
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (predicate()) return resolve()
			if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${label}`))
			setTimeout(tick, 25)
		}
		tick()
	})
}

async function attachAndRun(socket, command) {
	// expect supplies a disposable pty. The post-rename invocation is strictly
	// attach-only (`-a`): it must never create a replacement master via `-A`.
	const program = [
		'set timeout 8',
		`spawn dtach -a ${JSON.stringify(socket)} -E -r winch`,
		`send -- ${JSON.stringify(`${command}\r`)}`,
		'expect { "MOVE_CANARY" {} timeout { exit 1 } }',
		'send -- "exit\\r"',
		'expect eof',
	].join('; ')
	return new Promise((resolve, reject) => {
		const child = spawn('/usr/bin/expect', ['-c', program], { stdio: 'ignore' })
		child.once('error', reject)
		child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`attach-only dtach exited ${code}`))))
	})
}

try {
	if (process.platform !== 'darwin')
		throw new Error('macOS-only canary; run the supported-platform equivalent elsewhere')
	if (!commandExists('dtach')) {
		if (requiredDtach) throw new Error('dtach is required but unavailable')
		console.log('SKIP: dtach unavailable (not required)')
		process.exit(0)
	}
	if (!existsSync('/usr/bin/expect')) throw new Error('expect is required for a disposable attach-only pty')
	if (requiredElectron && !existsSync(join(process.cwd(), 'app', 'node_modules', 'electron'))) {
		throw new Error('Electron is required but app/node_modules/electron is unavailable')
	}
	mkdirSync(sourceDir, { recursive: true, mode: 0o700 })
	mkdirSync(destinationDir, { recursive: true, mode: 0o700 })
	mkdirSync(userData, { recursive: true, mode: 0o700 })
	// -n creates the sole disposable master. The command remains a normal shell
	// so the attach-only client can prove cwd and continuity after rename.
	master = spawn('dtach', ['-n', source, '/bin/sh', '-l'], { cwd: root, stdio: 'ignore', detached: true })
	master.unref()
	await waitFor(() => existsSync(source), 'source dtach socket')
	const originalPid = master.pid
	renameSync(source, destination)
	if (existsSync(source) || !existsSync(destination))
		throw new Error('socket rename did not produce exactly one destination entry')
	process.kill(originalPid, 0)
	await attachAndRun(destination, 'pwd; printf MOVE_CANARY')
	process.kill(originalPid, 0)
	console.log(
		JSON.stringify({
			status: 'passed',
			root,
			userData,
			sourceAbsent: !existsSync(source),
			destinationPresent: existsSync(destination),
			masterPid: originalPid,
		}),
	)
} catch (error) {
	fail(error instanceof Error ? error.message : String(error))
} finally {
	// This script owns only its detached process and mktemp root. It never uses
	// lsof/pgrep over a shared namespace, so cleanup cannot touch user sessions.
	if (master?.pid) {
		try {
			process.kill(-master.pid, 'SIGTERM')
		} catch {
			// master already exited after the disposable shell's exit
		}
	}
	try {
		rmSync(root, { recursive: true, force: true })
	} catch {
		// cleanup failure is reported only by a retained temp root, never a shared socket pool
	}
}
