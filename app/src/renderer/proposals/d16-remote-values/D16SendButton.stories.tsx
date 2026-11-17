// D16 · Send button (docs/plans/design-system/proposals/D16.md): Remote's committed Send is a white circle
// (`#fff`, `#0d0d0d` glyph, 88% white hover) in remote.css, outside the palette. Frames are the real Remote Reading
// story at phone width with a draft typed in, so Send is in its primary state.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { HELM_TOKENS, HIGH_CONTRAST_TOKENS } from '../../../design-tokens.generated'
import { over, ratio } from '../contrast'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board } from './frame'
import { SEND_EMPTY, SEND_HOVER, SEND_PHONE, SEND_REST } from './remote-frames'

const FRAMES = [SEND_PHONE, SEND_REST, SEND_HOVER, SEND_EMPTY]

const token = (name: string) => HELM_TOKENS[name] ?? '#000000'
const hc = (name: string) => HIGH_CONTRAST_TOKENS[name] ?? token(name)
/** The capsule the button sits on: --chrome at 68% over --pane (remote.css). */
const CAPSULE = over(token('--chrome'), 0.68, token('--pane'))
const CAPSULE_HC = over(hc('--chrome'), 0.68, hc('--pane'))

const SEND = '.remote-composer-actions .remote-send.btn-primary'
const HOVER = `${SEND}:hover:not(:disabled), ${SEND}[data-force-state="hover"]:not(:disabled)`

const TEXT_FILL = `
${SEND} { background: var(--text-0); color: var(--pane); }
@media (hover: hover) { ${HOVER} { background: color-mix(in srgb, var(--text-0) 88%, transparent); } }
`

const ACCENT_FILL = `
${SEND} { background: var(--accent-fill); color: var(--on-accent); }
@media (hover: hover) { ${HOVER} { background: var(--accent-fill-hover); } }
`

const meta: Meta = { title: 'Proposals/D16 Remote values/Send button', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · bílá #fff, literál',
	render: () => (
		<Proposal
			decision="D16"
			variant="Current · bílá #fff s #0d0d0d, hover 88 % bílé"
			note="Jediné tlačítko Remote, které nebere barvu z tokenů. Komentář v remote.css: akcent už mají odkazy, Send má být jediná výrazná akce. High contrast ho nezmění."
			facts={[
				`šipka #0d0d0d na #fff ${ratio('#0d0d0d', '#ffffff')}`,
				`výplň #fff proti kapsli ${ratio('#ffffff', CAPSULE)}`,
				'hover: rgb(255 255 255 / 88 %)',
				'High contrast: stejné',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · výjimka Remote (vypadá stejně)',
	render: () => (
		<Proposal
			decision="D16"
			variant="A · bílá zůstane, zapíše se jako výjimka Remote"
			note="Vypadá stejně jako Current, mění se jen pravidlo: §3.23 a §9 řeknou, že Send v Remote je bílý, a lint ho pustí jen ve složce Remote. Hodnota zůstane mimo tokeny, takže ji téma nezmění."
			facts={[
				`šipka #0d0d0d na #fff ${ratio('#0d0d0d', '#ffffff')}`,
				`výplň proti kapsli ${ratio('#ffffff', CAPSULE)}`,
				'pixely beze změny',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · výplň --text-0, šipka --pane (doporučuji)',
	render: () => (
		<Proposal
			decision="D16"
			variant="B · výplň --text-0, šipka --pane, hover --text-0 88 % (doporučuji)"
			note="Pořád „bílý“ kruh, jen o odstín šedší (#ececee místo #fff) a s šipkou v barvě plochy. Hodnoty jdou z tokenů, takže High contrast dá čistou bílou s černou šipkou."
			facts={[
				`šipka ${token('--pane')} na ${token('--text-0')} ${ratio(token('--pane'), token('--text-0'))}`,
				`výplň proti kapsli ${ratio(token('--text-0'), CAPSULE)}`,
				`High contrast: ${hc('--pane')} na ${hc('--text-0')} ${ratio(hc('--pane'), hc('--text-0'))}, proti kapsli ${ratio(hc('--text-0'), CAPSULE_HC)}`,
				'žádný nový token',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={TEXT_FILL} />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · primární tlačítko aplikace (akcent)',
	render: () => (
		<Proposal
			decision="D16"
			variant="C · --accent-fill s --on-accent, jako primární tlačítko v aplikaci"
			note="Remote prostě smaže svůj override a Send je modrý jako každé primární tlačítko. Konzistentní s aplikací, ale na tmavé kapsli je méně výrazný a modrou už nesou odkazy v textu."
			facts={[
				`šipka #fff na ${token('--accent-fill')} ${ratio(token('--on-accent'), token('--accent-fill'))}`,
				`výplň proti kapsli ${ratio(token('--accent-fill'), CAPSULE)}`,
				`hover ${token('--accent-fill-hover')}`,
				`High contrast: ${hc('--accent-fill')}, šipka ${ratio(hc('--on-accent'), hc('--accent-fill'))}`,
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={ACCENT_FILL} />
		</Proposal>
	),
}
