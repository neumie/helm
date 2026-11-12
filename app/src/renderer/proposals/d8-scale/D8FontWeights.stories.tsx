// D8 · Font weights (research/helm-spec.md C21, research/helm-tokens.md §3.2): the extension widget's model
// trigger uses 650 (between ladder steps) and Document Review's "Not sent" mark uses 700, while §2.2 allows 600-700
// and the dock/Signals specs say no bold. The 700 count badges are in "Count badges". Frames are the real
// extension widget (closed shadow root; build it with `cd extension && node build-workbench.mjs`) and the real
// Document Review send path refused before any effect. Markdown <strong> has no written weight anywhere, so it gets
// the browser's 700 in every variant; that is noted, not changed.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameContext, type FrameSpec, waitFor } from './frame'

interface WidgetHarness {
	require(selector: string): HTMLElement
	query(selector: string): HTMLElement | null
}

/** Opens the widget card and puts the variant CSS inside its closed shadow root (the body style cannot reach it). */
async function openWidget({ win, css }: FrameContext): Promise<void> {
	const harness = await waitFor(
		() => (win as Window & { extensionWorkbench?: WidgetHarness }).extensionWorkbench,
		'extension widget harness',
	)
	harness.require('.vg-pill').click()
	const trigger = await waitFor(() => harness.query('.vg-model__trigger'), 'model trigger')
	// The picker sits in the collapsed "Run with" disclosure.
	const details = trigger.closest('details')
	if (details) details.open = true
	// The frame has its own realm: compare by shape, not `instanceof ShadowRoot`.
	const root = trigger.getRootNode() as ShadowRoot | Document
	if (css !== '' && 'host' in root) {
		const style = trigger.ownerDocument.createElement('style')
		style.textContent = css
		root.append(style)
	}
}

const REVIEW_NOT_SENT = {
	id: 'views-helm-open-e-send-receipt--e-5-activity-line',
	args: 'frame:not-sent',
	width: 1000,
	height: 640,
} as const

const FRAMES: readonly FrameSpec[] = [
	{
		id: 'views-extension-widget--closed-shadow',
		label: 'Rozšíření · výběr modelu „Auto“ (.vg-model__trigger)',
		width: 560,
		height: 420,
		zoom: 1.4,
		setup: openWidget,
	},
	{ ...REVIEW_NOT_SENT, label: 'Document Review · Not sent u composeru' },
	{
		...REVIEW_NOT_SENT,
		label: 'Document Review · vykřičník „!“ (.review-send-refused-glyph)',
		zoom: 3,
		crop: { selector: '.review-send-refused', pad: 8 },
	},
]

const meta: Meta = { title: 'Proposals/D8 Scale/Font weights', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · 650 a 700',
	render: () => (
		<Proposal
			decision="D8"
			variant="Current · 650 a 700"
			note="Dvě zapsané tučnosti mimo 400 / 500 / 600."
			facts={[
				'.vg-model__trigger 12/650',
				'.review-send-refused-glyph 700',
				'zapsáno v aplikaci: 600×69, 500×30, 400×13, 700×3, 650×1',
				'<strong> v Markdownu: 700 z prohlížeče (nezapsáno)',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · vše na 600 (doporučuji)',
	render: () => (
		<Proposal
			decision="D8"
			variant="A · vše na 600 (doporučuji)"
			note="650 → 600 a 700 → 600; nejvyšší zapsaná tučnost je pak 600. <strong> v Markdownu (Remote, Document Review) dál dostává 700 z prohlížeče, to by chtělo vlastní pravidlo. Rozdíl je sotva vidět."
			facts={['.vg-model__trigger 12/600', '.review-send-refused-glyph 600']}
			css={BOARD_CSS}
		>
			<Board
				frames={FRAMES}
				css=".vg-model__trigger { font-weight: 600; } .review-send-refused-glyph { font-weight: 600; }"
			/>
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · 600, 700 jen pro jednoznakové značky',
	render: () => (
		<Proposal
			decision="D8"
			variant="B · 600, 700 jen pro jednoznakové značky"
			note="650 → 600; pravidlo povolí 700 jen pro samostatný znak v kruhu (!, ?), aby byl při 10–11 px čitelný. Pozor: Odznaky A i B dávají otazníku 600."
			facts={['.vg-model__trigger 12/600', '.review-send-refused-glyph 700 (pravidlo)']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css=".vg-model__trigger { font-weight: 600; }" />
		</Proposal>
	),
}
