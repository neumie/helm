// Helm Claude hook client: the command Claude Code runs for every hook the Helm
// preload registers (`<node> hook-client.cjs event|permission`). It forwards the
// hook's stdin JSON to Helm's hub over the terminal's private Unix socket.
//
// Wire (one JSON line each way, UTF-8, newline-terminated):
//   client → hub  {"v":1,"t":"event"|"permission","token","pid","at","input"}
//   hub → client  permission only: {"output":{…hook stdout JSON…}}
//   client → hub  {"t":"cancelled"} when Claude SIGTERMs a waiting permission
//                 hook (the terminal answered No / Esc)
//
// Rules: no imports beyond `node:net`; never print anything for an event hook
// (an async hook's stdout reaches Claude on its next turn); exit 0 silently when
// Helm is not there (missing socket, refused, bad token); a waiting permission
// hook whose connection drops (Helm restarted) reconnects and asks again for
// RECONNECT_WINDOW_MS after the drop, then leaves the dialog to the terminal.
// Only the fields the hub reads are sent (never tool_response); an event's
// tool_input / prompt / message strings are clipped (the hub compares clipped).
'use strict'

const net = require('node:net')

const MAX_STDIN_BYTES = 16 * 1024 * 1024
const MAX_REPLY_BYTES = 32 * 1024 * 1024
const EVENT_SEND_TIMEOUT_MS = 3000
const RECONNECT_DELAY_MS = 500
// Tests shorten it (HELM_CLAUDE_REMOTE_TEST_WINDOW_MS); it only ever bounds a retry loop.
const RECONNECT_WINDOW_MS = Number(process.env.HELM_CLAUDE_REMOTE_TEST_WINDOW_MS) || 120_000
/** Same bound as hub-core.ts EVENT_STRING_MAX: event tool_input strings are cut to it. */
const EVENT_STRING_MAX = 4096
/** Same bound as hub-core.ts ENTRY_TEXT_MAX: a prompt or last message is cut there anyway. */
const EVENT_TEXT_MAX = 64 * 1024
const BACKGROUND_TASKS_MAX = 32

/** Every field the hub reads; the rest (tool_response, …) never leaves this process. */
const EVENT_FIELDS = [
	'hook_event_name',
	'session_id',
	'prompt_id',
	'tool_name',
	'tool_input',
	'agent_id',
	'agent_type',
	'source',
	'cwd',
	'transcript_path',
	'prompt',
	'last_assistant_message',
	'background_tasks',
	'error',
]
const PERMISSION_FIELDS = [...EVENT_FIELDS, 'permission_suggestions']

/** `value` with every string over EVENT_STRING_MAX code units cut (hub-core.ts clipStrings). */
function clip(value, depth = 0) {
	if (typeof value === 'string') return value.length > EVENT_STRING_MAX ? value.slice(0, EVENT_STRING_MAX) : value
	if (depth > 64) return value
	if (Array.isArray(value)) return value.map(entry => clip(entry, depth + 1))
	if (value && typeof value === 'object') {
		const out = {}
		for (const [key, entry] of Object.entries(value)) out[key] = clip(entry, depth + 1)
		return out
	}
	return value
}

/**
 * What the hub gets of a hook's stdin. A permission request keeps tool_input whole (an
 * allow repeats it verbatim); an event only needs it to match a released dialog.
 */
function slim(kind, input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return input
	const out = {}
	for (const key of kind === 'permission' ? PERMISSION_FIELDS : EVENT_FIELDS)
		if (input[key] !== undefined) out[key] = input[key]
	if (kind === 'permission') return out
	const name = out.hook_event_name
	// Only a PostToolUse(Failure) needs tool_input (to match the dialog it releases); undefined is not sent.
	out.tool_input = name === 'PostToolUse' || name === 'PostToolUseFailure' ? clip(out.tool_input) : undefined
	for (const key of ['prompt', 'last_assistant_message', 'error'])
		if (typeof out[key] === 'string' && out[key].length > EVENT_TEXT_MAX) out[key] = out[key].slice(0, EVENT_TEXT_MAX)
	if (Array.isArray(out.background_tasks))
		out.background_tasks = out.background_tasks.slice(0, BACKGROUND_TASKS_MAX).map(() => ({}))
	return out
}

function readStdin() {
	return new Promise(resolve => {
		const chunks = []
		let size = 0
		let over = false
		process.stdin.on('data', chunk => {
			size += chunk.length
			if (size > MAX_STDIN_BYTES) over = true
			else chunks.push(chunk)
		})
		process.stdin.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')))
		process.stdin.on('error', () => resolve(null))
	})
}

function claudePid(env) {
	const pid = Number(env.CLAUDE_PID)
	return Number.isSafeInteger(pid) && pid > 0 ? pid : process.ppid
}

/** Sends one event line; resolves when written (or on any failure). */
function sendEvent(socketPath, line) {
	return new Promise(resolve => {
		let done = false
		const finish = () => {
			if (done) return
			done = true
			clearTimeout(timer)
			socket.destroy()
			resolve()
		}
		const socket = net.createConnection(socketPath)
		const timer = setTimeout(finish, EVENT_SEND_TIMEOUT_MS)
		socket.on('error', finish)
		socket.on('close', finish)
		socket.on('connect', () => socket.end(line, () => setTimeout(finish, 50)))
	})
}

/**
 * Waits for the hub's decision. Resolves `{output}` on an answer, `{dropped: true}`
 * when the connection closed without one, `{unreachable: true}` when it never connected.
 */
function askOnce(socketPath, line, onSocket) {
	return new Promise(resolve => {
		let connected = false
		const chunks = []
		let size = 0
		let settled = false
		const settle = value => {
			if (settled) return
			settled = true
			onSocket(null)
			resolve(value)
		}
		const socket = net.createConnection(socketPath)
		onSocket(socket)
		socket.setEncoding('utf8')
		socket.on('connect', () => {
			connected = true
			socket.write(line)
		})
		socket.on('data', chunk => {
			if (settled) return
			const cut = chunk.indexOf('\n')
			size += cut === -1 ? chunk.length : cut
			if (size > MAX_REPLY_BYTES) {
				socket.destroy()
				return settle({ output: {} })
			}
			if (cut === -1) {
				chunks.push(chunk)
				return
			}
			chunks.push(chunk.slice(0, cut))
			let reply = null
			try {
				reply = JSON.parse(chunks.join(''))
			} catch {
				reply = null
			}
			socket.end()
			const output = reply && typeof reply === 'object' && reply.output && typeof reply.output === 'object'
			settle({ output: output ? reply.output : {} })
		})
		socket.on('error', () => {})
		socket.on('close', () => settle(connected ? { dropped: true } : { unreachable: true }))
	})
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main(kind) {
	const env = process.env
	const socketPath = env.HELM_CLAUDE_REMOTE_SOCKET
	const token = env.HELM_CLAUDE_REMOTE_TOKEN
	if (!socketPath || !token || (kind !== 'event' && kind !== 'permission')) return
	const raw = await readStdin()
	if (raw === null) return
	let input
	try {
		input = JSON.parse(raw)
	} catch {
		return
	}
	const line = `${JSON.stringify({ v: 1, t: kind, token, pid: claudePid(env), at: Date.now(), input: slim(kind, input) })}\n`
	if (kind === 'event') return sendEvent(socketPath, line)

	let current = null
	let cancelled = false
	const onTerm = () => {
		// Claude ends a waiting permission hook when the terminal answered No or Esc.
		cancelled = true
		const socket = current
		if (socket && !socket.destroyed) {
			socket.write('{"t":"cancelled"}\n', () => process.exit(0))
			setTimeout(() => process.exit(0), 300).unref()
		} else process.exit(0)
	}
	process.on('SIGTERM', onTerm)
	process.on('SIGINT', onTerm)
	// When the last connection dropped (null: never connected). The window counts from the drop,
	// so a dialog that waited for hours still survives a Helm restart.
	let droppedAt = null
	for (;;) {
		const result = await askOnce(socketPath, line, socket => {
			current = socket
		})
		if (cancelled) return
		if (result.output) {
			const text = JSON.stringify(result.output)
			process.stdout.write(`${text}\n`)
			return
		}
		if (result.dropped) droppedAt = Date.now()
		else if (droppedAt === null) return // Helm was never there
		if (Date.now() - droppedAt > RECONNECT_WINDOW_MS) return
		await sleep(RECONNECT_DELAY_MS)
	}
}

if (require.main === module) {
	main(process.argv[2]).then(
		() => process.exit(0),
		() => process.exit(0),
	)
}

module.exports = { main, slim, clip, EVENT_STRING_MAX }
