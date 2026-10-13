import assert from 'node:assert/strict'
import { test } from 'node:test'
import warmModule from '../app/src/terminal-warm.ts'
import type { WarmProcess, WarmSpawn } from '../app/src/terminal-warm.ts'

const { TerminalWarmPool } = warmModule

class FakeProcess implements WarmProcess {
	readonly data: Array<(data: string) => void> = []
	readonly exits: Array<(exitCode: number) => void> = []
	killed = false
	resized: Array<{ cols: number; rows: number }> = []

	resize(cols: number, rows: number): void {
		this.resized.push({ cols, rows })
	}

	kill(): void {
		this.killed = true
		for (const listener of this.exits) listener(0)
	}

	onData(listener: (data: string) => void): () => void {
		this.data.push(listener)
		return () => {
			const index = this.data.indexOf(listener)
			if (index >= 0) this.data.splice(index, 1)
		}
	}

	onExit(listener: (exitCode: number) => void): () => void {
		this.exits.push(listener)
		return () => {
			const index = this.exits.indexOf(listener)
			if (index >= 0) this.exits.splice(index, 1)
		}
	}

	emit(data: string): void {
		for (const listener of [...this.data]) listener(data)
	}
}

function pool() {
	const killed: string[] = []
	const procs: FakeProcess[] = []
	let next = 0
	const ready: Array<() => void> = []
	const retries: Array<() => void> = []
	let enabled = true
	let cwd = '/work'
	let token = 'work:1'
	const value = new TerminalWarmPool({
		enabled: () => enabled,
		cwd: () => cwd,
		profileToken: () => token,
		spawn: () => {
			const proc = new FakeProcess()
			procs.push(proc)
			next += 1
			return { sessionId: `s${next}`, proc } satisfies WarmSpawn
		},
		killSession: sessionId => {
			killed.push(sessionId)
		},
		scheduleReady: callback => {
			ready.push(callback)
			return {
				cancel: () => {
					const index = ready.indexOf(callback)
					if (index >= 0) ready.splice(index, 1)
				},
			}
		},
		scheduleRetry: callback => {
			retries.push(callback)
			return {
				cancel: () => {
					const index = retries.indexOf(callback)
					if (index >= 0) retries.splice(index, 1)
				},
			}
		},
	})
	return {
		value,
		killed,
		procs,
		ready,
		retries,
		setEnabled: (nextEnabled: boolean) => {
			enabled = nextEnabled
		},
		setCwd: (nextCwd: string) => {
			cwd = nextCwd
		},
		setToken: (nextToken: string) => {
			token = nextToken
		},
	}
}

test('a prestarted shell is claimable only after startup output goes quiet', () => {
	const harness = pool()
	harness.value.ensure()
	assert.equal(harness.value.claim('work:1', '/work'), null)
	harness.procs[0]?.emit('prompt')
	assert.equal(harness.value.claim('work:1', '/work'), null)
	harness.ready[0]?.()
	const claimed = harness.value.claim('work:1', '/work')
	assert.equal(claimed?.sessionId, 's1')
	assert.equal(claimed?.prelude, 'prompt')
	assert.equal(harness.procs[0]?.data.length, 0)
	assert.equal(harness.procs.length, 2)
})

test('a cwd or profile change kills the unclaimed shell instead of handing it over', () => {
	const harness = pool()
	harness.value.ensure()
	harness.procs[0]?.emit('old')
	harness.ready[0]?.()
	harness.setCwd('/other')
	assert.equal(harness.value.claim('work:1', '/other'), null)
	assert.equal(harness.procs[0]?.killed, true)
	assert.deepEqual(harness.killed, ['s1'])
	assert.equal(harness.procs.length, 2)
	assert.equal(harness.procs[1]?.killed, false)
})

test('discard kills the unclaimed shell and does not respawn it', () => {
	const harness = pool()
	harness.value.ensure()
	harness.value.discard()
	assert.equal(harness.procs[0]?.killed, true)
	assert.deepEqual(harness.killed, ['s1'])
	assert.equal(harness.retries.length, 0)
	assert.equal(harness.procs.length, 1)
})

test('an unexpected exit retries later instead of spinning', () => {
	const harness = pool()
	harness.value.ensure()
	for (const listener of harness.procs[0]?.exits ?? []) listener(0)
	assert.equal(harness.procs.length, 1)
	assert.equal(harness.retries.length, 1)
	harness.retries[0]?.()
	assert.equal(harness.procs.length, 2)
})
