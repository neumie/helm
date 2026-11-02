// The hook client's wire protocol, run as Claude runs it: a child process with
// the hook JSON on stdin and the terminal's socket/token in its environment.
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const HOOK = fileURLToPath(new URL('../app/src/claude-remote/hook-client.cjs', import.meta.url))
const TOKEN = 'v1.work.term1.abcdefghijklmnopqrstuvwxyz'

interface Run {
	child: ChildProcess
	done: Promise<{ code: number | null; stdout: string; stderr: string }>
}

function runHook(kind: string, socket: string, stdin: string, env: Record<string, string> = {}): Run {
	const child = spawn(process.execPath, [HOOK, kind], {
		env: {
			PATH: process.env.PATH ?? '',
			HELM_CLAUDE_REMOTE_SOCKET: socket,
			HELM_CLAUDE_REMOTE_TOKEN: TOKEN,
			CLAUDE_PID: '4242',
			...env,
		},
		stdio: ['pipe', 'pipe', 'pipe'],
	})
	let stdout = ''
	let stderr = ''
	child.stdout?.on('data', chunk => {
		stdout += chunk
	})
	child.stderr?.on('data', chunk => {
		stderr += chunk
	})
	child.stdin?.end(stdin)
	return { child, done: new Promise(resolve => child.on('exit', code => resolve({ code, stdout, stderr }))) }
}

/** A hub double: collects request lines; `onLine` decides what to do with each connection. */
function hubDouble(path: string, onLine: (line: Record<string, unknown>, socket: Socket) => void): Promise<Server> {
	const server = createServer(socket => {
		let buffer = ''
		let first = true
		socket.setEncoding('utf8')
		socket.on('error', () => {})
		socket.on('data', chunk => {
			buffer += chunk
			let cut = buffer.indexOf('\n')
			while (cut !== -1) {
				const line = JSON.parse(buffer.slice(0, cut)) as Record<string, unknown>
				buffer = buffer.slice(cut + 1)
				if (first || line.t === 'cancelled') onLine(line, socket)
				first = false
				cut = buffer.indexOf('\n')
			}
		})
	})
	return new Promise(resolve => server.listen(path, () => resolve(server)))
}

const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()))

function scratch(): { dir: string; socket: string; cleanup(): void } {
	const dir = mkdtempSync('/tmp/hcr-hook-')
	return { dir, socket: join(dir, 'hub.sock'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('an event hook forwards {v,t,token,pid,at,input} and prints nothing', async () => {
	const { socket, cleanup } = scratch()
	const lines: Record<string, unknown>[] = []
	const server = await hubDouble(socket, line => lines.push(line))
	try {
		const input = { hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'done' }
		const result = await runHook('event', socket, JSON.stringify(input)).done
		assert.deepEqual({ code: result.code, stdout: result.stdout }, { code: 0, stdout: '' })
		assert.equal(lines.length, 1)
		const line = lines[0] as Record<string, unknown>
		assert.equal(line.v, 1)
		assert.equal(line.t, 'event')
		assert.equal(line.token, TOKEN)
		assert.equal(line.pid, 4242)
		assert.equal(typeof line.at, 'number')
		assert.deepEqual(line.input, input)
	} finally {
		await close(server)
		cleanup()
	}
})

test('no Helm (missing socket), no token or bad stdin: exit 0 silently', async () => {
	const { socket, cleanup } = scratch()
	try {
		for (const run of [
			runHook('permission', socket, '{"hook_event_name":"PermissionRequest"}'),
			runHook('event', socket, '{}'),
			runHook('event', socket, 'not json'),
			runHook('permission', socket, '{}', { HELM_CLAUDE_REMOTE_TOKEN: '' }),
		]) {
			const result = await run.done
			assert.deepEqual({ code: result.code, stdout: result.stdout }, { code: 0, stdout: '' })
		}
	} finally {
		cleanup()
	}
})

test('a permission hook waits and prints the hub decision', async () => {
	const { socket, cleanup } = scratch()
	const output = {
		hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: {} } },
	}
	const server = await hubDouble(socket, (line, conn) => {
		assert.equal(line.t, 'permission')
		setTimeout(() => conn.end(`${JSON.stringify({ output })}\n`), 100)
	})
	try {
		const result = await runHook('permission', socket, '{"hook_event_name":"PermissionRequest"}').done
		assert.equal(result.code, 0)
		assert.deepEqual(JSON.parse(result.stdout), output)
	} finally {
		await close(server)
		cleanup()
	}
})

test('a permission hook whose connection drops asks again (Helm restarted)', async () => {
	const { socket, cleanup } = scratch()
	let connections = 0
	const server = await hubDouble(socket, (_line, conn) => {
		connections += 1
		if (connections === 1) conn.destroy()
		else conn.end('{"output":{}}\n')
	})
	try {
		const result = await runHook('permission', socket, '{"hook_event_name":"PermissionRequest"}').done
		assert.equal(connections, 2)
		assert.deepEqual({ code: result.code, stdout: result.stdout.trim() }, { code: 0, stdout: '{}' })
	} finally {
		await close(server)
		cleanup()
	}
})

test('SIGTERM while waiting (terminal No/Esc) tells the hub "cancelled" and exits 0', async () => {
	const { socket, cleanup } = scratch()
	const seen: string[] = []
	let waiting: () => void = () => {}
	const connected = new Promise<void>(resolve => {
		waiting = resolve
	})
	const server = await hubDouble(socket, line => {
		seen.push(String(line.t))
		if (line.t === 'permission') waiting()
	})
	try {
		const run = runHook('permission', socket, '{"hook_event_name":"PermissionRequest"}')
		await connected
		run.child.kill('SIGTERM')
		const result = await run.done
		assert.deepEqual({ code: result.code, stdout: result.stdout }, { code: 0, stdout: '' })
		await new Promise(resolve => setTimeout(resolve, 50))
		assert.deepEqual(seen, ['permission', 'cancelled'])
	} finally {
		await close(server)
		cleanup()
	}
})

test('only the fields the hub reads are sent: no tool_response; event strings clipped, permission input whole', async () => {
	const { socket, cleanup } = scratch()
	const lines: Record<string, unknown>[] = []
	const server = await hubDouble(socket, (line, conn) => {
		lines.push(line)
		if (line.t === 'permission') conn.end('{"output":{}}\n')
	})
	try {
		const big = 'x'.repeat(100_000)
		const post = {
			hook_event_name: 'PostToolUse',
			session_id: 's1',
			prompt_id: 'p1',
			tool_name: 'Write',
			tool_input: { file_path: '/a', content: big },
			tool_response: { content: big },
			permission_mode: 'default',
		}
		await runHook('event', socket, JSON.stringify(post)).done
		await runHook('event', socket, JSON.stringify({ ...post, hook_event_name: 'PreToolUse' })).done
		const permission = { ...post, hook_event_name: 'PermissionRequest', permission_suggestions: [{ type: 'addRules' }] }
		await runHook('permission', socket, JSON.stringify(permission)).done
		const [postLine, preLine, permissionLine] = lines.map(line => line.input as Record<string, unknown>)
		assert.deepEqual(postLine, {
			hook_event_name: 'PostToolUse',
			session_id: 's1',
			prompt_id: 'p1',
			tool_name: 'Write',
			tool_input: { file_path: '/a', content: 'x'.repeat(4096) },
		})
		assert.equal(preLine?.tool_input, undefined, 'PreToolUse needs no input')
		assert.equal((permissionLine?.tool_input as { content: string }).content, big, 'an allow repeats it verbatim')
		assert.deepEqual(permissionLine?.permission_suggestions, [{ type: 'addRules' }])
		assert.equal(permissionLine?.tool_response, undefined)
	} finally {
		await close(server)
		cleanup()
	}
})

test('the reconnect window counts from the drop, not from when the hook started', async () => {
	const { socket, cleanup } = scratch()
	let connections = 0
	const server = await hubDouble(socket, (_line, conn) => {
		connections += 1
		// First connection: a long wait, then Helm goes away; the second (after the restart) answers.
		if (connections === 1) setTimeout(() => conn.destroy(), 300)
		else conn.end('{"output":{"ok":1}}\n')
	})
	try {
		const result = await runHook('permission', socket, '{"hook_event_name":"PermissionRequest"}', {
			HELM_CLAUDE_REMOTE_TEST_WINDOW_MS: '200',
		}).done
		assert.equal(connections, 2)
		assert.deepEqual(JSON.parse(result.stdout), { ok: 1 })
	} finally {
		await close(server)
		cleanup()
	}
})
