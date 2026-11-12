// D5/5a Remote meta — Remote re-binds its surfaces (page #0d0d0d, chrome #1c1c1e, bubble #2f2f2f) but keeps the
// app's --text-2, which also colours assistant thinking (13px reading text). See docs/plans/design-system/proposals/D5.md.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { HELM, REMOTE_META, remoteFacts } from './values'
import { Board, FRAME_CSS, RemoteThinking } from './views'

const meta: Meta = {
	title: 'Proposals/D5 Contrast/Remote meta',
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

/** Variant B: a Remote-only value, scoped where remote.css scopes its own ladder. */
const REMOTE_ONLY_CSS = `
.proposal-stage .remote-workspace,
.proposal-stage .remote-login,
.proposal-stage .remote-empty { --text-2: ${REMOTE_META.page}; }
`

function Surfaces() {
	return (
		<Board>
			<RemoteThinking />
		</Board>
	)
}

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D5/5a"
			variant="Current"
			note="Thinking, placeholder composeru, poznámky v menu a popisky faktů jsou --text-2; na bublině dnes žádný neleží."
			facts={remoteFacts(HELM.text2)}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · převzít D5/1 A (doporučuji)',
	render: () => (
		<Proposal
			decision="D5/5a"
			variant="A · převzít hodnotu z D5/1 A (doporučuji)"
			note="Remote si text-2 nepřepisuje, takže zdědí aplikační hodnotu bez nového tokenu: 4.5:1 na page, chrome i composeru, vybraný řádek zůstane pod."
			facts={remoteFacts(REMOTE_META.follow)}
			overrides={{ '--text-2': REMOTE_META.follow }}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · Remote-only, 4.5:1 na page',
	render: () => (
		<Proposal
			decision="D5/5a"
			variant="B · vlastní Remote hodnota, 4.5:1 na page"
			note="Vlastní Remote token, nejmenší zvednutí pro thinking na page; sheety a menu na chrome zůstanou pod 4.5."
			facts={remoteFacts(REMOTE_META.page)}
			css={FRAME_CSS + REMOTE_ONLY_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · ponechat',
	render: () => (
		<Proposal
			decision="D5/5a"
			variant="C · ponechat, výjimka"
			note="Beze změny: thinking jako vedlejší text (výjimka), bublina jako zakázaná plocha pro text-2."
			facts={remoteFacts(HELM.text2)}
			css={FRAME_CSS}
		>
			<Surfaces />
		</Proposal>
	),
}
