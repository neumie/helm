// D16 · Scrims (docs/plans/design-system/proposals/D16.md): Remote's More sheet and navigation drawer dim the page
// with `rgb(0 0 0 / 58%)` + blur(3px); the app's token `--scrim` is 40% in Helm (55% in High contrast). Frames are
// the real Remote Reading story at phone width plus the app's own Finish setup sheet for comparison.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { HELM_TOKENS, HIGH_CONTRAST_TOKENS } from '../../../design-tokens.generated'
import { over } from '../contrast'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board } from './frame'
import { APP_SHEET, MORE_SHEET, NAVIGATION } from './remote-frames'

const FRAMES = [MORE_SHEET, NAVIGATION, APP_SHEET]

const PANE = HELM_TOKENS['--pane'] ?? '#141517'
const TEXT = HELM_TOKENS['--text-0'] ?? '#ececee'
const HELM_SCRIM = HELM_TOKENS['--scrim'] ?? ''
const HC_SCRIM = HIGH_CONTRAST_TOKENS['--scrim'] ?? ''
/** What the dimmed transcript text and page become under a black scrim of `alpha`. */
const dimmed = (alpha: number) => `text ${over('#000000', alpha, TEXT)}, plocha ${over('#000000', alpha, PANE)}`

const DISMISS = '.remote-sheet-dismiss, .remote-navigation-dismiss'
const TOKEN = `${DISMISS} { background: var(--scrim); }`
const RAISED = `:root { --scrim: rgba(0, 0, 0, 0.58); }\n${TOKEN}`

const meta: Meta = { title: 'Proposals/D16 Remote values/Scrims', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · Remote 58 %, aplikace 40 %',
	render: () => (
		<Proposal
			decision="D16"
			variant="Current · Remote 58 % + blur 3px, aplikace --scrim 40 %"
			note="Remote ztmaví stránku víc než aplikace. Pozor: spec tvrdí, že --scrim je 55 %; to platí jen pro High contrast, v presetu Helm je 40 %."
			facts={[
				`Remote 58 %: ${dimmed(0.58)}`,
				`aplikace --scrim ${HELM_SCRIM}: ${dimmed(0.4)}`,
				`High contrast --scrim ${HC_SCRIM}`,
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · Remote bere --scrim (doporučuji)',
	render: () => (
		<Proposal
			decision="D16"
			variant="A · Remote bere --scrim (Helm 40 %, High contrast 55 %) (doporučuji)"
			note="Jeden scrim všude a téma ho řídí. Remote za sheetem a drawerem zesvětlí z 58 na 40 %, text pod ním je víc vidět; rozmazání 3px zůstává, takže pozadí pořád ustupuje. Aplikace beze změny."
			facts={[`Remote 40 %: ${dimmed(0.4)}`, 'High contrast: 55 %', 'blur 3px zůstává', 'aplikace beze změny']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={TOKEN} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · výjimka Remote (vypadá stejně)',
	render: () => (
		<Proposal
			decision="D16"
			variant="B · 58 % zůstane jako výjimka Remote"
			note="Vypadá stejně jako Current. §3.23 pojmenuje silnější scrim telefonu (sheet přes celou obrazovku potřebuje víc odstupu) a lint ho pustí jen ve složce Remote. Téma ho nezmění."
			facts={['Remote 58 %, aplikace 40 %', 'pixely beze změny']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · --scrim na 58 % všude',
	render: () => (
		<Proposal
			decision="D16"
			variant="C · token --scrim v presetu Helm 40 → 58 %, Remote ho bere"
			note="Remote vypadá stejně jako Current, ale ztmaví se i sheety v aplikaci (sidebar, Run Context, swipe zpět). Mění se hodnota tokenu, takže starší nedotčené soubory témat potřebují PRESET_EARLIER_VALUES."
			facts={[
				`Remote i aplikace 58 %: ${dimmed(0.58)}`,
				'High contrast 55 % by byl světlejší než Helm (zvážit taky 58 %)',
				'mění sidebar sheet, Run Context, swipe scrim',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={RAISED} />
		</Proposal>
	),
}
