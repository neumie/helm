import type { Meta, StoryObj } from '@storybook/react-vite'
import DocumentReviewStories from '../../document-review/DocumentReview.stories'
import RemoteStories from '../../remote/RemoteWorkspace.stories'
import { Proposal } from '../proposal'
import { REMOTE_LABEL, REVIEW_LABEL, Surface, stageCss } from './surfaces'

const ReviewHarness = DocumentReviewStories.component
const RemoteHarness = RemoteStories.component

const LARGE = 1.08
const scaled = (base: number) => `${Number((base * LARGE).toFixed(2))}px`
const px = (base: number) => `${base}px → ${scaled(base)}`

const meta = {
	title: 'Proposals/D7 Surface reach/UI scale',
	parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D7"
			variant="Current · Settings → Appearance → Large (1.08), okna zůstanou na 1"
			note="Cockpit zvětší text o 8 %. Document Review i Remote hodnotu nedostanou (--ui-scale zůstává 1 ze styles.css :root); DR má jen vlastní zoom ⌘= / ⌘-."
			facts={[
				'--ui-scale 1',
				'DR čtení 15px, řádek 25.5px',
				'DR h1 28px',
				'DR sloupec 680px',
				'Remote zprávy 16px, základ 13px',
			]}
			css={stageCss()}
		>
			<Surface label={REVIEW_LABEL}>
				<ReviewHarness scenario="editorial" />
			</Surface>
			<Surface label={REMOTE_LABEL}>
				<RemoteHarness markdownExample />
			</Surface>
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · okna následují UI scale (doporučuji)',
	render: () => (
		<Proposal
			decision="D7"
			variant="A · okna následují UI scale 1.08 (doporučuji)"
			note="DR dostane --ui-scale od main přes preload, jeho zoom se násobí navrch. Škáluje se text, výška řádku a šířka čtecího sloupce; odsazení a ikony zůstávají v px."
			facts={[
				`--ui-scale ${LARGE}`,
				`DR čtení ${px(15)}, řádek 25.5px → ${scaled(25.5)}`,
				`DR h1 ${px(28)}`,
				`DR sloupec ${px(680)}`,
				`Remote zprávy ${px(16)}, základ ${px(13)}`,
			]}
			overrides={{ '--ui-scale': String(LARGE) }}
			css={stageCss()}
		>
			<Surface label={REVIEW_LABEL}>
				<ReviewHarness scenario="editorial" />
			</Surface>
			<Surface label="Helm Remote · jen s vlastní volbou v Remote (ukázka)">
				<RemoteHarness markdownExample />
			</Surface>
		</Proposal>
	),
}
