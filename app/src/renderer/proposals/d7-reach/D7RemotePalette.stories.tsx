import type { Meta, StoryObj } from '@storybook/react-vite'
import RemoteStories from '../../remote/RemoteWorkspace.stories'
import { over, ratio } from '../contrast'
import { Proposal } from '../proposal'
import { HELM, REMOTE_LABEL, REMOTE_OWN, Surface, remoteSurfacesFrom, stageCss } from './surfaces'

const RemoteHarness = RemoteStories.component

// Measured from remote.css (own) and theme-presets.ts HELM_TOKENS (app).
const own = {
	text2: ratio('#62666e', REMOTE_OWN['--pane']),
	text1: ratio('#9a9ea6', REMOTE_OWN['--pane']),
	raised: over('#ffffff', 0.11, REMOTE_OWN['--pane']),
}
const app = {
	text2: ratio('#62666e', '#141517'),
	text1: ratio('#9a9ea6', '#141517'),
	raised: over('#ffffff', 0.09, '#141517'),
}
// The weakest text pair in this view: --text-2 ("Workspace: …") on the selected directory row (--fill-raised).
const ownSelected = ratio('#62666e', own.raised)
const appSelected = ratio('#62666e', app.raised)

const meta = {
	title: 'Proposals/D7 Surface reach/Remote palette',
	parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D7"
			variant="Current · vlastní paleta Remote, nikde zapsaná"
			note="remote.css L26-37 přepisuje 7 základních tokenů (pane, chrome, well, 2 hairline, 2 fill) na tmavší „telefonní“ žebřík. Sdílené prvky (Btn, MenuButton) tu vypadají jinak než v aplikaci; design-system.md to nezmiňuje."
			facts={[
				'--pane #0d0d0d, --chrome #1c1c1e, --well #1a1a1a',
				'hairline 8 %, fill-subtle 5.5 %, fill-raised 11 %',
				`--text-2 na pane ${own.text2}, na vybraném řádku ${ownSelected}`,
				`--text-1 na pane ${own.text1}`,
			]}
			css={stageCss()}
		>
			<Surface label={REMOTE_LABEL}>
				<RemoteHarness markdownExample />
			</Surface>
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · paleta aplikace',
	render: () => (
		<Proposal
			decision="D7"
			variant="A · Remote přebírá paletu aplikace"
			note="Smazat přepis v remote.css: Remote má stejné povrchy jako cockpit. Jeden žebřík, sdílené prvky vypadají všude stejně; Remote ztratí tmavší telefonní pozadí (pane #141517 místo #0d0d0d) a well bude tmavší než pane, ne světlejší."
			facts={[
				'--pane #141517, --chrome #1a1c1f, --well #0f1113',
				'hairline 7 %, fill-subtle 5 %, fill-raised 9 %',
				`--text-2 na pane ${app.text2}, na vybraném řádku ${appSelected}`,
				`--text-1 na pane ${app.text1}`,
				`fill-raised ${app.raised} (vlastní ${own.raised})`,
			]}
			css={stageCss(remoteSurfacesFrom(HELM))}
		>
			<Surface label={REMOTE_LABEL}>
				<RemoteHarness markdownExample />
			</Surface>
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · vlastní paleta, ale zapsaná (doporučuji)',
	render: () => (
		<Proposal
			decision="D7"
			variant="B · vlastní paleta, ale pravidlem zapsaná (doporučuji)"
			note="Vizuálně beze změny; mění se pravidla: hodnoty dostanou jména (--remote-pane, --remote-chrome, …) vedle presetů, design-system.md je zapíše a kontrastní test je hlídá. High contrast pak potřebuje i HC verzi téhle palety."
			facts={[
				'stejné hodnoty jako Current',
				`--text-2 na pane ${own.text2}, na vybraném řádku ${ownSelected}`,
				'nové: tokeny v theme-presets.ts + kontrastní test',
			]}
			css={stageCss()}
		>
			<Surface label={REMOTE_LABEL}>
				<RemoteHarness markdownExample />
			</Surface>
		</Proposal>
	),
}
