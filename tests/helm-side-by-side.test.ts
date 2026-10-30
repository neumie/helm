import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import helmBridgeModule from '../app/src/helm-bridge.ts'
import type { HelmBridgeRequest } from '../app/src/helm-bridge.ts'
import type { HelmResult } from '../app/src/shared-helm.ts'
import sideBySideModule from '../app/src/side-by-side.ts'

type SideBySideModule = typeof import('../app/src/side-by-side.ts')
type HelmBridgeModule = typeof import('../app/src/helm-bridge.ts')
const { SIDE_BY_SIDE_READ_ONLY_ERROR, SIDE_BY_SIDE_TITLE, parseSideBySideLaunch, sideBySideRequested, startupPolicy } =
	sideBySideModule as SideBySideModule
const { HelmBridge } = helmBridgeModule as HelmBridgeModule

const appData = '/Users/op/Library/Application Support'
const dedicated = `${appData}/Helm-dock-dev`

function launch(overrides: {
	argv?: string[]
	env?: Record<string, string | undefined>
	screenshot?: boolean
	attestation?: boolean
	realpath?: (existing: string) => string
}) {
	return parseSideBySideLaunch({
		argv: overrides.argv ?? ['electron', '.', `--user-data-dir=${dedicated}`],
		env: overrides.env ?? { HELM_SIDE_BY_SIDE: '1' },
		appDataDir: appData,
		appName: 'Helm',
		uid: 501,
		screenshot: overrides.screenshot ?? false,
		attestation: overrides.attestation ?? false,
		homeDir: '/Users/op',
		...(overrides.realpath ? { realpath: overrides.realpath } : {}),
	})
}

test('side-by-side is off unless HELM_SIDE_BY_SIDE=1', () => {
	assert.equal(launch({ env: {} }), null)
	assert.equal(launch({ env: { HELM_SIDE_BY_SIDE: '' } }), null)
	assert.equal(launch({ env: { HELM_SIDE_BY_SIDE: '0' } }), null)
	assert.throws(() => launch({ env: { HELM_SIDE_BY_SIDE: 'true' } }), /must be 1 or 0/)
	assert.equal(sideBySideRequested({}), false)
	assert.equal(sideBySideRequested({ HELM_SIDE_BY_SIDE: '0' }), false)
	// Requested-but-invalid still counts as requested, so the early read-only bridge fails safe.
	assert.equal(sideBySideRequested({ HELM_SIDE_BY_SIDE: 'true' }), true)
	assert.equal(sideBySideRequested({ HELM_SIDE_BY_SIDE: '1' }), true)
})

test('side-by-side gets a dedicated profile and an isolated socket root by default', () => {
	assert.deepEqual(launch({}), { userDataDir: dedicated, socketRoot: '/tmp/helm-dockdev-501' })
	assert.deepEqual(launch({ env: { HELM_SIDE_BY_SIDE: '1', HELM_SOCKET_DIR: '/tmp/hdd' } }), {
		userDataDir: dedicated,
		socketRoot: '/tmp/hdd',
	})
})

test('side-by-side refuses launches without a dedicated --user-data-dir', () => {
	assert.throws(() => launch({ argv: ['electron', '.'] }), /requires --user-data-dir/)
	assert.throws(() => launch({ argv: ['electron', '.', '--user-data-dir='] }), /requires --user-data-dir/)
	assert.throws(() => launch({ argv: ['electron', '.', '--user-data-dir-tmp'] }), /not --user-data-dir-tmp/)
	for (const shared of [
		`${appData}/Helm`,
		`${appData}/Helm/`,
		`${appData}/helm`,
		`${appData}/Helm/profiles/work`,
		`${appData}/Electron`,
		appData,
		'/Users/op/Library',
	]) {
		assert.throws(() => launch({ argv: ['electron', '.', `--user-data-dir=${shared}`] }), /refuses/, shared)
	}
})

test('side-by-side refuses the live terminal socket namespace', () => {
	for (const live of ['/tmp/helm-501', '/private/tmp/helm-501', '/tmp/helm-501/profiles/x', '/tmp']) {
		assert.throws(
			() => launch({ env: { HELM_SIDE_BY_SIDE: '1', HELM_SOCKET_DIR: live } }),
			/live terminal socket namespace/,
			live,
		)
	}
})

test('side-by-side refuses the live scheduled-run socket namespace', () => {
	for (const scheduled of ['/tmp/helm-sched-501', '/private/tmp/helm-sched-501/work', '/tmp']) {
		assert.throws(
			() => launch({ env: { HELM_SIDE_BY_SIDE: '1', HELM_SOCKET_DIR: scheduled } }),
			/socket namespace/,
			scheduled,
		)
	}
	assert.throws(
		() =>
			launch({ env: { HELM_SIDE_BY_SIDE: '1', HELM_SOCKET_DIR: '/tmp/x/sched', HELM_SCHEDULED_SOCKET_DIR: '/tmp/x' } }),
		/scheduled-run socket namespace/,
	)
})

test('side-by-side refuses other operator roots and sees through symlinks', () => {
	for (const shared of ['/Users/op/.helm', '/Users/op/.helm/remote', `${appData}/okena`]) {
		assert.throws(() => launch({ argv: ['electron', '.', `--user-data-dir=${shared}`] }), /refuses/, shared)
	}
	// ~/dev-profile is a symlink to the operator's profile: refused after resolving it.
	const realpath = (existing: string) => {
		if (existing === '/Users/op/dev-profile') return `${appData}/Helm`
		if (existing === '/Users/op' || existing === '/Users' || existing === '/') return existing
		throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
	}
	assert.throws(
		() => launch({ argv: ['electron', '.', '--user-data-dir=/Users/op/dev-profile/sub'], realpath }),
		/refuses the shared profile/,
	)
	assert.deepEqual(launch({ argv: ['electron', '.', '--user-data-dir=/Users/op/elsewhere'], realpath }), {
		userDataDir: '/Users/op/elsewhere',
		socketRoot: '/tmp/helm-dockdev-501',
	})
})

test('side-by-side main ignores deep links and keeps its launch knobs out of terminals', () => {
	assert.match(
		main,
		/app\.on\('open-url', \(event, url\) => \{\s*event\.preventDefault\(\)[\s\S]{0,200}if \(sideBySideLaunch\) \{/,
	)
	assert.match(main, /key === SIDE_BY_SIDE_ENV \|\| key === 'HELM_SOCKET_DIR'/)
	assert.match(
		main,
		/if \(sideBySideLaunch\) env\.HELM_AGENT_DOCK_DIR = path\.join\(app\.getPath\('userData'\), 'agent-dock'\)/,
	)
	const script = readFileSync(new URL('../app/scripts/side-by-side.sh', import.meta.url), 'utf8')
	assert.match(script, /DEV_BUNDLE_ID="com\.github\.Electron\.helm-dockdev"/)
	assert.match(script, /exec "\$ELECTRON_BIN" \./)
})

test('side-by-side cannot be combined with screenshot or attestation harnesses', () => {
	assert.throws(() => launch({ screenshot: true }), /--screenshot/)
	assert.throws(() => launch({ attestation: true }), /attestation/)
})

const base = {
	screenshot: false,
	attestation: false,
	sideBySide: false,
	customUserData: false,
	tmpUserData: false,
	agentDockEnv: undefined,
}

test('a normal launch owns every singleton effect', () => {
	assert.deepEqual(startupPolicy(base), {
		protocolHandlers: true,
		scheduledResidency: true,
		scheduledAttention: true,
		scheduledAttentionNotifier: true,
		documentReviewControl: true,
		daemonWrites: true,
		remotePairingWrites: true,
		agentDock: true,
		windowTitle: 'Helm',
	})
})

test('side-by-side skips every owner effect but keeps the agent dock', () => {
	const policy = startupPolicy({ ...base, sideBySide: true, customUserData: true })
	assert.deepEqual(policy, {
		protocolHandlers: false,
		scheduledResidency: false,
		scheduledAttention: false,
		scheduledAttentionNotifier: false,
		documentReviewControl: false,
		daemonWrites: false,
		remotePairingWrites: false,
		agentDock: true,
		windowTitle: SIDE_BY_SIDE_TITLE,
	})
	assert.equal(startupPolicy({ ...base, sideBySide: true, customUserData: true, agentDockEnv: '0' }).agentDock, false)
})

test('existing harness gating is preserved', () => {
	const screenshot = startupPolicy({ ...base, screenshot: true })
	assert.equal(screenshot.protocolHandlers, false)
	assert.equal(screenshot.scheduledResidency, false)
	assert.equal(screenshot.documentReviewControl, false)
	assert.equal(screenshot.scheduledAttentionNotifier, false)
	assert.equal(screenshot.scheduledAttention, true, 'screenshot constructs but never starts attention')
	assert.equal(screenshot.agentDock, false)
	assert.equal(startupPolicy({ ...base, screenshot: true, agentDockEnv: '1' }).agentDock, true)
	const attestation = startupPolicy({ ...base, attestation: true, agentDockEnv: '1' })
	assert.equal(attestation.scheduledAttention, false)
	assert.equal(attestation.agentDock, false)
	assert.equal(startupPolicy({ ...base, customUserData: true }).agentDock, false)
	assert.equal(startupPolicy({ ...base, tmpUserData: true }).agentDock, false)
	assert.equal(startupPolicy({ ...base, agentDockEnv: '0' }).agentDock, false)
})

test('a read-only bridge refuses every daemon write but still reads', async () => {
	const seen: string[] = []
	const request: HelmBridgeRequest = async <T>(method: string, path: string) => {
		seen.push(`${method} ${path}`)
		return { data: {} as T } satisfies HelmResult<T>
	}
	const bridge = new HelmBridge('http://127.0.0.1:1', () => true, {
		request,
		readOnly: { error: SIDE_BY_SIDE_READ_ONLY_ERROR },
	})
	const internals = bridge as unknown as {
		request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<HelmResult<unknown>>
	}
	assert.deepEqual(await internals.request('GET', '/items'), { data: {} })
	for (const method of ['POST', 'PUT'] as const) {
		assert.deepEqual(await internals.request(method, '/poll/watch', { watching: true }), {
			error: SIDE_BY_SIDE_READ_ONLY_ERROR,
			status: 403,
		})
	}
	assert.equal(
		(await bridge.scheduledResidentLease('issue', 'cap', 1000)).error,
		SIDE_BY_SIDE_READ_ONLY_ERROR,
		'scheduled lease is a write',
	)
	bridge.releaseTaskWatch()
	await new Promise(resolve => setImmediate(resolve))
	assert.deepEqual(seen, ['GET /items'], 'no write ever reached the daemon transport')
})

test('a read-only bridge never restarts a mismatched daemon', async () => {
	const seen: string[] = []
	const bridge = new HelmBridge('http://127.0.0.1:1', () => true, {
		request: async <T>(method: string, path: string) => {
			seen.push(`${method} ${path}`)
			return { data: {} as T }
		},
		readOnly: { error: SIDE_BY_SIDE_READ_ONLY_ERROR },
	})
	const restart = (bridge as unknown as { restartForProtocolMismatch(status: unknown): Promise<boolean> })
		.restartForProtocolMismatch
	const result = await restart.call(bridge, {
		protocolVersion: -1,
		buildId: 'other-build',
		queue: { active: 0 },
	})
	assert.equal(result, false)
	assert.deepEqual(seen, [])
})

const main = readFileSync(new URL('../app/src/main.ts', import.meta.url), 'utf8')

test('main.ts routes every singleton effect through the startup policy', () => {
	assert.match(main, /if \(launchPolicy\.protocolHandlers\) \{\s*for \(const scheme of \['helm', 'vigil'\]\)/)
	assert.match(main, /if \(launchPolicy\.scheduledResidency\) void scheduledResidency\.start\(\)/)
	assert.match(
		main,
		/if \(launchPolicy\.documentReviewControl\) \{\s*reviewControlStart = documentReviewControl\.start\(\)/,
	)
	assert.match(main, /if \(launchPolicy\.scheduledAttentionNotifier\) scheduledAttentionNotifier\?\.start\(\)/)
	assert.match(main, /if \(launchPolicy\.scheduledAttention\) \{\s*scheduledAdoption = new/)
	assert.match(main, /if \(launchPolicy\.scheduledAttention\) \{\s*scheduledAttentionNotifier = new/)
	assert.match(main, /const agentDockWatcher = launchPolicy\.agentDock/)
	assert.match(main, /title: launchPolicy\.windowTitle/)
	assert.match(main, /sideBySideRequested\(process\.env\) \? \{ readOnly:/)
	assert.match(main, /'remote-pairing:pair'[^\n]*\n\tif \(!launchPolicy\.remotePairingWrites\)/)
	assert.match(main, /'remote-pairing:revoke'[^\n]*\n\tif \(!launchPolicy\.remotePairingWrites\)/)
	assert.match(main, /function activateProfile[^\n]*\n[^\n]*\n\tif \(!launchPolicy\.daemonWrites\)/)
	// Side-by-side validation and socket isolation happen before userData/profile stores.
	const parse = main.indexOf('parseSideBySideLaunch({')
	const socket = main.indexOf('process.env.HELM_SOCKET_DIR = sideBySideLaunch.socketRoot')
	const userData = main.indexOf("app.setPath('userData'")
	const profiles = main.indexOf('new AppProfileStore(')
	assert.ok(parse > 0 && parse < socket && socket < userData && userData < profiles)
	// No direct legacy gating remains for the owner effects.
	assert.doesNotMatch(main, /if \(!screenshotPath && !profileSwitchAttestationMode\)/)
})

test('main.ts has no other OS-level singleton registrations to gate', () => {
	for (const api of [
		'requestSingleInstanceLock',
		'globalShortcut',
		'new Tray',
		'setLoginItemSettings',
		'autoUpdater',
		'setAsDefaultProtocolClient',
	]) {
		const count = main.split(api).length - 1
		assert.ok(
			api === 'setAsDefaultProtocolClient' ? count === 1 : count === 0,
			`${api} appears ${count}x; gate it via startupPolicy()`,
		)
	}
})
