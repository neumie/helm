// D8 · Remote type (research/helm-spec.md C5, research/helm-tokens.md §3.2): remote.css sets 14/16/20 px, outside
// the §2.2 scale 11/12/13/17 and the Document Review extension 15/21/28. Frames are the real Remote at phone width.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board } from './frame'
import {
	REMOTE_DELIVERY_MENU,
	REMOTE_MORE_SHEET,
	REMOTE_NAVIGATION,
	REMOTE_READING,
	REMOTE_SESSIONS,
} from './remote-frames'

const FRAMES = [REMOTE_READING, REMOTE_SESSIONS, REMOTE_DELIVERY_MENU, REMOTE_MORE_SHEET, REMOTE_NAVIGATION]

const px = (size: number) => `calc(${size}px * var(--ui-scale, 1))`

/** 16 → 17, 14 → 13, 20 → 21 (nearest on 11/12/13/15/17/21/28; 16 is a tie, 17 is the §2.2 step). */
const NEAREST = `
.remote-session-title,
.remote-message,
.remote-navigation-item,
.remote-sheet-title,
.remote-sheet-option { font-size: ${px(17)}; }
.remote-composer-actions .menu-item,
.remote-navigation-conversation-title { font-size: ${px(13)}; }
.remote-markdown h3 { font-size: ${px(21)}; }
`

/** 16 becomes a ruled phone step; 14 and 20 snap (1 px each). */
const PHONE_STEP = `
.remote-composer-actions .menu-item,
.remote-navigation-conversation-title { font-size: ${px(13)}; }
.remote-markdown h3 { font-size: ${px(21)}; }
`

const meta: Meta = { title: 'Proposals/D8 Scale/Remote type', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · 14 / 16 / 20',
	render: () => (
		<Proposal
			decision="D8"
			variant="Current · 14 / 16 / 20"
			note="Remote se čte na telefonu; nic z těchto velikostí není na stupnici §2.2."
			facts={[
				'16 px ×5 (zpráva, název konverzace, navigace, titulek a volby sheetu)',
				'14 px ×2 (menu doručení, název v navigaci)',
				'20 px ×1 (h3)',
				'pole kódu 16 = ochrana proti zoomu iOS, zůstává ve všech variantách',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · zaokrouhlit 16→17, 14→13, 20→21',
	render: () => (
		<Proposal
			decision="D8"
			variant="A · zaokrouhlit na stupnici"
			note="16 → 17 (krok §2.2), 14 → 13, 20 → 21 (krok Document Review). Žádný nový krok. Text zpráv je o 1 px větší a stejně velký jako všechny nadpisy Remote (17): nadpis se od textu liší už jen tučností."
			facts={['16 → 17', '14 → 13', '20 → 21', 'nadpisy Remote h1/h2/h6 17 = text']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={NEAREST} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · nový krok 16 pro telefon (doporučuji)',
	render: () => (
		<Proposal
			decision="D8"
			variant="B · nový krok 16 pro telefon (doporučuji)"
			note="Stupnice dostane krok 16 = text na telefonu (Remote), jako Document Review má 15/21/28. Zprávy, navigace a sheet se nemění; 14 → 13 a 20 → 21 jsou o 1 px."
			facts={['nový krok: 16 (Remote, telefon)', '14 → 13', '20 → 21', '16 beze změny']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={PHONE_STEP} />
		</Proposal>
	),
}
