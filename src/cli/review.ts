import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { callReview, connectReview, loadReviewConnection, reviewHostStatus } from '../document-review/client.js'
import { feedbackSchema, openedSchema, receiptSchema, sessionSchema } from '../document-review/protocol.js'
import type { ReviewCommand } from '../document-review/protocol.js'
import type { ReviewFeedback, ReviewProvider } from '../document-review/types.js'

export const REVIEW_HELP = `Usage: helm review <command> [options]

Use Helm's document UI from an ALREADY RUNNING Claude Code, Codex, or Pi session.
Helm never launches or resumes an agent. Run these commands as that agent's tools.

Commands:
  connect    Enroll a caller; prints its private connection-file handle
  open FILE  Open Markdown or JSX in the desktop; optionally connect and wait
  wait       Listen until one feedback request arrives (alias: next)
  reply ID   Report an answer/completion for the received feedback UUID
  status     Inspect a connection, or desktop availability without --connection
  list       List this connection's repository-scoped review connections
  receipt ID Inspect delivery without replaying feedback
  disconnect Retire this connection; never stops the agent
  help       Show this help

Options:
  --connection FILE  Private handle returned by connect/open (not a token)
  --agent NAME       claude | codex | pi; required when making a connection
  --workspace DIR    Repository or subdirectory (default: current directory)
  --label TEXT       Display-only caller label, at most 80 characters
  --wait             open also listens for feedback before returning
  --timeout SECONDS  wait deadline, 1..3600 (default: 600)
  --text TEXT        Reply text; alternatively --text-file FILE or --stdin
  --state STATE      complete (default), working, or error
  --sequence N       Monotonic reply sequence (default: 0)
  --json             Machine-readable output (currently all output is JSON)

Example from inside an agent session:
  helm review open spec.md --agent pi --wait --json
  # Read feedback.prompt, respond/edit in THIS conversation, then:
  helm review reply REQUEST_ID --connection CONNECTION_FILE --text "Done"
  helm review wait --connection CONNECTION_FILE --json

A waiting tool returns the selection and instruction to its original caller.
Continue the wait/reply loop while reviewing. An idle session without a waiting
tool does NOT receive background injection. Pi's optional in-process connector
provides live delivery instead. No global agent configuration is changed.
An uncertain operation is never retried automatically. Check receipt/status.
`
const names = new Set([
	'--connection',
	'--agent',
	'--workspace',
	'--label',
	'--timeout',
	'--text',
	'--text-file',
	'--state',
	'--sequence',
])
const flags = new Set(['--wait', '--stdin', '--json', '--help', '-h'])
function parse(args: string[]) {
	const values = new Map<string, string>()
	const options = new Set<string>()
	const positional: string[] = []
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string
		if (flags.has(arg)) {
			if (options.has(arg)) throw new Error(`Repeated option: ${arg}`)
			options.add(arg)
		} else if (names.has(arg)) {
			const value = args[++index]
			if (!value || value.startsWith('--') || values.has(arg)) throw new Error(`Expected one value for ${arg}`)
			values.set(arg, value)
		} else if (arg.startsWith('-')) throw new Error(`Unknown review option: ${arg}`)
		else positional.push(arg)
	}
	return { values, options, positional }
}
async function textFile(file: string): Promise<string> {
	const handle = await open(resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const before = await handle.stat()
		if (!before.isFile() || before.nlink !== 1 || before.size > 256000)
			throw new Error('Reply file must be a bounded, regular, single-link file.')
		const bytes = Buffer.alloc(256001)
		let count = 0
		while (count < bytes.length) {
			const result = await handle.read(bytes, count, bytes.length - count, count)
			if (!result.bytesRead) break
			count += result.bytesRead
		}
		const after = await handle.stat()
		if (
			count > 256000 ||
			count !== before.size ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs
		)
			throw new Error('Reply file changed during reading.')
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))
	} finally {
		await handle.close()
	}
}
async function stdinText(): Promise<string> {
	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of process.stdin) {
		const bytes = Buffer.from(chunk)
		size += bytes.length
		if (size > 256000) throw new Error('Reply stdin exceeds its byte limit.')
		chunks.push(bytes)
	}
	return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}
async function output(value: unknown): Promise<void> {
	await new Promise<void>((resolve, reject) =>
		process.stdout.write(`${JSON.stringify(value)}\n`, error => (error ? reject(error) : resolve())),
	)
}
export async function runReviewCli(args: string[]): Promise<void> {
	const { values, options, positional } = parse(args)
	const action = positional[0] ?? 'help'
	if (options.has('--help') || options.has('-h') || action === 'help') {
		process.stdout.write(REVIEW_HELP)
		return
	}
	if (!['connect', 'open', 'wait', 'next', 'reply', 'status', 'list', 'receipt', 'disconnect'].includes(action))
		throw new Error('Unknown review command. Run helm review help.')
	const argument = positional[1]
	if (positional.length > (['open', 'reply', 'receipt'].includes(action) ? 2 : 1))
		throw new Error('Unexpected positional review argument.')
	if (['open', 'reply', 'receipt'].includes(action) && !argument)
		throw new Error(`${action} requires its file or feedback ID.`)
	if (['reply', 'receipt'].includes(action)) z.string().uuid().parse(argument)
	if (options.has('--wait') && action !== 'open')
		throw new Error('--wait belongs only to open; use the wait command directly.')
	const seconds = z
		.number()
		.int()
		.min(1)
		.max(3600)
		.parse(Number(values.get('--timeout') ?? '600'))
	if (action === 'connect' && values.has('--connection'))
		throw new Error('connect creates a fresh caller; use the existing handle with open/wait instead.')
	let connectionFile = values.get('--connection')
	if (action === 'status' && !connectionFile) {
		await output(await reviewHostStatus())
		return
	}
	if (action === 'connect' || (action === 'open' && !connectionFile)) {
		const provider = z.enum(['claude', 'codex', 'pi']).parse(values.get('--agent')) as ReviewProvider
		const connected = await connectReview({
			action: 'connect',
			provider,
			workspace: await realpath(resolve(values.get('--workspace') ?? process.cwd())),
			label: values.get('--label') ?? `${provider} · tool connection`,
			transport: 'tool-return',
		})
		connectionFile = connected.connection
		if (action === 'connect') {
			await output(connected)
			return
		}
		// A lost/open failure never loses the private handle needed for explicit cleanup.
		process.stderr.write(`Review connection: ${connectionFile}\n`)
	}
	if (!connectionFile) throw new Error('Use --connection FILE from connect/open. Helm will not guess an agent session.')
	const authority = await loadReviewConnection(connectionFile)
	const controller = new AbortController()
	const cancelled = () => controller.abort()
	process.once('SIGINT', cancelled)
	process.once('SIGTERM', cancelled)
	try {
		let opened: z.infer<typeof openedSchema> | undefined
		if (action === 'open') {
			if (!argument) throw new Error('open requires a Markdown or JSX file.')
			opened = await callReview(authority, { action: 'open', file: resolve(argument) }, openedSchema, controller.signal)
			if (!options.has('--wait')) {
				await output({ connection: connectionFile, ...opened })
				return
			}
		}
		if (action === 'wait' || action === 'next' || (action === 'open' && options.has('--wait'))) {
			const deadline = Date.now() + seconds * 1000
			let feedback: ReviewFeedback | null = null
			while (Date.now() < deadline && !controller.signal.aborted && !feedback) {
				feedback = await callReview(
					authority,
					{ action: 'next', timeoutMs: Math.max(1, Math.min(60000, deadline - Date.now())) },
					feedbackSchema.nullable(),
					controller.signal,
				)
			}
			await output({ connection: connectionFile, ...opened, feedback, timedOut: feedback === null })
			if (feedback)
				await callReview(
					authority,
					{ action: 'ack', requestId: feedback.request.id },
					z.literal(true),
					controller.signal,
				)
			return
		}
		if (action === 'reply') {
			const requestId = z.string().uuid().parse(argument)
			if ([values.has('--text'), values.has('--text-file'), options.has('--stdin')].filter(Boolean).length !== 1)
				throw new Error('Choose exactly one reply source: --text, --text-file, or --stdin.')
			const text = z
				.string()
				.max(64000)
				.parse(
					values.get('--text') ??
						(values.has('--text-file') ? await textFile(values.get('--text-file') as string) : await stdinText()),
				)
			const command: ReviewCommand = {
				action: 'reply',
				requestId,
				sequence: z
					.number()
					.int()
					.nonnegative()
					.safe()
					.parse(Number(values.get('--sequence') ?? '0')),
				state: z.enum(['working', 'complete', 'error']).parse(values.get('--state') ?? 'complete'),
				text,
			}
			await output(await callReview(authority, command, z.literal(true), controller.signal))
			return
		}
		if (action === 'receipt') {
			await output(
				await callReview(
					authority,
					{ action: 'receipt', requestId: z.string().uuid().parse(argument) },
					receiptSchema.nullable(),
					controller.signal,
				),
			)
			return
		}
		if (action === 'status') {
			await output(await callReview(authority, { action: 'status' }, sessionSchema, controller.signal))
			return
		}
		if (action === 'list') {
			await output(await callReview(authority, { action: 'list' }, z.array(sessionSchema).max(32), controller.signal))
			return
		}
		if (action === 'disconnect')
			await output(await callReview(authority, { action: 'disconnect' }, z.literal(true), controller.signal))
	} finally {
		process.removeListener('SIGINT', cancelled)
		process.removeListener('SIGTERM', cancelled)
	}
}
