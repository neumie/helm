import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchWorkspace } from '../scripts/workspace-launcher.mjs'

function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const root = mkdtempSync(join(tmpdir(), 'helm-remote-launcher-'))
	const script = join(root, 'child.cjs')
	const log = join(root, 'events')
	writeFileSync(
		script,
		`
const fs = require('node:fs');
const role = process.env.TEST_ROLE;
const log = text => fs.appendFileSync(process.env.TEST_LOG, text + '\\n');
log(role + ':start');
process.on('SIGTERM', () => { log(role + ':stop'); process.exit(0); });
process.on('SIGINT', () => { log(role + ':stop'); process.exit(0); });
if (role === 'fail') process.exit(2);
else if (role === 'desktop') setTimeout(() => process.exit(0), 30);
else { if (role === 'host' || role === 'reused-host') process.send({ type: 'helm-remote-ready', reused: role === 'reused-host' }); setInterval(() => {}, 1000); }
`,
	)
	const running: Awaited<ReturnType<typeof launchWorkspace>>[] = []
	t.after(async () => {
		await Promise.all(running.map(workspace => workspace.stop()))
		rmSync(root, { recursive: true, force: true })
	})
	const spec = (role: string) => ({
		command: process.execPath,
		args: [script],
		cwd: root,
		env: { ...process.env, TEST_ROLE: role, TEST_LOG: log },
	})
	return { spec, running, events: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') }
}

test('combined launcher keeps Remote alive after desktop exit and stops only its owned children', async t => {
	const f = fixture(t)
	const messages: string[] = []
	const workspace = await launchWorkspace({
		remote: f.spec('host'),
		desktop: f.spec('desktop'),
		report: message => messages.push(message),
		// Background CPU contention can delay a disposable Node IPC fixture; this
		// test-only slack does not change the launcher's production deadline.
		readyTimeoutMs: 30_000,
	})
	f.running.push(workspace)
	let hostEnded = false
	void workspace.remoteExited.then(() => {
		hostEnded = true
	})
	assert.equal((await workspace.desktopExited).code, 0)
	assert.equal(hostEnded, false)
	assert.ok(messages.some(message => message.includes('Remote is still running')))
	await Promise.all([workspace.stop(), workspace.stop()])
	assert.equal((await workspace.remoteExited).code, 0)
	assert.equal(f.events().split('host:stop').length - 1, 1)
})

test('reused Remote completion has the same array result shape as a newly owned host', async t => {
	const f = fixture(t)
	const workspace = await launchWorkspace({ remote: f.spec('reused-host'), desktop: f.spec('desktop') })
	f.running.push(workspace)
	const result = await workspace.finished
	assert.deepEqual(result, [{ code: 0, signal: null }])
})

test('failed Remote startup never launches desktop', async t => {
	const f = fixture(t)
	await assert.rejects(launchWorkspace({ remote: f.spec('fail'), desktop: f.spec('desktop') }), /before becoming ready/)
	assert.equal(f.events().includes('desktop:start'), false)
})

test('failed desktop spawn cleans up only the newly owned Remote host', async t => {
	const f = fixture(t)
	await assert.rejects(
		launchWorkspace({
			remote: f.spec('host'),
			desktop: { ...f.spec('desktop'), command: '/no-such-helm-test-executable' },
		}),
		/Could not launch the desktop app/,
	)
	assert.ok(f.events().includes('host:stop'))
})

test('pre-aborted launcher admits no processes; abort during readiness never launches desktop', async t => {
	const f = fixture(t)
	const preAborted = new AbortController()
	preAborted.abort()
	await assert.rejects(
		launchWorkspace({ remote: f.spec('host'), desktop: f.spec('desktop'), signal: preAborted.signal }),
	)
	assert.equal(f.events(), '')
	const controller = new AbortController()
	const starting = launchWorkspace({ remote: f.spec('waiting'), desktop: f.spec('desktop'), signal: controller.signal })
	const timer = setTimeout(() => controller.abort('SIGINT'), 30)
	try {
		await assert.rejects(starting)
	} finally {
		clearTimeout(timer)
	}
	assert.equal(f.events().includes('desktop:start'), false)
})
