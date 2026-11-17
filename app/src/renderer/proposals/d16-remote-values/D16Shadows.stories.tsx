// D16 · Shadows (docs/plans/design-system/proposals/D16.md): §2.6 allows exactly two shadows, Remote writes four of
// its own (delivery menu, row menu, More sheet, navigation drawer). Frames are the real Remote stories at phone width.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board } from './frame'
import { DELIVERY_MENU, DRAWER_EDGE, MORE_SHEET, NAVIGATION, ROW_MENU, SHEET_EDGE } from './remote-frames'

const FRAMES = [DELIVERY_MENU, ROW_MENU, DRAWER_EDGE, SHEET_EDGE, MORE_SHEET, NAVIGATION]

const MENU = '.remote-composer-actions .menu-panel'

/** The row menu's literal is already --shadow-1 byte for byte; every variant writes the token there. */
const ROW_TOKEN = '.remote-row-menu { box-shadow: var(--shadow-1); }'

const EXISTING = `
${MENU} { box-shadow: var(--shadow-1); }
${ROW_TOKEN}
.remote-sheet { box-shadow: var(--shadow-2); }
.remote-navigation-menu { box-shadow: var(--shadow-2); }
`

const SHADOW_3 = '0 20px 60px rgba(0, 0, 0, 0.55)'
const THIRD = `
:root { --shadow-3: ${SHADOW_3}; }
${MENU} { box-shadow: var(--shadow-3); }
${ROW_TOKEN}
.remote-sheet { box-shadow: var(--shadow-3); }
.remote-navigation-menu { box-shadow: var(--shadow-3); }
`

const meta: Meta = { title: 'Proposals/D16 Remote values/Shadows', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · čtyři vlastní stíny',
	render: () => (
		<Proposal
			decision="D16"
			variant="Current · čtyři literály v remote.css"
			note="Menu doručení, menu řádku, sheet More a navigační drawer mají každý svůj stín. Sheet a drawer leží na 58% scrimu s rozmazáním, takže jejich stín je na tmavém pozadí skoro neviditelný."
			facts={[
				'menu doručení 0 16px 44px 48 %',
				'menu řádku 0 8px 24px 35 % (= --shadow-1)',
				'sheet 0 20px 60px 55 %',
				'drawer 20px 0 60px 48 % (do strany)',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · dva stíny aplikace (doporučuji)',
	render: () => (
		<Proposal
			decision="D16"
			variant="A · menu --shadow-1, sheet a drawer --shadow-2 (doporučuji)"
			note="Stejné pravidlo jako §2.6: menu a popover dostanou --shadow-1, sheet a drawer --shadow-2. Menu doručení má menší, měkčí stín, okraj mu drží --hairline-strong. Rozdíl u sheetu a draweru je na scrimu sotva vidět."
			facts={[
				'menu doručení → --shadow-1 (0 8px 24px 35 %)',
				'menu řádku → --shadow-1 (beze změny)',
				'sheet → --shadow-2 (0 10px 30px -8px 60 % + 0 2px 8px 35 %)',
				'drawer → --shadow-2 (stín dolů, ne do strany)',
				'žádný nový token, §2.6 zůstává „exactly two“',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={EXISTING} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · třetí token --shadow-3',
	render: () => (
		<Proposal
			decision="D16"
			variant="B · nový --shadow-3 pro plovoucí plochy telefonu"
			note="§2.6 dostane třetí stín pro velké plovoucí plochy Remote (menu doručení, sheet, drawer). Vypadá skoro jako Current, jen menu doručení je o něco tmavší a drawer vrhá stín dolů místo do strany."
			facts={[
				`--shadow-3 ${SHADOW_3} (dnešní stín sheetu)`,
				'menu doručení, sheet, drawer → --shadow-3',
				'menu řádku → --shadow-1',
				'cena: třetí stín v §2.6 jen pro Remote',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={THIRD} />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · výjimka Remote (vypadá stejně)',
	render: () => (
		<Proposal
			decision="D16"
			variant="C · tři stíny zůstanou jako výjimka Remote"
			note="Vypadá stejně jako Current. Menu řádku dostane --shadow-1 (je to přesná kopie), ostatní tři literály zůstanou a §3.23 je pojmenuje jako stíny Remote, lint je pustí jen ve složce Remote."
			facts={['menu řádku → --shadow-1 (pixely beze změny)', 'tři literály zůstávají', 'pixely beze změny']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={ROW_TOKEN} />
		</Proposal>
	),
}
