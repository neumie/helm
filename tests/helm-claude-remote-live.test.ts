// Opt-in live check of "Claude in Helm terminals" against the real Claude Code:
//   HELM_LIVE_CLAUDE=1 node --import tsx --test tests/helm-claude-remote-live.test.ts
// Starts Helm's hub in-process (createClaudeRemote, as main.ts wires it), spawns
// its OWN claude processes through the Helm preload in node-pty panes on a scratch
// project, and drives the dock exactly as the renderer does (AgentDockWatcher.act).
// Only processes started here are killed. Costs a few small model calls.
//   HELM_LIVE_CLAUDE_DIR   scratch root (default: <tmp>/hcr-live-scratch)
//   HELM_LIVE_CLAUDE_MODEL model (default: claude-haiku-5-5)
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import sourceModule from '../app/src/agent-dock/okena-claude-source.ts'
import watcherModule from '../app/src/agent-dock/watcher.ts'
import runtimeModule from '../app/src/claude-remote/runtime.ts'

type DockItem = import('../app/src/agent-dock/model.ts').DockItem
type TerminalRef = import('../app/src/claude-remote/hub-core.ts').TerminalRef
const { OkenaClaudeSource } = sourceModule as typeof import('../app/src/agent-dock/okena-claude-source.ts')
const { AgentDockWatcher } = watcherModule as typeof import('../app/src/agent-dock/watcher.ts')
type RuntimeModule = typeof import('../app/src/claude-remote/runtime.ts')
const { createClaudeRemote, HOOK_FILE, PRELOAD_FILE } = runtimeModule as RuntimeModule

const LIVE = process.env.HELM_LIVE_CLAUDE === '1'
const MODEL = process.env.HELM_LIVE_CLAUDE_MODEL ?? 'claude-haiku-5-5'
const CLAUDE = process.env.HELM_LIVE_CLAUDE_BIN ?? 'claude'
const appRequire = createRequire(fileURLToPath(new URL('../app/package.json', import.meta.url)))

interface IPty {
	pid: number
	write(data: string): void
	kill(signal?: string): void
	onData(listener: (data: string) => void): void
	onExit(listener: (event: { exitCode: number }) => void): void
}
interface XTerm {
	write(data: string): void
	onData(listener: (data: string) => void): void
	buffer: {
		active: { length: number; getLine(index: number): { translateToString(trim: boolean): string } | undefined }
	}
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function cleanEnv(): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || /^(CLAUDE|OKENA_|HELM_|BUN_|SUPERSET)/.test(key)) continue
		env[key] = value
	}
	env.TERM = 'xterm-256color'
	return env
}

/** One Helm-like terminal: a pty running claude, rendered by xterm for the harness only. */
class Pane {
	readonly pty: IPty
	private readonly term: XTerm
	exited = false
	constructor(args: string[], env: Record<string, string>, cwd: string, file = CLAUDE) {
		const { spawn } = appRequire('node-pty') as { spawn(file: string, args: string[], options: object): IPty }
		const { Terminal } = appRequire('@xterm/xterm') as { Terminal: new (options: object) => XTerm }
		this.term = new Terminal({ cols: 120, rows: 45, allowProposedApi: true })
		this.pty = spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 45, cwd, env })
		this.pty.onData(data => this.term.write(data))
		this.term.onData(data => this.pty.write(data)) // terminal query replies, as a real terminal sends them
		this.pty.onExit(() => {
			this.exited = true
		})
	}
	screen(): string {
		const buffer = this.term.buffer.active
		const lines: string[] = []
		for (let index = 0; index < buffer.length; index++) lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
		return lines.join('\n')
	}
	write(data: string): void {
		this.pty.write(data)
	}
	async type(text: string): Promise<void> {
		this.pty.write(text)
		await sleep(400)
		this.pty.write('\r')
	}
	kill(): void {
		if (this.exited) return
		try {
			process.kill(-this.pty.pid, 'SIGTERM') // its own session (node-pty setsid): only what this pane started
		} catch {}
		try {
			this.pty.kill()
		} catch {}
	}
}

async function harness(name: string) {
	const root = mkdtempSync('/tmp/hcr-live-')
	const project = join(process.env.HELM_LIVE_CLAUDE_DIR ?? join(tmpdir(), 'hcr-live-scratch'), 'proj')
	mkdirSync(project, { recursive: true })
	const dist = join(root, 'dist')
	mkdirSync(dist)
	copyFileSync(
		fileURLToPath(new URL('../app/src/claude-remote/preload.cjs', import.meta.url)),
		join(dist, PRELOAD_FILE),
	)
	copyFileSync(
		fileURLToPath(new URL('../app/src/claude-remote/hook-client.cjs', import.meta.url)),
		join(dist, HOOK_FILE),
	)
	const panes = new Map<string, Pane>()
	/** Every byte the hub typed, per terminal (a reply must never reach a bare shell). */
	const typed = new Map<string, string[]>()
	const remote = createClaudeRemote({
		socketRoot: join(root, 's'),
		distDir: dist,
		userDataDir: join(root, 'ud'),
		agentDockDir: join(root, 'ud', 'agent-dock'),
		electronPath: process.execPath,
		activeProfileId: () => 'live',
		writeAttached: (ref, data) => {
			const pane = panes.get(ref.terminalId)
			if (!pane || pane.exited) return false
			typed.set(ref.terminalId, [...(typed.get(ref.terminalId) ?? []), data])
			pane.write(data)
			return true
		},
		dtachSocket: () => null,
		dtachBinary: () => null,
		terminalName: ref => `pane ${ref.terminalId}`,
		log: message => console.log(`[hub] ${message}`),
	})
	assert.ok(remote.runtime, 'runtime files written')
	assert.equal(await remote.start(), true, 'hub listening')

	// Every session id that reaches the hub (to prove nested/print claude send nothing).
	const seen = new Map<string, string[]>()
	const core = remote.hub.core
	const record = (kind: string, ref: TerminalRef, input: unknown) => {
		const sessionId = (input as { session_id?: unknown })?.session_id
		const key = `${ref.terminalId}:${String(sessionId)}`
		seen.set(key, [...(seen.get(key) ?? []), kind])
	}
	const event = core.event.bind(core)
	core.event = (ref, pid, at, input) => {
		record(String((input as { hook_event_name?: unknown }).hook_event_name), ref, input)
		return event(ref, pid, at, input)
	}
	const permission = core.permission.bind(core)
	core.permission = (ref, pid, at, input, hook) => {
		record('PermissionRequest', ref, input)
		return permission(ref, pid, at, input, hook)
	}
	const hookGone = core.hookGone.bind(core)
	const cancelled: string[] = []
	core.hookGone = (ref, dialogId) => {
		cancelled.push(dialogId)
		return hookGone(ref, dialogId)
	}

	const watcher = new AgentDockWatcher({
		dir: join(root, 'ud', 'agent-dock'),
		source: new OkenaClaudeSource(remote.hub, { name: 'Helm', notRunning: "Helm's Claude hub is not listening" }),
		publish: () => {},
		isFocused: () => true,
		log: () => {},
	})
	await watcher.load()
	const tick = async () => {
		await watcher.tick()
		await watcher.drain()
	}
	const until = async <T>(probe: () => T | undefined | null | false, label: string, ms = 120_000): Promise<T> => {
		const end = Date.now() + ms
		while (Date.now() < end) {
			await tick()
			const value = probe()
			if (value) return value
			await sleep(700)
		}
		throw new Error(`timed out: ${label}`)
	}
	const items = () => watcher.snapshot().items

	const claudeArgs = (extra: string[]) => ['--model', MODEL, '--setting-sources', 'local', ...extra]
	const listed = (terminalId: string) =>
		(remote.hub.core.stateJson('live') as { claude_sessions: string[] }).claude_sessions.includes(terminalId)
	const open = async (terminalId: string, extra: string[] = []): Promise<Pane> => {
		const ref: TerminalRef = { profileId: 'live', terminalId }
		const env = remote.environment(cleanEnv(), ref)
		assert.match(env.BUN_OPTIONS ?? '', /^--preload=\/tmp\/hcr-live-/)
		const pane = new Pane(claudeArgs(extra), env, project)
		panes.set(terminalId, pane)
		console.log(`[${name}] claude pid ${pane.pty.pid} in ${terminalId}`)
		await ready(pane, terminalId)
		return pane
	}
	/** A Helm-like terminal with a shell in it: what is left in the pty after claude ends. */
	const openShell = (terminalId: string): Pane => {
		const env = remote.environment(cleanEnv(), { profileId: 'live', terminalId })
		const pane = new Pane(['--noprofile', '--norc', '-i'], { ...env, PS1: 'hcr$ ' }, project, '/bin/bash')
		panes.set(terminalId, pane)
		console.log(`[${name}] bash pid ${pane.pty.pid} in ${terminalId}`)
		return pane
	}
	const ready = async (pane: Pane, terminalId: string): Promise<void> => {
		// Trust dialog: its default is "No, exit". Move down, verify the highlight, then Enter.
		const end = Date.now() + 90_000
		while (Date.now() < end) {
			const screen = pane.screen()
			if (screen.includes('trust this folder')) {
				if (/❯\s*(\d\.\s*)?Yes, I trust this folder/.test(screen)) {
					pane.write('\r')
					await sleep(2_000)
				} else {
					pane.write('\u001b[B')
					await sleep(600)
				}
				continue
			}
			// Ready = Helm's hub has the session (a structured signal, not the screen).
			if (listed(terminalId)) break
			if (pane.exited) throw new Error(`claude exited:\n${pane.screen()}`)
			await sleep(500)
		}
		await sleep(1_500)
	}

	const done = async () => {
		watcher.stop()
		await watcher.drain()
		for (const pane of panes.values()) pane.kill()
		await sleep(500)
		remote.stop()
		rmSync(root, { recursive: true, force: true })
	}
	return {
		root,
		project,
		remote,
		watcher,
		open,
		openShell,
		ready,
		claudeArgs,
		listed,
		typed,
		tick,
		until,
		items,
		seen,
		cancelled,
		panes,
		done,
	}
}

const askFor = (items: DockItem[], tool: string) =>
	items.find(
		item => item.kind === 'ask' && item.state === 'open' && item.fact.kind === 'ask' && item.fact.tool === tool,
	)
const turnWith = (items: DockItem[], pattern: RegExp, after = 0) =>
	items.find(
		item => item.kind === 'turn' && item.id > after && item.fact.kind === 'turn' && pattern.test(item.fact.text),
	)

test(
	'live: AskUserQuestion answered from the dock, Stop turn, dock reply, terminal answer, nested claude',
	{ skip: !LIVE, timeout: 600_000 },
	async () => {
		const h = await harness('ask')
		try {
			const pane = await h.open('t-ask', ['--permission-mode', 'default']) // auto mode (the default here) approves without a dialog
			const sessionId = (
				h.remote.hub.core.session({ profileId: 'live', terminalId: 't-ask' }) as { session_id: string }
			).session_id

			// 1. AskUserQuestion appears with the full questions and is answered via the dock act path.
			await pane.type(
				"Call the AskUserQuestion tool exactly once with a single question 'Which color?' (header 'Color'), two options labelled Red and Blue, multiSelect false. After my answer reply with only the chosen color name, nothing else.",
			)
			const ask = await h.until(() => askFor(h.items(), 'AskUserQuestion'), 'AskUserQuestion in the dock')
			const input = (
				ask.fact as { input: { questions: Array<{ question: string; options: Array<{ label: string }> }> } }
			).input
			console.log('[ask] questions:', JSON.stringify(input.questions))
			assert.equal(input.questions.length, 1)
			const blue = input.questions[0]?.options.findIndex(option => /blue/i.test(option.label)) ?? -1
			assert.ok(blue >= 0)
			const answered = await h.watcher.act({
				itemId: ask.id,
				rev: ask.rev,
				action: { type: 'answer', picks: [{ options: [blue] }] },
			})
			assert.equal(answered.ok, true, JSON.stringify(answered))

			// 2. Stop → a turn carrying last_assistant_message.
			const turn = await h.until(() => turnWith(h.items(), /blue/i), 'turn with the answer')
			console.log('[ask] turn:', JSON.stringify((turn.fact as { text: string }).text))
			const resolved = h.items().find(item => item.id === ask.id)
			console.log('[ask] ask item:', resolved?.state, JSON.stringify(resolved?.resolution))

			// 3. A dock reply is typed into the pane (bracketed paste + Enter) and runs.
			const replied = await h.watcher.act({
				itemId: turn.id,
				rev: turn.rev,
				action: { type: 'prompt', text: 'Now reply with only the word PONG.' },
			})
			assert.equal(replied.ok, true, JSON.stringify(replied))
			const pong = await h.until(() => turnWith(h.items(), /PONG/, turn.id), 'turn after the dock reply')
			console.log('[reply] turn:', JSON.stringify((pong.fact as { text: string }).text))

			// 4. Answered in the terminal: the waiting hook is released and the dock item resolves.
			const marker = join(h.project, `terminal-ok-${Date.now()}.txt`)
			// `touch` inside the project is auto-allowed (no dialog, seen live): use a command that asks.
			await pane.type(
				`Run exactly this one bash command and nothing else: python3 -c "open('${marker}', 'w').write('ok')"`,
			)
			const bash = await h.until(() => askFor(h.items(), 'Bash'), 'Bash permission in the dock')
			await h.until(() => /❯\s*1\.\s*Yes/.test(pane.screen()), 'permission dialog drawn in the pane', 30_000)
			pane.write('\r')
			await h.until(() => existsSync(marker), 'command ran after the terminal answer', 60_000)
			const terminalSession = await h.until(
				() => {
					const view = h.remote.hub.core.session({ profileId: 'live', terminalId: 't-ask' }) as { dialogs: unknown[] }
					return view.dialogs.length === 0 ? view : null
				},
				'hub dialog released',
				30_000,
			)
			assert.deepEqual(terminalSession.dialogs, [])
			const bashItem = await h.until(
				() => h.items().find(item => item.id === bash.id && item.state === 'resolved'),
				'dock item resolved',
				30_000,
			)
			console.log(
				'[terminal] resolution:',
				JSON.stringify(bashItem.resolution),
				'hook cancelled ids:',
				JSON.stringify(h.cancelled),
			)
			await h.until(() => turnWith(h.items(), /./, pong.id), 'turn after the terminal answer')

			// 5. Nested claude from the agent's Bash tool sends nothing (allowed from the dock).
			const before = new Set(h.seen.keys())
			const lastTurn = Math.max(...h.items().map(item => item.id))
			await pane.type(
				`Run exactly this one bash command and nothing else: ${CLAUDE} -p --model ${MODEL} 'Reply with the word NESTED'`,
			)
			const nested = await h.until(() => askFor(h.items(), 'Bash'), 'Bash permission for nested claude')
			const allowed = await h.watcher.act({ itemId: nested.id, rev: nested.rev, action: { type: 'allow' } })
			assert.equal(allowed.ok, true, JSON.stringify(allowed))
			const nestedTurn = await h.until(() => turnWith(h.items(), /./, lastTurn), 'turn after nested claude', 180_000)
			console.log('[nested] turn:', JSON.stringify((nestedTurn.fact as { text: string }).text).slice(0, 300))
			const newKeys = [...h.seen.keys()].filter(key => !before.has(key))
			assert.deepEqual(newKeys, [], 'no hook traffic from another session')
			assert.deepEqual(
				[...h.seen.keys()].map(key => key.split(':')[1]).filter(id => id !== sessionId),
				[],
			)

			// 6. `claude -p` started in a Helm terminal's env directly: the preload skips it.
			const keys = h.seen.size
			const env = h.remote.environment(cleanEnv(), { profileId: 'live', terminalId: 't-print' })
			const printed = await new Promise<string>((resolve, reject) =>
				execFile(
					CLAUDE,
					['-p', '--model', MODEL, '--setting-sources', 'local', 'Reply with the word PRINTED'],
					{ cwd: h.project, env, timeout: 120_000 },
					(error, stdout) => (error ? reject(error) : resolve(stdout)),
				),
			)
			console.log('[print] stdout:', JSON.stringify(printed.trim()))
			await sleep(1_000)
			assert.equal(h.seen.size, keys, 'claude -p sent no hook traffic')
		} finally {
			console.log('[ask] hook traffic:', JSON.stringify(Object.fromEntries(h.seen)))
			await h.done()
		}
	},
)

test(
	'live: ExitPlanMode (--permission-mode plan) shows the full plan and is approved from the dock',
	{ skip: !LIVE, timeout: 400_000 },
	async () => {
		const h = await harness('plan')
		try {
			const pane = await h.open('t-plan', ['--permission-mode', 'plan'])
			const file = `plan-ok-${Date.now()}.txt`
			await pane.type(
				`Plan creating a file named ${file} in the current directory containing the word hi. Keep the plan to two short lines and present it with ExitPlanMode right away, without exploring.`,
			)
			const plan = await h.until(() => askFor(h.items(), 'ExitPlanMode'), 'ExitPlanMode in the dock', 180_000)
			const input = (plan.fact as { input: { plan?: unknown } }).input
			console.log('[plan] plan:', JSON.stringify(input.plan))
			assert.equal(typeof input.plan, 'string')
			assert.match(input.plan as string, new RegExp(file.replace('.', '\\.')))
			const approved = await h.watcher.act({ itemId: plan.id, rev: plan.rev, action: { type: 'allow' } })
			assert.equal(approved.ok, true, JSON.stringify(approved))
			// Approving leaves plan mode for acceptEdits (setMode rides on the allow), so the write
			// should not ask; anything that still does is allowed from the dock too.
			const target = join(h.project, file)
			await h.until(
				() => {
					const next = h.items().find(item => item.kind === 'ask' && item.state === 'open' && item.id !== plan.id)
					if (next) void h.watcher.act({ itemId: next.id, rev: next.rev, action: { type: 'allow' } })
					return existsSync(target)
				},
				'planned file written',
				180_000,
			)
			const turn = await h.until(() => turnWith(h.items(), /./, plan.id), 'turn after the plan ran', 120_000)
			console.log('[plan] turn:', JSON.stringify((turn.fact as { text: string }).text))
		} finally {
			console.log('[plan] hook traffic:', JSON.stringify(Object.fromEntries(h.seen)))
			await h.done()
		}
	},
)

/** The claude a bash pane runs (the harness's own child; only used to kill -9 what this test started). */
async function childClaude(shellPid: number): Promise<number> {
	const out = await new Promise<string>(resolve =>
		execFile('/usr/bin/pgrep', ['-P', String(shellPid)], (_error, stdout) => resolve(stdout)),
	)
	const pid = Number(out.trim().split('\n')[0])
	assert.ok(Number.isSafeInteger(pid) && pid > 0, `no child of ${shellPid}`)
	return pid
}

test(
	'live: claude gone (kill -9, /exit) with a shell left in the pty: the dock reply is refused, nothing is typed',
	{ skip: !LIVE, timeout: 600_000 },
	async () => {
		const h = await harness('life')
		const id = 't-life'
		try {
			const pane = h.openShell(id)
			await sleep(1_000)
			const launch = async () => {
				await pane.type(`${CLAUDE} ${h.claudeArgs(['--permission-mode', 'default']).join(' ')}`)
				await h.ready(pane, id)
			}
			const replyAfterGone = async (word: string) => {
				const last = Math.max(0, ...h.items().map(item => item.id))
				await pane.type(`Reply with only the word ${word}.`)
				const turn = await h.until(() => turnWith(h.items(), new RegExp(word), last), `turn ${word}`)
				// The lifeline is attached live: a reply would be allowed now.
				h.remote.hub.core.checkPrompt({ profileId: 'live', terminalId: id }, Date.now())
				return turn
			}

			// 1. kill -9: no SessionEnd, only the lifeline closes.
			await launch()
			const one = await replyAfterGone('ONE')
			const claudePid = await childClaude(pane.pty.pid)
			console.log(`[life] kill -9 claude ${claudePid}`)
			process.kill(claudePid, 'SIGKILL')
			await h.until(() => !h.listed(id), 'hub ended the session (lifeline closed)', 15_000)
			h.typed.set(id, [])
			const afterKill = await h.watcher.act({
				itemId: one.id,
				rev: one.rev,
				action: { type: 'prompt', text: 'echo SHOULD-NOT-RUN' },
			})
			console.log('[life] reply after kill -9:', JSON.stringify(afterKill))
			assert.equal(afterKill.ok, false)
			assert.deepEqual(h.typed.get(id), [], 'nothing typed into the shell')

			// 2. /exit: SessionEnd (async) and the lifeline close.
			await launch()
			const two = await replyAfterGone('TWO')
			await pane.type('/exit')
			await h.until(() => !h.listed(id), 'hub ended the session after /exit', 30_000)
			h.typed.set(id, [])
			const afterExit = await h.watcher.act({
				itemId: two.id,
				rev: two.rev,
				action: { type: 'prompt', text: 'echo SHOULD-NOT-RUN' },
			})
			console.log('[life] reply after /exit:', JSON.stringify(afterExit))
			assert.equal(afterExit.ok, false)
			assert.deepEqual(h.typed.get(id), [], 'nothing typed into the shell')
			assert.ok(!pane.screen().includes('SHOULD-NOT-RUN'))
		} finally {
			// claude runs in its own job (process group) under the interactive bash: kill it explicitly.
			const shell = h.panes.get(id)
			if (shell && !shell.exited)
				await childClaude(shell.pty.pid)
					.then(pid => process.kill(pid, 'SIGKILL'))
					.catch(() => {})
			await h.done()
		}
	},
)
