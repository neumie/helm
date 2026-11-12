// D8 · Remote radii (research/helm-spec.md C11, research/helm-tokens.md §3.5): remote.css uses 10/12/18/24/28,
// §2.4 allows only 4/6/8/999 and bans 10/12/14. Frames are the real Remote stories at phone width.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board } from './frame'
import {
	REMOTE_DELIVERY_MENU,
	REMOTE_DELIVERY_MENU_ITEM,
	REMOTE_INFO,
	REMOTE_MORE_SHEET,
	REMOTE_NAVIGATION,
	REMOTE_PAIRING,
	REMOTE_READING,
} from './remote-frames'

const FRAMES = [
	REMOTE_READING,
	REMOTE_DELIVERY_MENU,
	REMOTE_MORE_SHEET,
	REMOTE_NAVIGATION,
	REMOTE_INFO,
	REMOTE_DELIVERY_MENU_ITEM,
	REMOTE_PAIRING,
]

const NEAREST = `
.remote-login input,
.remote-message[data-role="user"] .remote-user-text,
.remote-compose-surface,
.remote-composer-actions .menu-panel,
.remote-composer-actions .menu-item,
.remote-information-body dl,
.remote-navigation-item,
.remote-sheet { border-radius: 8px; }
`

const PHONE_STEPS = `
.remote-login input { border-radius: 12px; }
.remote-sheet { border-radius: 18px; }
`

const meta: Meta = { title: 'Proposals/D8 Scale/Remote radii', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · 10 / 12 / 18 / 24 / 28',
	render: () => (
		<Proposal
			decision="D8"
			variant="Current · 10 / 12 / 18 / 24 / 28"
			note="Menu (18) a jeho položky (12) jsou soustředné: 18 − 6 px odsazení = 12 (zvětšený rám, položka v hover). §2.4 přitom 10 a 12 zakazuje."
			facts={[
				'pole kódu 10',
				'položka menu, navigace, Info 12',
				'bublina, menu 18',
				'sheet 24',
				'kapsle 28 = ½ výšky 56',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · zaokrouhlit na 8',
	render: () => (
		<Proposal
			decision="D8"
			variant="A · zaokrouhlit na nejbližší hodnotu (8)"
			note="Všech osm míst dostane 8 (nejbližší hodnota stupnice 4/6/8/999). Remote pak vypadá jako desktop: bublina a kapsle přestanou být oblé, sheet je hranatý."
			facts={['vše 8', 'kapsle 56 px: 8 = 0.14 výšky (dnes 0.5)', 'bublina 41 px: 8 (dnes 18)']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={NEAREST} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · telefonní stupně 12 / 18 + kapsle (doporučuji)',
	render: () => (
		<Proposal
			decision="D8"
			variant="B · telefonní stupně 12 / 18 + kapsle (doporučuji)"
			note="Stupnice dostane pravidlo pro Remote (dotykové plochy): 12 pro řádky a pole, 18 pro bublinu a plovoucí plochy, kapsle = ½ klidové výšky. Mění se jen dvě místa: pole kódu 10 → 12, sheet 24 → 18."
			facts={[
				'nové kroky: --radius-touch 12, --radius-float 18, kapsle 28',
				'pole kódu 10 → 12',
				'sheet 24 → 18',
				'ostatní beze změny',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={PHONE_STEPS} />
		</Proposal>
	),
}
