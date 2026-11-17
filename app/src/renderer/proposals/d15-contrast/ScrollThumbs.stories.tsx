// D15/2 Scroll thumbs — `--thumb` (Document Review, sheets, log and plan wells, Run Context, the toast countdown)
// and the terminal's overlay `--term-scroll-thumb` are under the 3:1 non-text need (WCAG 1.4.11).
// See docs/plans/design-system/proposals/D15.md.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameContext, type FrameSpec, waitFor } from './frame'
import { writeShellSession } from './terminal'
import { REVIEW_LIGHT, S, THUMB_3, helm, high, ratio, rootTokens, surface, tint, white } from './values'

/** Scrolls the reading a little, so the thumb sits inside its track. */
const scrollReading = async ({ doc }: FrameContext) => {
	const reading = await waitFor(() => doc.querySelector<HTMLElement>('.review-reading'), 'reading')
	reading.scrollTop = 160
}

const FRAMES: readonly FrameSpec[] = [
	{
		id: 'views-terminal-workspace--browser-harness',
		label: 'Terminál · překryvný posuvník vpravo (--term-scroll-thumb na --term-bg)',
		width: 900,
		height: 560,
		zoom: 2,
		crop: { selector: '.term-holder.active', pad: 0, right: 140, bottom: 220 },
		setup: writeShellSession,
	},
	{
		id: 'views-document-review--editorial',
		label: 'Document Review · posuvník čtení u pravého okraje (--thumb na --pane), bez zvětšení',
		width: 1000,
		height: 420,
		crop: { selector: '.review-reading', pad: 0, right: 200 },
		setup: scrollReading,
	},
	{
		id: 'views-document-review--editorial-light',
		label: 'Document Review světlý · posuvník čtení u pravého okraje',
		width: 1000,
		height: 420,
		crop: { selector: '.review-reading', pad: 0, right: 200 },
		setup: scrollReading,
	},
	{
		id: 'views-document-review--editorial',
		label: 'Document Review · posuvník čtení u pravého okraje',
		palette: 'high',
		width: 1000,
		height: 420,
		crop: { selector: '.review-reading', pad: 0, right: 200 },
		setup: scrollReading,
	},
]

const reviewLight = (thumb: number, hover: number) => `
.document-review[data-review-theme="light"] {
	--thumb: color-mix(in srgb, var(--text-0) ${thumb}%, transparent);
	--thumb-hover: color-mix(in srgb, var(--text-0) ${hover}%, transparent);
}
`

const HIGH_3 = `:root[data-d15-palette="high"] {
	--thumb: ${white(THUMB_3.high.thumb)} !important;
	--thumb-hover: ${white(THUMB_3.high.hover)} !important;
}
`

const ALL_3 = `${rootTokens({
	'--thumb': white(THUMB_3.helm.thumb),
	'--thumb-hover': white(THUMB_3.helm.hover),
	'--term-scroll-thumb': white(THUMB_3.helm.term),
	'--term-scroll-thumb-hover': white(THUMB_3.helm.termHover),
})}
${HIGH_3}
${reviewLight(THUMB_3.reviewLight.thumb, THUMB_3.reviewLight.hover)}`

const h = S.helm
const hc = S.high
const lightPane = surface(REVIEW_LIGHT.pane)
const thumb = (value: string, on: Parameters<typeof ratio>[1]) => ratio(value, on)
const lightThumb = (percent: number) => ratio(tint(REVIEW_LIGHT.text0, percent), lightPane)

const CURRENT_FACTS = [
	`--thumb na pane ${thumb(helm('--thumb'), h.pane)}, na well ${thumb(helm('--thumb'), h.well)}`,
	`terminál ${thumb(helm('--term-scroll-thumb'), h.term)}`,
	`Review světlý ${lightThumb(14)}`,
	`HC --thumb ${thumb(high('--thumb'), hc.pane)}, terminál ${thumb(high('--term-scroll-thumb'), hc.term)}`,
	'potřeba 3:1 (netextový prvek)',
]

const HIGH_FACTS = [
	`HC --thumb α ${THUMB_3.high.thumb} → ${thumb(white(THUMB_3.high.thumb), hc.pane)} (well ${thumb(white(THUMB_3.high.thumb), hc.well)}), hover α ${THUMB_3.high.hover}`,
	`HC terminál už dnes ${thumb(high('--term-scroll-thumb'), hc.term)}`,
]

const meta: Meta = { title: 'Proposals/D15 Contrast/Scroll thumbs', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D15/2"
			variant="Current"
			note="Tichý jezdec posuvníku: v Helmu bílá 14 % (terminál 22 %), v High contrast 28 % (35 %). Rolovat jde kolečkem, trackpadem i klávesami; jezdec jen ukazuje polohu."
			facts={CURRENT_FACTS}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · 3:1 všude',
	render: () => (
		<Proposal
			decision="D15/2"
			variant="A · 3:1 všude"
			note="Jezdec dosáhne 3:1 na své ploše ve všech paletách. Je výrazně vidět i v klidu; stejný --thumb kreslí i odpočet toastu (1px čára), ten zesvětlí taky."
			facts={[
				`--thumb α ${THUMB_3.helm.thumb} → pane ${thumb(white(THUMB_3.helm.thumb), h.pane)}, well ${thumb(white(THUMB_3.helm.thumb), h.well)}; hover α ${THUMB_3.helm.hover}`,
				`terminál α ${THUMB_3.helm.term} → ${thumb(white(THUMB_3.helm.term), h.term)}; hover α ${THUMB_3.helm.termHover}`,
				`Review světlý text-0 ${THUMB_3.reviewLight.thumb} % → ${lightThumb(THUMB_3.reviewLight.thumb)}`,
				...HIGH_FACTS,
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={ALL_3} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · 3:1 jen v High contrast (doporučuji)',
	render: () => (
		<Proposal
			decision="D15/2"
			variant="B · 3:1 jen v High contrast (doporučuji)"
			note="Jako u okrajů polí (§9 ruling 91 a 92): v Helmu a světlém Review je jezdec tichý a vyjmutý, kdo potřebuje kontrast, má High contrast, kde jezdec 3:1 dosáhne. Helm vypadá stejně jako Current."
			facts={[
				...HIGH_FACTS,
				`Helm beze změny (${thumb(helm('--thumb'), h.pane)}, terminál ${thumb(helm('--term-scroll-thumb'), h.term)}): výjimka`,
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={HIGH_3} />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · výjimka všude',
	render: () => (
		<Proposal
			decision="D15/2"
			variant="C · výjimka všude"
			note="Vypadá stejně jako Current, jen pravidlo: posuvník je dekorativní ukazatel polohy (rolování nezávisí na něm), takže nepotřebuje 3:1 v žádné paletě, ani v High contrast."
			facts={CURRENT_FACTS}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}
