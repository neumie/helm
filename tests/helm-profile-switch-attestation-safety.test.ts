import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
	findConflictingHelmDesktopPids,
	isAttestedDtachCommand,
	terminateOwnedProcessGroup,
} from '../app/scripts/profile-switch-attestation-safety.mjs'
import safetyModule from '../app/src/profile-switch-attestation'

const { parseProfileSwitchAttestationLaunch } = safetyModule as typeof import('../app/src/profile-switch-attestation')

function isolatedLaunchFixture() {
	const root = mkdtempSync(join(tmpdir(), 'hpsa-safety-'))
	chmodSync(root, 0o700)
	const userDataDir = join(root, 'user-data')
	const socketRoot = join(root, 's')
	const homeDir = join(root, 'home')
	const xdgConfig = join(homeDir, '.config')
	const xdgState = join(homeDir, '.local', 'state')
	const xdgCache = join(homeDir, '.cache')
	const xdgData = join(homeDir, '.local', 'share')
	const xdgRuntime = join(homeDir, '.runtime')
	for (const directory of [userDataDir, socketRoot, homeDir, xdgConfig, xdgState, xdgCache, xdgData, xdgRuntime]) {
		mkdirSync(directory, { recursive: true, mode: 0o700 })
	}
	const capability = 'attestation-capability-test'
	writeFileSync(join(root, '.attestation-capability'), capability, { mode: 0o600 })
	const evidencePath = join(root, 'child-evidence.json')
	const argv = [
		'electron',
		'app',
		`--user-data-dir=${userDataDir}`,
		`--profile-switch-attestation=${evidencePath}`,
		'--profile-switch-attestation-marker=marker-test',
	]
	const env = {
		HELM_PROFILE_SWITCH_ATTESTATION_ROOT: root,
		HELM_PROFILE_SWITCH_ATTESTATION_CAPABILITY: capability,
		HELM_SOCKET_DIR: socketRoot,
		HOME: homeDir,
		ZDOTDIR: homeDir,
		HISTFILE: join(homeDir, '.zsh_history'),
		XDG_CONFIG_HOME: xdgConfig,
		XDG_STATE_HOME: xdgState,
		XDG_CACHE_HOME: xdgCache,
		XDG_DATA_HOME: xdgData,
		XDG_RUNTIME_DIR: xdgRuntime,
	}
	return { root, userDataDir, socketRoot, homeDir, xdgConfig, evidencePath, argv, env }
}

test('profile-switch attestation mode requires an exact private temp capability namespace', () => {
	const fixture = isolatedLaunchFixture()
	let externalDirectory: string | null = null
	try {
		const launch = parseProfileSwitchAttestationLaunch(fixture.argv, fixture.env)
		assert.ok(launch)
		assert.equal(launch.root, fixture.root)
		assert.equal(launch.userDataDir, fixture.userDataDir)
		assert.equal(launch.socketRoot, fixture.socketRoot)
		assert.equal(launch.homeDir, fixture.homeDir)
		assert.equal(launch.evidencePath, fixture.evidencePath)
		assert.equal(launch.marker, 'marker-test')

		assert.throws(
			() =>
				parseProfileSwitchAttestationLaunch(fixture.argv, {
					...fixture.env,
					HELM_PROFILE_SWITCH_ATTESTATION_ROOT: undefined,
				}),
			/Profile-switch attestation requires an isolated root/,
		)
		assert.throws(
			() =>
				parseProfileSwitchAttestationLaunch(
					fixture.argv.map(argument =>
						argument.startsWith('--user-data-dir=')
							? '--user-data-dir=/Users/example/Library/Application Support/Helm'
							: argument,
					),
					fixture.env,
				),
			/userData path escaped its isolated root/,
		)
		assert.throws(
			() => parseProfileSwitchAttestationLaunch(fixture.argv, { ...fixture.env, HELM_SOCKET_DIR: '/tmp/helm-501' }),
			/socket path escaped its isolated root/,
		)
		assert.throws(
			() => parseProfileSwitchAttestationLaunch(fixture.argv, { ...fixture.env, HOME: '/Users/example' }),
			/HOME escaped its isolated root/,
		)
		assert.throws(
			() => parseProfileSwitchAttestationLaunch(fixture.argv, { ...fixture.env, ZDOTDIR: '/Users/example' }),
			/ZDOTDIR escaped its isolated root/,
		)
		assert.throws(
			() =>
				parseProfileSwitchAttestationLaunch(fixture.argv, { ...fixture.env, HISTFILE: '/Users/example/.zsh_history' }),
			/HISTFILE escaped its isolated root/,
		)
		assert.throws(
			() => parseProfileSwitchAttestationLaunch(fixture.argv, { ...fixture.env, XDG_RUNTIME_DIR: '/tmp/runtime' }),
			/XDG runtime path escaped its isolated root/,
		)
		assert.throws(
			() =>
				parseProfileSwitchAttestationLaunch(fixture.argv, {
					...fixture.env,
					HELM_PROFILE_SWITCH_ATTESTATION_CAPABILITY: 'wrong',
				}),
			/capability mismatch/,
		)

		externalDirectory = mkdtempSync(join(tmpdir(), 'hpsa-external-xdg-'))
		rmSync(fixture.xdgConfig, { recursive: true, force: true })
		symlinkSync(externalDirectory, fixture.xdgConfig, 'dir')
		assert.throws(
			() => parseProfileSwitchAttestationLaunch(fixture.argv, fixture.env),
			/private non-symlink directory tree|escaped its isolated root/,
		)
	} finally {
		rmSync(fixture.root, { recursive: true, force: true })
		if (externalDirectory) rmSync(externalDirectory, { recursive: true, force: true })
	}
})

test('ordinary Helm launch does not require an attestation namespace', () => {
	assert.equal(parseProfileSwitchAttestationLaunch(['electron', 'app'], {}), null)
})

test('attestation preflight detects existing dev and packaged Helm desktops only', () => {
	const electronLauncher = '/repo/helm/app/node_modules/.bin/electron'
	const electronExecutable = '/repo/helm/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
	const appRoot = '/repo/helm/app'
	const processList = [
		' 100 /opt/homebrew/bin/node /repo/helm/app/node_modules/.bin/electron .',
		' 101 /Applications/Helm.app/Contents/MacOS/Helm',
		' 102 /Applications/Other.app/Contents/MacOS/Other',
		' 103 /repo/helm/app/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper --app-path=/repo/helm/app',
		' 104 node app/scripts/profile-switch-attestation.mjs',
		' 105 /repo/helm/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .',
		' 106 /opt/homebrew/bin/node /another/checkout/app/node_modules/.bin/electron .',
	].join('\n')
	assert.deepEqual(
		findConflictingHelmDesktopPids(processList, { electronLauncher, electronExecutable, appRoot, currentPid: 104 }),
		[100, 101, 103, 105, 106],
	)
})

test('socket cleanup accepts only an exact dtach command and socket', () => {
	const socket = '/private/tmp/hpsa-safe/s/session.sock'
	assert.equal(
		isAttestedDtachCommand(
			`/opt/homebrew/bin/dtach -A ${socket} -E -r winch /bin/zsh -l`,
			socket,
			'/opt/homebrew/bin/dtach',
		),
		true,
	)
	assert.equal(isAttestedDtachCommand(`node helper.js ${socket}`, socket, '/opt/homebrew/bin/dtach'), false)
	assert.equal(
		isAttestedDtachCommand(`/opt/homebrew/bin/dtach -E -A ${socket}`, socket, '/opt/homebrew/bin/dtach'),
		false,
	)
	assert.equal(
		isAttestedDtachCommand(`/opt/homebrew/bin/dtach -A /tmp/other.sock ${socket}`, socket, '/opt/homebrew/bin/dtach'),
		false,
	)
	assert.equal(
		isAttestedDtachCommand(
			'/opt/homebrew/bin/dtach -A /tmp/another.sock -E -r winch /bin/zsh',
			socket,
			'/opt/homebrew/bin/dtach',
		),
		false,
	)
})

test('owned process-group cleanup waits for both parent and descendant termination', async () => {
	const childScript = `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)`
	const owned = spawn(process.execPath, ['-e', childScript], { detached: true, stdio: 'ignore' })
	assert.ok(owned.pid)
	try {
		await new Promise(resolve => setTimeout(resolve, 100))
		const firstCleanup = terminateOwnedProcessGroup(owned.pid, { termTimeoutMs: 500, killTimeoutMs: 2_000 })
		const duplicateCleanup = terminateOwnedProcessGroup(owned.pid, { termTimeoutMs: 1, killTimeoutMs: 1 })
		assert.equal(duplicateCleanup, firstCleanup, 'timeout and finally must share one cleanup owner')
		await firstCleanup
		assert.throws(() => process.kill(owned.pid as number, 0))
	} finally {
		try {
			process.kill(-(owned.pid as number), 'SIGKILL')
		} catch {
			// The expected path already emptied the complete process group.
		}
	}
})

test('the real attestation entrypoint refuses to spawn beside an existing Helm desktop process', async t => {
	if (process.platform !== 'darwin') return t.skip('macOS Electron canary only')
	const electronLauncher = join(process.cwd(), 'app', 'node_modules', '.bin', 'electron')
	if (!existsSync(electronLauncher) || !existsSync(join(process.cwd(), 'app', 'dist', 'main.cjs'))) {
		return t.skip('built Electron app unavailable')
	}
	const root = mkdtempSync(join(tmpdir(), 'hpsa-live-desktop-guard-'))
	const evidencePath = join(root, 'evidence.json')
	const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)', electronLauncher], {
		stdio: 'ignore',
	})
	try {
		await new Promise(resolve => setTimeout(resolve, 100))
		const result = await new Promise<{ code: number; stdout: string; stderr: string }>(resolveResult => {
			execFile(
				process.execPath,
				['app/scripts/profile-switch-attestation.mjs', `--output=${evidencePath}`],
				{ timeout: 10_000 },
				(error, stdout, stderr) => {
					resolveResult({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr })
				},
			)
		})
		assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`)
		const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as { result: string; skipReason?: string }
		assert.equal(evidence.result, 'skipped')
		assert.match(evidence.skipReason ?? '', /Electron\/Helm desktop already running/)
		assert.equal(sentinel.exitCode, null, 'the sentinel desktop process must remain alive')
	} finally {
		sentinel.kill('SIGTERM')
		rmSync(root, { recursive: true, force: true })
	}
})
