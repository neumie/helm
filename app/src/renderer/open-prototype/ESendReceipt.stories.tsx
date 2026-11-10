// E — Send receipt (helm open spec D14: E5 decided). What the review window says right after Send. Every frame
// runs the PRODUCTION DocumentReview send path and activity line against a staged host that replays the measured
// native timings; a story-only driver types and presses ⌘↵ for you. Variants A–D were removed once E5 was picked.
// Frames with a verb and tokens show what slice S12 adds: the staged host fills the display-only `activity` that
// the real host will read from a bound Claude Code transcript or Codex rollout. Production fills it only from that.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo, useRef, useState } from 'react'
import '../document-review/document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { Btn } from '../button'
import { DocumentReview } from '../document-review/DocumentReview'
import { type ActivityStep, REALISTIC, type StagedReviewOptions, createStagedReviewFixture } from './receipt-fixture'
import './receipt-story.css'

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
}: { options: Partial<StagedReviewOptions>; passage?: boolean; auto: boolean }) {
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
			<DocumentReview api={fixture.api} />
		</div>
	)
}

// Each frame names where its numbers really come from.
const ORIGIN = {
	claude:
		"S12: Claude Code's transcript, bound to this session by the request id: output tokens since your message, the last tool's name. Updates when each model response ends.",
	codex:
		"S12: Codex's session file (token_count events): output tokens since your message. Updates about every 12 s (p50), 38 s (p90).",
	pi: 'Pi reports working itself today ("Thinking"); its tokens and verb arrive with the Pi package update (S8b).',
	none: 'Nothing bound to the agent: Helm knows only that it has your message. This is every Claude Code and Codex caller until S12.',
}

const step = (seconds: number, tokens: number | null, verb: string | null): ActivityStep => ({
	at: seconds * 1000,
	tokens,
	verb,
})
const CLAUDE_STEPS = [
	step(2, null, null),
	step(9, 812, 'Reading'),
	step(24, 2400, 'Searching'),
	step(51, 5100, 'Editing'),
	step(96, 9800, null),
	step(139, 13_900, 'Running a command'),
	step(168, 16_300, 'Editing'),
]
const CODEX_STEPS = [
	step(3, null, null),
	step(16, 1900, 'Running a command'),
	step(53, 4100, 'Editing'),
	step(91, 7300, 'Running a command'),
	step(150, 11_800, 'Editing'),
]
const PI_STEPS = [
	step(1, null, null),
	step(7, 640, 'Reading'),
	step(33, 3100, 'Editing'),
	step(88, 6900, null),
	step(161, 9400, 'Editing'),
]
/** Live frames compress three minutes into ~10 s so the steps are visible. */
const quick = (steps: ActivityStep[]): ActivityStep[] => steps.map(value => ({ ...value, at: value.at / 18 }))
const STILL = 177_000

type ActivityFrame =
	| 'received'
	| 'claude'
	| 'codex'
	| 'pi'
	| 'pi-today'
	| 'unknown'
	| 'replied'
	| 'not-sent'
	| 'unconfirmed'
	| 'passage'
	| 'try-claude'
	| 'try-unknown'

const ACTIVITY: Record<
	ActivityFrame,
	{ label: string; note: string; options: Partial<StagedReviewOptions>; passage?: boolean; auto: boolean }
> = {
	received: {
		label: 'Received',
		note: 'The waiting tool has your message; nothing read from the agent yet.',
		options: { hold: 'received', clockOffsetMs: 2000 },
		auto: true,
	},
	claude: {
		label: 'Working · Claude Code',
		note: ORIGIN.claude,
		options: { hold: 'working', activity: { steps: CLAUDE_STEPS }, clockOffsetMs: STILL },
		auto: true,
	},
	codex: {
		label: 'Working · Codex',
		note: ORIGIN.codex,
		options: { agent: 'codex', hold: 'working', activity: { steps: CODEX_STEPS }, clockOffsetMs: STILL },
		auto: true,
	},
	pi: {
		label: 'Working · Pi',
		note: ORIGIN.pi,
		options: { agent: 'pi', hold: 'working', activity: { steps: PI_STEPS }, clockOffsetMs: STILL },
		auto: true,
	},
	'pi-today': {
		label: 'Working · Pi today',
		note: 'S11: Pi reports working itself, so the line says "Thinking" with elapsed time; no verb or tokens yet.',
		options: { agent: 'pi', hold: 'working', clockOffsetMs: 42_000 },
		auto: true,
	},
	unknown: {
		label: 'Tokens unknown',
		note: `${ORIGIN.none} Elapsed time only; it never claims the agent is working.`,
		options: { hold: 'received', clockOffsetMs: STILL },
		auto: true,
	},
	replied: {
		label: 'Replied',
		note: 'The line stays, dim, under the reply until the next send.',
		options: { activity: { steps: CLAUDE_STEPS }, replyMs: 1200, clockOffsetMs: 184_000 },
		auto: true,
	},
	'not-sent': {
		label: 'Not sent',
		note: "The reason next to the composer instead of today's top banner, your message back in the editor.",
		options: { outcome: 'not-sent' },
		auto: true,
	},
	unconfirmed: {
		label: 'Not confirmed',
		note: 'Unchanged: today’s panel with “I checked the outcome”.',
		options: { outcome: 'unconfirmed', unknownMs: 1500 },
		auto: true,
	},
	passage: {
		label: 'Passage',
		note: 'A passage question: the line speaks in its own bubble.',
		options: { hold: 'received', clockOffsetMs: 4000 },
		passage: true,
		auto: true,
	},
	'try-claude': {
		label: 'Try it · Claude Code',
		note: 'Type and send; three minutes of steps play in ten seconds.',
		options: { activity: { steps: quick(CLAUDE_STEPS) }, workMs: 400, replyMs: 10_000 },
		auto: false,
	},
	'try-unknown': {
		label: 'Try it · tokens unknown',
		note: 'Type and send; nothing bound, elapsed time only.',
		options: { replyMs: 8000 },
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
			<Stage key={`${frame}:${run}`} options={spec.options} passage={spec.passage} auto={spec.auto} />
		</div>
	)
}

const meta = {
	title: 'Views/Helm open/E Send receipt',
	component: ActivityStory,
	parameters: { layout: 'fullscreen' },
	argTypes: { frame: { control: 'select', options: Object.keys(ACTIVITY) } },
	args: { frame: 'claude' },
} satisfies Meta<typeof ActivityStory>
export default meta
type Story = StoryObj<typeof meta>

/** E5: an activity line in Claude Code's style, drawn with Helm's ActivityIndicator — verb, elapsed, live tokens — under the conversation. */
export const E5ActivityLine: Story = { name: 'E5 Activity line' }
