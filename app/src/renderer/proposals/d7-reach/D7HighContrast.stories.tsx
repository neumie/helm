import type { Meta, StoryObj } from '@storybook/react-vite'
import DocumentReviewStories from '../../document-review/DocumentReview.stories'
import RemoteStories from '../../remote/RemoteWorkspace.stories'
import { over, ratio } from '../contrast'
import { Proposal } from '../proposal'
import { HELM, HIGH_CONTRAST, REMOTE_LABEL, REVIEW_LABEL, Surface, remoteSurfacesFrom, stageCss } from './surfaces'

const ReviewHarness = DocumentReviewStories.component
const RemoteHarness = RemoteStories.component

// Measured from the current preset values (theme-presets.ts). Remote uses the app palette (§9 ruling 96), so its
// pane is the Helm pane.
const helmPane = HELM['--pane'] ?? ''
const hcPane = HIGH_CONTRAST['--pane'] ?? ''
const helmText2 = ratio(HELM['--text-2'] ?? '', helmPane)
const hcText2 = ratio(HIGH_CONTRAST['--text-2'] ?? '', hcPane)
const helmHairline = ratio(over('#ffffff', 0.07, helmPane), helmPane)
const hcHairline = ratio(over('#ffffff', 0.34, hcPane), hcPane)
const hcText1 = ratio(HIGH_CONTRAST['--text-1'] ?? '', hcPane)

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
				`DR i Remote --text-2 ${HELM['--text-2']} na ${helmPane} ${helmText2}`,
				`DR hairline .07 ${helmHairline}`,
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
			note="Stejné tokeny jako cockpit: DR je dostane od main přes preload, Remote jen z prefers-contrast telefonu. Remote má od D7 paletu aplikace (§9 ruling 96), takže pod HC dostane HC paletu aplikace."
			facts={[
				`--text-2 ${HIGH_CONTRAST['--text-2']} na ${hcPane} ${hcText2} (bylo ${helmText2})`,
				`--text-1 ${HIGH_CONTRAST['--text-1']} ${hcText1}`,
				`hairline .34 ${hcHairline} (bylo ${helmHairline})`,
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
