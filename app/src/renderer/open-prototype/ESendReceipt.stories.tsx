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
import { RECEIPT_VARIANTS, type ReceiptVariant, receiptSlots } from './receipt'
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

function Frame({ variant, frame }: { variant: ReceiptVariant | 'today'; frame: Frame }) {
	const spec = FRAMES[frame]
	const fixture = useMemo(() => createStagedReviewFixture({ ...REALISTIC, ...spec.options }), [spec])
	const slots = useMemo(() => (variant === 'today' ? undefined : receiptSlots(variant)), [variant])
	const root = useRef<HTMLDivElement>(null)
	useEffect(() => {
		let alive = true
		if (spec.auto && root.current) void autoSend(root.current, !!spec.passage, () => alive)
		return () => {
			alive = false
			fixture.dispose()
		}
	}, [fixture, spec])
	return (
		<div className="rcpt-story-window" ref={root}>
			<DocumentReview api={fixture.api} sendReceipt={slots} />
		</div>
	)
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
