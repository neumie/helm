import { z } from 'zod'
import { runReviewCli } from './review.js'

export const EDIT_HELP = `Usage: helm edit FILE

Open a Markdown, JSX or TSX file in Helm and listen for feedback in THIS
already-running agent conversation. No agent is launched or replaced.

Example:
  helm edit docs/plans/example/spec.md

Run as a foreground agent tool, with a tool timeout above one hour.
The command returns one feedback prompt with exact continuation arguments.
Handle it here, then use its reply command with your answer: that command
reports the answer AND listens for the next message. No separate re-wait.
Closing this document window ends its listening command normally, not the agent.

Agent continuations (use only the handles returned to THIS conversation):
  helm edit reply HANDLE "Answer / what changed"
  helm edit wait HANDLE
  helm edit disconnect CONNECTION

Optional: --timeout SECONDS (1..3600, default 3600).
For opening only, --agent, --workspace and --label remain optional overrides.
An unspecified provider is displayed honestly as Agent, never guessed.
Timeout returns no feedback; resume only the exact returned connection.
Errors/unknown delivery are never retried or replayed automatically.
The original conversation keeps its tools, permissions and questions.
The legacy helm review interface remains available for advanced operations.
`

const resultSchema = z
	.object({
		connection: z.string().min(1).max(2048),
		feedback: z
			.object({ request: z.object({ id: z.string().uuid() }).passthrough() })
			.passthrough()
			.nullable(),
		timedOut: z.boolean(),
		documentId: z.string().uuid().optional(),
		closed: z.boolean().optional(),
	})
	.passthrough()

async function feedbackOutput(value: unknown): Promise<void> {
	const result = resultSchema.parse(value)
	const suffix = result.documentId ? `#${result.documentId}` : ''
	const commands = result.closed
		? {}
		: {
				...(result.feedback
					? { reply: ['helm', 'edit', 'reply', `${result.connection}#${result.feedback.request.id}${suffix}`] }
					: {}),
				wait: ['helm', 'edit', 'wait', `${result.connection}${suffix}`],
				disconnect: ['helm', 'edit', 'disconnect', result.connection],
			}
	const instructions = result.closed
		? 'The document window closed. Stop the listening loop; do not reopen or re-wait automatically. Your original agent and already-delivered feedback remain unchanged.'
		: result.feedback
			? 'Handle feedback.prompt in this original conversation. Append your answer as ONE argument to commands.reply; it reports the reply and waits for the next message. Keep using returned handles, never another caller. Use a foreground tool timeout above one hour. Do not replay uncertain feedback.'
			: 'No feedback arrived. To continue, deliberately run commands.wait in this original conversation with a foreground tool timeout above one hour. Do not reopen or create a replacement caller to resume.'
	await new Promise<void>((resolve, reject) =>
		process.stdout.write(`${JSON.stringify({ ...result, commands, instructions })}\n`, error =>
			error ? reject(error) : resolve(),
		),
	)
}

function waitOptions(args: string[]): string[] {
	return args.includes('--timeout') ? args : [...args, '--timeout', '3600']
}

/** Small editing workflow over the existing authenticated mailbox; no new state or authority. */
export async function runEditCli(args: string[]): Promise<void> {
	const action = args[0]
	if (
		!action ||
		['help', '--help', '-h'].includes(action) ||
		(action !== 'reply' && (args.includes('--help') || args.includes('-h')))
	) {
		process.stdout.write(EDIT_HELP)
		return
	}
	if (action === 'reply') {
		const handle = args[1] ?? ''
		const split = handle.lastIndexOf('#')
		if (split < 1 || handle.length > 2122) throw new Error('Use the reply handle returned with this feedback.')
		const previous = handle.lastIndexOf('#', split - 1)
		const scoped =
			previous > 0 &&
			z
				.string()
				.uuid()
				.safeParse(handle.slice(previous + 1, split)).success
		const documentId = scoped
			? z
					.string()
					.uuid()
					.parse(handle.slice(split + 1))
			: undefined
		const connection = handle.slice(0, scoped ? previous : split)
		const requestId = z
			.string()
			.uuid()
			.parse(scoped ? handle.slice(previous + 1, split) : handle.slice(split + 1))
		const text = z.string().max(64000).parse(args[2])
		const options = waitOptions(args.slice(3))
		// Validate wait options BEFORE reporting: malformed continuation arguments must not cause a partial effect.
		validateWaitOptions(options)
		// Report and listen share ONE captured authority; never reload a possibly replaced handle between effects.
		// A lost report response throws before the next read; never auto-replay it.
		await runReviewCli(['reply', requestId, '--connection', connection, '--text', text, ...options], feedbackOutput, {
			listenAfterReply: true,
			documentId,
		})
		return
	}
	if (action === 'wait' || action === 'disconnect') {
		const handle = args[1]
		if (!handle || handle.startsWith('-')) throw new Error(`Use the ${action} command returned to this caller.`)
		const split = action === 'wait' ? handle.lastIndexOf('#') : -1
		const scoped =
			split > 0 &&
			z
				.string()
				.uuid()
				.safeParse(handle.slice(split + 1)).success
		const documentId = scoped
			? z
					.string()
					.uuid()
					.parse(handle.slice(split + 1))
			: undefined
		const connection = scoped ? handle.slice(0, split) : handle
		const options = action === 'wait' ? waitOptions(args.slice(2)) : args.slice(2)
		if (action === 'wait') validateWaitOptions(options)
		if (action === 'disconnect' && options.length) throw new Error('disconnect takes only its returned connection.')
		await runReviewCli(
			[action, '--connection', connection, ...options],
			action === 'wait' ? feedbackOutput : undefined,
			{ documentId },
		)
		return
	}
	const options = waitOptions(args.slice(1))
	const provider = options.includes('--agent') ? [] : ['--agent', 'cli']
	const label = options.includes('--label') ? [] : ['--label', 'Document conversation']
	await runReviewCli(['open', action, ...options, ...provider, ...label, '--wait'], feedbackOutput, {
		windowBound: true,
	})
}

function validateWaitOptions(args: string[]): void {
	if (args.length !== 2 || args[0] !== '--timeout') throw new Error('Only --timeout SECONDS is supported for waiting.')
	z.number().int().min(1).max(3600).parse(Number(args[1]))
}
