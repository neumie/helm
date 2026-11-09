// E — Send receipt (helm open spec D14, open until Jakub picks). What the review window says right after
// Send. Every frame runs the real DocumentReview send path against a staged host that replays the measured
// native timings; a story-only driver types and presses ⌘↵ for you. "Today" is production, no receipt.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo, useRef, useState } from 'react'
import '../document-review/document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { Btn } from '../button'
import { DocumentReview } from '../document-review/DocumentReview'
import type { SendReceiptSlots } from '../document-review/send-receipt-view'
import { RECEIPT_VARIANTS, type ReceiptVariant, receiptSlots } from './receipt'
import { type ActivitySource, type ActivityStep, activitySlots } from './receipt-activity'
import { REALISTIC, type StagedReviewOptions, createStagedReviewFixture } from './receipt-fixture'
import './receipt-story.css'

type Frame =
	| 'sending'
	| 'received'
	| 'working'
	| 'replied'
	| 'not-sent'
	| 'unconfirmed'
	| 'passage'
	| 'try-claude'
	| 'try-pi'

const FRAMES: Record<
	Frame,
	{ label: string; options: Partial<StagedReviewOptions>; passage?: boolean; auto: boolean }
> = {
	sending: { label: 'Sending', options: { hold: 'sending' }, auto: true },
	received: { label: 'Received · Claude Code', options: { hold: 'received' }, auto: true },
	working: { label: 'Working · Pi', options: { agent: 'pi', hold: 'working' }, auto: true },
	replied: { label: 'Replied', options: { replyMs: 1200 }, auto: true },
	'not-sent': { label: 'Not sent', options: { outcome: 'not-sent' }, auto: true },
	unconfirmed: { label: 'Not confirmed', options: { outcome: 'unconfirmed', unknownMs: 1500 }, auto: true },
	passage: { label: 'Passage', options: { hold: 'received' }, passage: true, auto: true },
	'try-claude': { label: 'Try it · Claude Code', options: {}, auto: false },
	'try-pi': { label: 'Try it · Pi', options: { agent: 'pi', workMs: 900, replyMs: 6000 }, auto: false },
}
const MESSAGE = 'Can you tighten the second section? It repeats the owner rule twice.'
const PASSAGE_MESSAGE = 'Is this still true once a second agent opens the file?'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function find<T extends Element>(root: HTMLElement, selector: string, alive: () => boolean): Promise<T | null> {
	for (let tries = 0; tries < 100 && alive(); tries++) {
		const element = root.querySelector<T>(selector)
		if (element && !(element as unknown as HTMLTextAreaElement).disabled) return element
		await wait(50)
	}
	return null
}
/** Story-only driver: selects a passage if asked, types into the real textarea and presses ⌘↵. */
async function autoSend(root: HTMLElement, passage: boolean, alive: () => boolean): Promise<void> {
	let selector = 'textarea[aria-label="Whole-document message"]'
	if (!(await find(root, selector, alive))) return
	// Narrow windows show one destination at a time; a whole-document message is written in Conversation.
	if (!passage)
		for (const button of root.querySelectorAll('button'))
			if (button.textContent?.trim() === 'Conversation' && button.getAttribute('aria-current') !== 'page')
				button.click()
	if (passage) {
		const reading = root.querySelector<HTMLElement>('.review-reading')
		const paragraph = reading?.querySelector('p')
		const text = paragraph?.firstChild
		if (!reading || !text) return
		const range = document.createRange()
		range.selectNodeContents(text)
		const selection = window.getSelection()
		selection?.removeAllRanges()
		selection?.addRange(range)
		reading.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }))
		await wait(120)
		reading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }))
		selector = 'textarea[aria-label="Passage instruction"]'
	}
	const field = await find<HTMLTextAreaElement>(root, selector, alive)
	if (!field || !alive()) return
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
		field,
		passage ? PASSAGE_MESSAGE : MESSAGE,
	)
	field.dispatchEvent(new Event('input', { bubbles: true }))
	await wait(300)
	if (alive()) field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
}

function Stage({
	options,
	passage,
	auto,
	slots,
}: {
	options: Partial<StagedReviewOptions>
	passage?: boolean
	auto: boolean
	slots: SendReceiptSlots | undefined
}) {
	const fixture = useMemo(() => createStagedReviewFixture({ ...REALISTIC, ...options }), [options])
	const root = useRef<HTMLDivElement>(null)
	useEffect(() => {
		let alive = true
		if (auto && root.current) void autoSend(root.current, !!passage, () => alive)
		return () => {
			alive = false
			fixture.dispose()
		}
	}, [fixture, auto, passage])
	return (
		<div className="rcpt-story-window" ref={root}>
			<DocumentReview api={fixture.api} sendReceipt={slots} />
		</div>
	)
}

function Frame({ variant, frame }: { variant: ReceiptVariant | 'today'; frame: Frame }) {
	const spec = FRAMES[frame]
	const slots = useMemo(() => (variant === 'today' ? undefined : receiptSlots(variant)), [variant])
	return <Stage options={spec.options} passage={spec.passage} auto={spec.auto} slots={slots} />
}

function ReceiptStory({ variant, frame: initial }: { variant: ReceiptVariant | 'today'; frame: Frame }) {
	const [frame, setFrame] = useState<Frame>(initial)
	const [run, setRun] = useState(0)
	useEffect(() => setFrame(initial), [initial])
	const about =
		variant === 'today'
			? { label: 'Today', note: 'Production now: nothing confirms the send until the reply.' }
			: RECEIPT_VARIANTS[variant]
	return (
		<div className="rcpt-story">
			<nav className="rcpt-story-bar" aria-label="Story frames">
				<span className="rcpt-story-title">
					{about.label}
					<span>{about.note}</span>
				</span>
				<span className="rcpt-story-frames">
					{(Object.keys(FRAMES) as Frame[]).map(key => (
						<Btn
							key={key}
							sm
							tone={key === frame ? 'quiet' : 'ghost'}
							ariaCurrent={key === frame ? 'page' : undefined}
							onClick={() => {
								setFrame(key)
								setRun(value => value + 1)
							}}
						>
							{FRAMES[key].label}
						</Btn>
					))}
				</span>
			</nav>
			<Frame key={`${frame}:${run}`} variant={variant} frame={frame} />
		</div>
	)
}

const meta = {
	title: 'Views/Helm open/E Send receipt',
	component: ReceiptStory,
	parameters: { layout: 'fullscreen' },
	argTypes: {
		frame: { control: 'select', options: Object.keys(FRAMES) },
		variant: { control: false },
	},
	args: { variant: 'today', frame: 'received' },
} satisfies Meta<typeof ReceiptStory>
export default meta
type Story = StoryObj<typeof meta>

export const Today: Story = { args: { variant: 'today' } }
export const AComposerLine: Story = { name: 'A Composer line', args: { variant: 'composer' } }
export const BUnderMessage: Story = { name: 'B Under your message', args: { variant: 'message' } }
export const CHeaderSteps: Story = { name: 'C Header steps', args: { variant: 'header' } }
export const DSendButton: Story = { name: 'D Send button', args: { variant: 'button' } }

// ---------------------------------------------------------------------------
// E5 — activity line in Claude Code's style. Each frame names where its numbers would really come from.

const ORIGIN = {
	claude:
		"Claude Code's transcript, bound to this session by the request id: output tokens since your message, the last tool's name. Updates when each model response ends.",
	codex:
		"Codex's session file (token_count events): output tokens since your message. Updates about every 12 s (p50), 38 s (p90).",
	pi: "Pi's own events through the in-process caller; tokens need one new report field.",
	none: 'Nothing bound to the agent: Helm knows only that it has your message.',
}

const at = (seconds: number, tokens: number | null, verb: string | null): ActivityStep => ({
	at: seconds * 1000,
	tokens,
	verb,
})
const CLAUDE_STEPS = [
	at(2, null, null),
	at(9, 812, 'Reading'),
	at(24, 2400, 'Searching'),
	at(51, 5100, 'Editing'),
	at(96, 9800, null),
	at(139, 13_900, 'Running a command'),
	at(168, 16_300, 'Editing'),
]
const CODEX_STEPS = [
	at(3, null, null),
	at(16, 1900, 'Running a command'),
	at(53, 4100, 'Editing'),
	at(91, 7300, 'Running a command'),
	at(150, 11_800, 'Editing'),
]
const PI_STEPS = [
	at(1, null, null),
	at(7, 640, 'Reading'),
	at(33, 3100, 'Editing'),
	at(88, 6900, null),
	at(161, 9400, 'Editing'),
]
/** Live frames compress three minutes into ~10 s so the steps are visible. */
const quick = (steps: ActivityStep[]): ActivityStep[] => steps.map(step => ({ ...step, at: step.at / 18 }))
const STILL = 177_000

type ActivityFrame =
	| 'received'
	| 'claude'
	| 'codex'
	| 'pi'
	| 'unknown'
	| 'replied'
	| 'not-sent'
	| 'unconfirmed'
	| 'try-claude'
	| 'try-unknown'

const ACTIVITY: Record<
	ActivityFrame,
	{ label: string; note: string; options: Partial<StagedReviewOptions>; source: ActivitySource; auto: boolean }
> = {
	received: {
		label: 'Received',
		note: 'The waiting tool has your message; nothing read from the agent yet.',
		options: { hold: 'received' },
		source: { steps: CLAUDE_STEPS, origin: ORIGIN.claude, clockOffsetMs: 2000 },
		auto: true,
	},
	claude: {
		label: 'Working · Claude Code',
		note: ORIGIN.claude,
		options: { hold: 'working', reportsWorking: true },
		source: { steps: CLAUDE_STEPS, origin: ORIGIN.claude, clockOffsetMs: STILL },
		auto: true,
	},
	codex: {
		label: 'Working · Codex',
		note: ORIGIN.codex,
		options: { agent: 'codex', hold: 'working', reportsWorking: true },
		source: { steps: CODEX_STEPS, origin: ORIGIN.codex, clockOffsetMs: STILL },
		auto: true,
	},
	pi: {
		label: 'Working · Pi',
		note: ORIGIN.pi,
		options: { agent: 'pi', hold: 'working' },
		source: { steps: PI_STEPS, origin: ORIGIN.pi, clockOffsetMs: STILL },
		auto: true,
	},
	unknown: {
		label: 'Tokens unknown',
		note: `${ORIGIN.none} Elapsed time only; it never claims the agent is working.`,
		options: { hold: 'received' },
		source: { steps: [], origin: ORIGIN.none, clockOffsetMs: STILL },
		auto: true,
	},
	replied: {
		label: 'Replied',
		note: 'The line stays, dim, under the reply until the next send.',
		options: { reportsWorking: true, replyMs: 1200 },
		source: { steps: CLAUDE_STEPS, origin: ORIGIN.claude, clockOffsetMs: 184_000 },
		auto: true,
	},
	'not-sent': {
		label: 'Not sent',
		note: "Same as variant A: the reason next to the composer instead of today's top banner, your message back in the editor.",
		options: { outcome: 'not-sent' },
		source: { steps: CLAUDE_STEPS, origin: ORIGIN.claude },
		auto: true,
	},
	unconfirmed: {
		label: 'Not confirmed',
		note: 'Unchanged: today’s panel with “I checked the outcome”.',
		options: { outcome: 'unconfirmed', unknownMs: 1500 },
		source: { steps: CLAUDE_STEPS, origin: ORIGIN.claude },
		auto: true,
	},
	'try-claude': {
		label: 'Try it · Claude Code',
		note: 'Type and send; three minutes of steps play in ten seconds.',
		options: { reportsWorking: true, workMs: 400, replyMs: 10_000 },
		source: { steps: quick(CLAUDE_STEPS), origin: ORIGIN.claude },
		auto: false,
	},
	'try-unknown': {
		label: 'Try it · tokens unknown',
		note: 'Type and send; nothing bound, elapsed time only.',
		options: { replyMs: 8000 },
		source: { steps: [], origin: ORIGIN.none },
		auto: false,
	},
}

function ActivityStory({ frame: initial }: { frame: ActivityFrame }) {
	const [frame, setFrame] = useState<ActivityFrame>(initial)
	const [run, setRun] = useState(0)
	useEffect(() => setFrame(initial), [initial])
	const spec = ACTIVITY[frame]
	return (
		<div className="rcpt-story">
			<nav className="rcpt-story-bar" aria-label="Story frames">
				<span className="rcpt-story-title">
					E5 Activity line
					<span>{spec.note}</span>
				</span>
				<span className="rcpt-story-frames">
					{(Object.keys(ACTIVITY) as ActivityFrame[]).map(key => (
						<Btn
							key={key}
							sm
							tone={key === frame ? 'quiet' : 'ghost'}
							ariaCurrent={key === frame ? 'page' : undefined}
							onClick={() => {
								setFrame(key)
								setRun(value => value + 1)
							}}
						>
							{ACTIVITY[key].label}
						</Btn>
					))}
				</span>
			</nav>
			<ActivityStage key={`${frame}:${run}`} frame={frame} />
		</div>
	)
}

function ActivityStage({ frame }: { frame: ActivityFrame }) {
	const spec = ACTIVITY[frame]
	const slots = useMemo(() => activitySlots(spec.source), [spec])
	return <Stage options={spec.options} auto={spec.auto} slots={slots} />
}

/** E5: Claude Code's activity line — glyph, verb, elapsed, live tokens — under the conversation. */
export const E5ActivityLine: Story = {
	name: 'E5 Activity line',
	// Frames are switched in the story's own bar; the A–D frame control does not apply.
	parameters: { controls: { disable: true } },
	render: () => <ActivityStory frame="claude" />,
}
