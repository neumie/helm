import type { Meta, StoryObj } from '@storybook/react-vite'
import DocumentReviewStories from '../../document-review/DocumentReview.stories'
import RemoteStories from '../../remote/RemoteWorkspace.stories'
import { over, ratio } from '../contrast'
import { Proposal } from '../proposal'
import {
	HIGH_CONTRAST,
	REMOTE_LABEL,
	REMOTE_OWN,
	REVIEW_LABEL,
	Surface,
	remoteSurfacesFrom,
	stageCss,
} from './surfaces'

const ReviewHarness = DocumentReviewStories.component
const RemoteHarness = RemoteStories.component

// Measured once from the preset values (theme-presets.ts) and remote.css.
const helmText2 = ratio('#62666e', '#141517')
const hcText2 = ratio('#9096a0', '#0c0d0f')
const remoteText2 = ratio('#62666e', REMOTE_OWN['--pane'])
const helmHairline = ratio(over('#ffffff', 0.07, '#141517'), '#141517')
const hcHairline = ratio(over('#ffffff', 0.16, '#0c0d0f'), '#0c0d0f')
const hcText1 = ratio('#c2c7cf', '#0c0d0f')

const meta = {
	title: 'Proposals/D7 Surface reach/High contrast',
	parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D7"
			variant="Current · High contrast zapnutý, okna ho ignorují"
			note="Jakub má High contrast (nebo macOS Increase contrast). Cockpit ho má, Document Review a Remote vypadají pořád jako Helm: neběží v nich appearance.init()."
			facts={[
				`DR --text-2 #62666e na #141517 ${helmText2}`,
				`DR hairline .07 ${helmHairline}`,
				`Remote --text-2 na #0d0d0d ${remoteText2}`,
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
	name: 'A · okna následují High contrast (doporučuji)',
	render: () => (
		<Proposal
			decision="D7"
			variant="A · okna následují High contrast (doporučuji)"
			note="Stejné tokeny jako cockpit: DR je dostane od main přes preload, Remote jen z prefers-contrast telefonu. Remote tu má HC paletu aplikace; s B v bodě 3 by potřeboval vlastní HC paletu (zatím není)."
			facts={[
				`--text-2 #9096a0 na #0c0d0f ${hcText2} (bylo ${helmText2})`,
				`--text-1 #c2c7cf ${hcText1}`,
				`hairline .16 ${hcHairline} (bylo ${helmHairline})`,
				'--remote-bubble #2f2f2f zůstává',
				'světlý režim DR má vlastní paletu, HC se ho netýká',
			]}
			overrides={HIGH_CONTRAST}
			css={stageCss(remoteSurfacesFrom(HIGH_CONTRAST))}
		>
			<Surface label={REVIEW_LABEL}>
				<ReviewHarness scenario="editorial" />
			</Surface>
			<Surface label="Helm Remote · HC paleta aplikace (ukázka)">
				<RemoteHarness markdownExample />
			</Surface>
		</Proposal>
	),
}
