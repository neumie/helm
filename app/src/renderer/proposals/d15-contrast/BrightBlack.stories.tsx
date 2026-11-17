// D15/3 Terminal bright black — ANSI colour 8 (`--ansi-bright-black`, SGR 90) on `--term-bg`. Programs use it for
// secondary text: git dates, `ls` permissions, test summaries, zsh-autosuggestions' ghost completion.
// See docs/plans/design-system/proposals/D15.md.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameSpec } from './frame'
import { writeShellSession } from './terminal'
import { BRIGHT_BLACK_LIFT, S, helm, high, ratio } from './values'

const FRAMES: readonly FrameSpec[] = [
	{
		id: 'views-terminal-workspace--browser-harness',
		label: 'Terminál · šedé jsou časy gitu, práva v ls, souhrn testů a našeptávač „tus --short“ na posledním řádku',
		width: 1000,
		height: 620,
		zoom: 1.5,
		crop: { selector: '.term-holder.active', pad: 0, bottom: 380 },
		setup: writeShellSession,
	},
]

/**
 * The terminal theme is built from the tokens when the workspace mounts (`termThemeFromTokens`), so the frame sets
 * the rendered colour of palette index 8. High contrast already passes and has no frame: its theme is not rebuilt here.
 */
const LIFT = `.xterm .xterm-fg-8 { color: ${BRIGHT_BLACK_LIFT} !important; }`

const meta: Meta = { title: 'Proposals/D15 Contrast/Terminal bright black', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

const CURRENT = ratio(helm('--ansi-bright-black'), S.helm.term)
const HIGH = `High contrast ${high('--ansi-bright-black')} ${ratio(high('--ansi-bright-black'), S.high.term)} (prochází)`

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D15/3"
			variant="Current"
			note="Jasná černá (ANSI 8) je v Helmu tmavá: programy jí píšou vedlejší text, který se má číst, ale nemá křičet."
			facts={[`Helm ${helm('--ansi-bright-black')} na --term-bg ${CURRENT}`, HIGH, 'potřeba 4.5:1']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · zesvětlit na 4.5:1 (doporučuji)',
	render: () => (
		<Proposal
			decision="D15/3"
			variant="A · zesvětlit na 4.5:1 (doporučuji)"
			note={`Nejmenší posun stejného odstínu na 4.5:1: ${BRIGHT_BLACK_LIFT}, skoro totožný s High contrast. Časy, práva a souhrny jsou čitelné, pořád zjevně vedlejší vůči bílému textu.`}
			facts={[
				`Helm ${BRIGHT_BLACK_LIFT} na --term-bg ${ratio(BRIGHT_BLACK_LIFT, S.helm.term)} (dnes ${CURRENT})`,
				`odstup od --ansi-white ${ratio(helm('--ansi-white'), S.helm.term)} vs ${ratio(BRIGHT_BLACK_LIFT, S.helm.term)}`,
				HIGH,
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={LIFT} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · ponechat, výjimka',
	render: () => (
		<Proposal
			decision="D15/3"
			variant="B · ponechat, výjimka"
			note="Vypadá stejně jako Current, jen pravidlo: barvy terminálu volí program, ne Helm, a tmavá jasná černá je zvyk terminálových palet (ghost text našeptávače má být skoro neviditelný)."
			facts={[`Helm ${CURRENT}`, HIGH]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}
