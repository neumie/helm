#!/usr/bin/env node
// Opt-in, disposable proof for the live-socket assumption behind profile moves.
// It never reads HELM_SOCKET_DIR and never scans Helm/Okena/default namespaces.
// Run: node app/scripts/profile-terminal-move-attestation.mjs --require-dtach

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
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
const sessionId = 'canary-session'
const source = join(sourceDir, `${sessionId}.sock`)
const destination = join(destinationDir, `${sessionId}.sock`)
const work = join(root, 'work')
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

function isAlive(pid) {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function masterFingerprint(pid) {
	return execFileSync('ps', ['-p', String(pid), '-o', 'pid=', '-o', 'lstart='], { encoding: 'utf8' }).trim()
}

function masterCommand(pid) {
	return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
}

// Mirrors terminal-transfer's recovery evidence contract without importing the
// Electron main module. The caller establishes the current entry from this
// canary's own isolated filesystem; the master command must still attest the
// original pathname after rename.
function recoveryMasterEvidence(identity, currentSocketPath) {
	if (!isAlive(identity.pid)) return { state: 'dead' }
	try {
		return {
			state: 'present',
			pid: identity.pid,
			processStartFingerprint: masterFingerprint(identity.pid),
			originalSocketPath: masterCommand(identity.pid).includes(identity.originalSocketPath)
				? identity.originalSocketPath
				: '<unattested-original-socket>',
			currentSocketPath,
		}
	} catch {
		return { state: 'unknown' }
	}
}

function assertVerifiedRecoveryMaster(identity, currentSocketPath) {
	const evidence = recoveryMasterEvidence(identity, currentSocketPath)
	if (
		evidence.state !== 'present' ||
		evidence.pid !== identity.pid ||
		evidence.processStartFingerprint !== identity.fingerprint ||
		evidence.originalSocketPath !== identity.originalSocketPath ||
		evidence.currentSocketPath !== currentSocketPath
	) {
		throw new Error(`recovery master identity is not verified: ${JSON.stringify(evidence)}`)
	}
	return evidence
}

function ownedMasterPid(originalSocketPath) {
	const candidates = execFileSync('pgrep', ['-f', originalSocketPath], { encoding: 'utf8' })
		.split('\n')
		.map(value => Number.parseInt(value, 10))
		.filter(Number.isFinite)
		.filter(pid => pid !== process.pid)
		.filter(pid => {
			try {
				const command = masterCommand(pid)
				return command.includes('dtach') && command.includes(originalSocketPath)
			} catch {
				return false
			}
		})
	if (candidates.length !== 1)
		throw new Error(`expected one owned dtach master, found ${candidates.join(', ') || 'none'}`)
	return candidates[0]
}

function runExpect(program) {
	return new Promise((resolve, reject) => {
		const child = spawn('/usr/bin/expect', ['-c', program], { stdio: ['ignore', 'pipe', 'pipe'] })
		let output = ''
		child.stdout.on('data', chunk => {
			output += chunk
		})
		child.stderr.on('data', chunk => {
			output += chunk
		})
		child.once('error', reject)
		child.once('exit', code => (code === 0 ? resolve(output) : reject(new Error(`expect exited ${code}: ${output}`))))
	})
}

async function attachAndRun(socket, command) {
	// Destination verification is deliberately attach-only (`-a`): it must
	// never create a replacement master through `-A`. Escape Tcl interpolation
	// so shell variables such as $PWD reach the disposable shell unchanged.
	const sendCommand = `${command}\r`.replaceAll('$', '\\$')
	return runExpect(
		[
			'set timeout 8',
			`spawn dtach -a ${JSON.stringify(socket)} -E -r winch`,
			`send -- ${JSON.stringify(sendCommand)}`,
			'expect { "MOVE_CANARY" {} timeout { exit 1 } }',
			'after 100',
			'exit 0',
		].join('; '),
	)
}

function attachAndHold(socket) {
	const program = [
		'set timeout 8',
		`spawn dtach -a ${JSON.stringify(socket)} -E -r winch`,
		'send -- "printf ATTACHED_BEFORE\\r"',
		'expect { "ATTACHED_BEFORE" {} timeout { exit 1 } }',
		'after 15000',
	].join('; ')
	const child = spawn('/usr/bin/expect', ['-c', program], { stdio: ['ignore', 'pipe', 'pipe'] })
	let output = ''
	const attached = new Promise((resolve, reject) => {
		const onData = chunk => {
			output += chunk
			if (output.includes('ATTACHED_BEFORE')) resolve()
		}
		child.stdout.on('data', onData)
		child.stderr.on('data', onData)
		child.once('error', reject)
		child.once('exit', code => {
			if (!output.includes('ATTACHED_BEFORE')) reject(new Error(`attached-client exited ${code}: ${output}`))
		})
	})
	const exited = new Promise(resolve => child.once('exit', () => resolve()))
	return { child, attached, exited }
}

function terminateVerifiedMaster(identity) {
	if (!isAlive(identity.pid) || masterFingerprint(identity.pid) !== identity.fingerprint) {
		throw new Error('refusing cleanup: captured master PID/start fingerprint no longer matches')
	}
	if (!masterCommand(identity.pid).includes(identity.originalSocketPath)) {
		throw new Error('refusing cleanup: captured master no longer advertises its original owned socket path')
	}
	// The detached child owns this fresh process group. Killing it is scoped to
	// the canary master and shell only; no holder discovery runs against a shared
	// Helm/Okena/default pool.
	process.kill(-identity.pid, 'SIGTERM')
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
	mkdirSync(work, { recursive: true, mode: 0o700 })
	// -n creates the sole disposable master. The command remains a normal shell
	// so the attached-client and post-rename destination attach both prove cwd
	// and output continuity without creating a second session.
	master = spawn('dtach', ['-n', source, '/bin/sh', '-l'], { cwd: work, stdio: 'ignore', detached: true })
	master.unref()
	await waitFor(() => existsSync(source), 'source dtach socket')
	// `dtach -n` daemonizes, so the launcher child can exit while the master
	// continues. The source pathname is unique under this mktemp root and is
	// used only to identify that owned master before its rename.
	const masterPid = ownedMasterPid(source)
	master = { pid: masterPid }
	const identity = {
		pid: masterPid,
		fingerprint: masterFingerprint(masterPid),
		originalSocketPath: source,
	}
	const sourceEvidence = assertVerifiedRecoveryMaster(identity, source)
	const sourceStat = statSync(source)

	// Rename while an ordinary attach client is live, then detach only that
	// client. The master must continue to be the captured process.
	const attached = attachAndHold(source)
	await attached.attached
	renameSync(source, destination)
	if (existsSync(source) || !existsSync(destination))
		throw new Error('socket rename did not produce exactly one destination entry')
	const destinationStat = statSync(destination)
	if (sourceStat.dev !== destinationStat.dev) throw new Error('socket device changed across same-filesystem rename')
	if (typeof sourceStat.ino === 'number' && sourceStat.ino !== 0 && sourceStat.ino !== destinationStat.ino) {
		throw new Error('socket inode changed across rename')
	}
	const movedEvidence = assertVerifiedRecoveryMaster(identity, destination)
	process.kill(attached.child.pid, 'SIGTERM')
	await attached.exited

	const output = await attachAndRun(destination, 'pwd; printf "MOVE_CANARY\\n"')
	if (!output.includes(work) || !output.includes('MOVE_CANARY')) {
		throw new Error(`destination attach lost cwd/output marker: ${output}`)
	}
	const destinationEvidence = assertVerifiedRecoveryMaster(identity, destination)

	terminateVerifiedMaster(identity)
	await waitFor(() => !isAlive(identity.pid), 'verified canary master exit')
	// dtach retains the original path in argv after rename and may clean only
	// that name. Once the verified owner is dead, remove its moved entry only.
	if (existsSync(destination)) unlinkSync(destination)
	if (existsSync(source) || existsSync(destination)) throw new Error('owned canary socket cleanup was incomplete')
	console.log(
		JSON.stringify({
			status: 'passed',
			root,
			userData,
			sessionId,
			sourceAbsent: !existsSync(source),
			destinationPresentBeforeCleanup: true,
			masterPid: identity.pid,
			masterStartFingerprint: identity.fingerprint,
			recoveryEvidence: {
				source: sourceEvidence,
				moved: movedEvidence,
				destination: destinationEvidence,
			},
			socketDevice: destinationStat.dev,
			socketInode: destinationStat.ino,
			attachedRename: true,
			destinationAttachOnly: true,
			verifiedOwnedCleanup: true,
		}),
	)
} catch (error) {
	fail(error instanceof Error ? error.message : String(error))
} finally {
	// This script owns only its detached process group and mktemp root. It never
	// reads, scans, renames, attaches, or terminates a default/session pool.
	if (master?.pid && isAlive(master.pid)) {
		try {
			process.kill(-master.pid, 'SIGTERM')
		} catch {
			// already exited
		}
	}
	try {
		rmSync(root, { recursive: true, force: true })
	} catch {
		// cleanup failure is reported only by a retained temp root, never a shared socket pool
	}
}
