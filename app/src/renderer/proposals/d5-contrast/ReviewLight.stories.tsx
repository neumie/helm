// D5/5b Review light — Document Review's light scope: --accent misses 4.5:1 on its well by 0.001, and --neutral is
// not overridden there, so the dark-tuned value leaks in. See docs/plans/design-system/proposals/D5.md.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { contrast } from '../contrast'
import { Proposal } from '../proposal'
import { REVIEW_FIX, REVIEW_LIGHT, reviewFacts } from './values'
import { Board, FRAME_CSS, ReviewLight, ReviewLightPassages } from './views'

const meta: Meta = {
	title: 'Proposals/D5 Contrast/Review light',
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

/** The light scope is set on the review root, so variants override it there (tokens on <html> would lose). */
const scope = (body: string) => `
.proposal-stage .document-review[data-review-theme="light"] { ${body} }
`
const ACCENT = `--accent: ${REVIEW_FIX.accent}; --accent-fill: ${REVIEW_FIX.accent};`
const NEUTRAL = `--neutral: ${REVIEW_FIX.neutral}; --neutral-soft: color-mix(in srgb, ${REVIEW_FIX.neutral} 15%, transparent);`

function Surfaces() {
	return (
		<Board>
			<ReviewLight />
			<ReviewLightPassages />
		</Board>
	)
}

/** Shared by every variant: the pixels match, only the measured pair differs. */
const SAME =
	'Varianty vypadají stejně: accent se liší o 1 v modrém kanálu a odkaz ani --neutral v těchto stavech na obrazovce nejsou.'

const FRAME = `${FRAME_CSS}
.proposal-stage .d5-full { width: 1100px; }
`

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D5/5b"
			variant="Current"
			note={`Accent nese odkazy, výběr a fokus; --neutral světlý scope nepřepisuje (zdědí tmavou hodnotu). ${SAME}`}
			facts={reviewFacts(REVIEW_LIGHT.accent, REVIEW_LIGHT.neutral)}
			css={FRAME}
		>
			<Surfaces />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · accent + neutral (doporučuji)',
	render: () => (
		<Proposal
			decision="D5/5b"
			variant="A · accent o krok tmavší + vlastní --neutral (doporučuji)"
			note={`Accent o krok tmavší, --neutral dostane světlou hodnotu stejného odstínu. ${SAME}`}
			facts={reviewFacts(REVIEW_FIX.accent, REVIEW_FIX.neutral)}
			css={FRAME + scope(ACCENT + NEUTRAL)}
		>
			<Surfaces />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · jen accent',
	render: () => (
		<Proposal
			decision="D5/5b"
			variant="B · jen accent, neutral jako výjimka"
			note={`Jen accent, --neutral dál dědí tmavou hodnotu s pravidlem „v Review se nepoužívá“. ${SAME}`}
			facts={reviewFacts(REVIEW_FIX.accent, REVIEW_LIGHT.neutral)}
			css={FRAME + scope(ACCENT)}
		>
			<Surfaces />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · ponechat',
	render: () => (
		<Proposal
			decision="D5/5b"
			variant="C · ponechat"
			note={`Beze změny, accent na well ${contrast(REVIEW_LIGHT.accent, REVIEW_LIGHT.well).toFixed(3)}:1 jako výjimka v seznamu otevřených.`}
			facts={reviewFacts(REVIEW_LIGHT.accent, REVIEW_LIGHT.neutral)}
			css={FRAME}
		>
			<Surfaces />
		</Proposal>
	),
}
