// D8 · Letter-spacing (research/helm-spec.md C4, research/helm-tokens.md §2.2): §2.2 says the base -0.01em is
// never overridden, but the agent dock spaces its key symbols (⌘⇧J, ⌘↵, ⌘O) at +0.04em and Settings → Remote
// spaces the one-time code at +0.08em. Monospace text (terminal, code blocks, Signals branch/prompt fields, the
// viewer) resets to normal/0 so cells line up; that exception is needed in every variant and is only documented.
// The one-time code is itself monospace (var(--font-mono)), so under that rule its base is normal, not -0.01em.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameSpec, waitFor } from './frame'

const FRAMES: readonly FrameSpec[] = [
	{
		id: 'views-terminal-workspace--agent-dock-question',
		label: 'Agent dock · ⌘O, ⌘↵ v nápovědě, ⌘⇧J v řádku',
		width: 900,
		height: 640,
		zoom: 1.4,
		// Key hints show only while the pane holds the keys.
		keepFocus: true,
		setup: async ({ doc }) => {
			const pane = await waitFor(() => doc.querySelector<HTMLElement>('.agent-dock-pane'), 'dock pane')
			pane.focus()
		},
	},
	{
		id: 'views-sidebar--remote-pairing-code',
		label: 'Settings → Remote · jednorázový kód (.remote-code, monospace)',
		width: 460,
		height: 420,
		zoom: 1.4,
		setup: async ({ doc }) => {
			const code = await waitFor(() => doc.querySelector<HTMLElement>('.remote-code'), 'pairing code')
			// The QR above it decodes asynchronously and moves the code down; scroll once the layout settled.
			await new Promise(resolve => setTimeout(resolve, 800))
			code.scrollIntoView({ block: 'center' })
		},
	},
]

const KEYS =
	'.agent-dock-kbd, .agent-dock-title-hint kbd[data-face="symbols"], .agent-dock-hint kbd[data-face="symbols"]'

const meta: Meta = { title: 'Proposals/D8 Scale/Letter-spacing', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · klávesy +0.04em, kód +0.08em',
	render: () => (
		<Proposal
			decision="D8"
			variant="Current · klávesy +0.04em, kód +0.08em"
			note="Dvě nezapsané výjimky ze základu -0.01em."
			facts={[
				'klávesy ×3 pravidla: +0.04em',
				'.remote-code (monospace) +0.08em',
				'ostatní monospace normal/0 ×8 (nutné, jen zapsat do §2.2)',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · bez výjimek: -0.01em, monospace normal',
	render: () => (
		<Proposal
			decision="D8"
			variant="A · bez výjimek: -0.01em, monospace normal"
			note="Symboly kláves dostanou -0.01em jako zbytek textu a jsou o něco těsnější (0.6 px na znak při 12 px). Kód je monospace, takže dostane normal jako ostatní monospace; při opisování je hůř čitelný."
			facts={['klávesy -0.01em', '.remote-code 0.08em → normal', 'monospace normal (výjimka zapsaná)']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={`${KEYS} { letter-spacing: -0.01em; } .remote-code { letter-spacing: normal; }`} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · jeden povolený krok +0.04em (doporučuji)',
	render: () => (
		<Proposal
			decision="D8"
			variant="B · jeden povolený krok +0.04em (doporučuji)"
			note="§2.2 dostane dvě zapsané výjimky: +0.04em pro symboly kláves a kódy k opsání, normal pro ostatní monospace. Kód se sjednotí z +0.08em na +0.04em; klávesy beze změny."
			facts={['klávesy +0.04em', '.remote-code 0.08 → 0.04em', 'monospace normal (výjimka zapsaná)']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css=".remote-code { letter-spacing: 0.04em; }" />
		</Proposal>
	),
}
