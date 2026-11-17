import type { Meta, StoryObj } from '@storybook/react-vite'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, Curves, type FrameSpec, ReplayControls, click } from './frame'
import { CURRENT, LARGE, METRIC, SNAP, type Surface, type Timing, msToShare, remoteTimingCss } from './timing'

const meta = {
	title: 'Proposals/D19 Z-index and motion/Remote entrances',
	parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

/** The production Reading story opens one conversation; every frame opens its surface through real controls. */
const READING = 'views-helm-remote--reading'
const PHONE = { width: 390, height: 760, zoom: 0.5 } as const

const FRAMES: readonly FrameSpec[] = [
	{
		id: READING,
		label: 'Šuplík navigace + ztmavení (telefon)',
		...PHONE,
		setup: async ({ doc }) => click(doc, '.remote-navigation-trigger'),
		animated: ['.remote-navigation-dismiss', '.remote-navigation-menu'],
	},
	{
		id: READING,
		label: 'List More + ztmavení (telefon)',
		...PHONE,
		setup: async ({ doc }) => click(doc, 'button[aria-label="More"]'),
		animated: ['.remote-sheet-dismiss', '.remote-sheet'],
	},
	{
		id: READING,
		label: 'Info přes chat (telefon; Usage stejně)',
		...PHONE,
		setup: async ({ doc }) => {
			await click(doc, 'button[aria-label="More"]')
			await click(doc, '.remote-sheet-option', 'Info')
		},
		animated: ['.remote-information-view'],
	},
	{
		id: READING,
		label: 'Menu doručení u tlačítka (výřez)',
		width: 390,
		height: 760,
		setup: async ({ doc }) => click(doc, '.remote-mode-trigger'),
		crop: { selector: '.remote-composer-actions .menu-panel', pad: 24 },
		animated: ['.remote-composer-actions .menu-panel'],
	},
	{
		id: READING,
		label: 'Info vpravo (okno 1280px, výřez panelu)',
		width: 1280,
		height: 760,
		zoom: 0.5,
		crop: { selector: '.remote-information-rail', pad: 0 },
		setup: async ({ doc }) => {
			await click(doc, 'button[aria-label="More"]')
			await click(doc, '.remote-sheet-option', 'Info')
		},
		animated: ['.remote-information-rail'],
	},
]

const CHART_SURFACES: Surface[] = ['drawer', 'sheet', 'scrim', 'view', 'popover']

function Rows({ variant }: { variant: Timing | null }) {
	return (
		<>
			<ReplayControls />
			<section className="d19-row">
				<div className="d19-row-title">{variant === null ? 'Dnes' : 'Dnes (pro srovnání)'}</div>
				<Board frames={FRAMES} css={remoteTimingCss(CURRENT)} />
			</section>
			{variant === null ? null : (
				<section className="d19-row">
					<div className="d19-row-title">Varianta</div>
					<Board frames={FRAMES} css={remoteTimingCss(variant)} />
				</section>
			)}
			<Curves current={CURRENT} variant={variant} surfaces={CHART_SURFACES} />
		</>
	)
}

const share = (timing: Timing, surface: Surface) => `${msToShare(timing[surface], 0.9)}ms`

export const Current: Story = {
	name: 'Current',
	render: () => (
		<Proposal
			decision="D19"
			variant="Current · Remote má vlastní časy mimo tokeny"
			note="Šuplík a list přijíždějí 180ms po vlastní křivce, která rychle vyrazí a dlouho dobrzďuje. Pohledy Info/Usage, panel vpravo a ztmavení 160ms ease-out. Malé menu u tlačítka 140ms na --motion-state (role: změna stavu, ne příchod)."
			facts={[
				`šuplík, list: 180ms cubic-bezier(0.22, 1, 0.36, 1) · 90 % cesty za ${share(CURRENT, 'drawer')}`,
				`Info, Usage, panel, ztmavení: 160ms ease-out · 90 % za ${share(CURRENT, 'view')}`,
				`menu: ${CURRENT.popover.label}`,
				'§2.5: příchod = --motion-enter 150ms ease-out',
			]}
			css={BOARD_CSS}
		>
			<Rows variant={null} />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · vše na --motion-enter 150ms ease-out',
	render: () => (
		<Proposal
			decision="D19"
			variant="A · každý příchod na --motion-enter 150ms + --ease-out"
			note={`Jeden čas pro všechno, žádný nový token. Šuplík a list se rozjedou znatelně pomaleji: 90 % cesty urazí za ${share(SNAP, 'drawer')} místo ${share(CURRENT, 'drawer')}, i když celé doběhnou o 30ms dřív. Působí línější, méně jako iOS. Pohledy a ztmavení o 10ms rychlejší, menu o 10ms pomalejší (to nikdo nepozná).`}
			facts={[
				`šuplík, list: 180 → 150ms, křivka → ease-out · 90 % cesty ${share(CURRENT, 'drawer')} → ${share(SNAP, 'drawer')}`,
				`Info, Usage, panel, ztmavení: 160 → 150ms · 90 % ${share(CURRENT, 'view')} → ${share(SNAP, 'view')}`,
				'menu: 140 → 150ms',
				'tokeny: beze změny; lint: 14 položek D19 pryč',
			]}
			css={BOARD_CSS}
		>
			<Rows variant={SNAP} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · šuplík a list na nový token, zbytek 150ms (doporučuji)',
	render: () => (
		<Proposal
			decision="D19"
			variant="B · velké plochy na nové --motion-enter-large 180ms + --ease-enter-large, zbytek na --motion-enter (doporučuji)"
			note="Šuplík a list zůstanou přesně jako dnes, jen jejich čas a křivka dostanou jméno v §2.5 (příchod velké plochy přes celou obrazovku). Pohledy, ztmavení a menu přejdou na 150ms: rozdíl 10ms oko nerozliší."
			facts={[
				`šuplík, list: beze změny · 90 % cesty za ${share(LARGE, 'drawer')}`,
				`Info, Usage, panel, ztmavení: 160 → 150ms · 90 % ${share(CURRENT, 'view')} → ${share(LARGE, 'view')}`,
				'menu: 140 → 150ms (role příchod místo změny stavu)',
				'§2.5 +2 tokeny: --motion-enter-large 180ms, --ease-enter-large cubic-bezier(0.22, 1, 0.36, 1)',
			]}
			css={BOARD_CSS}
		>
			<Rows variant={LARGE} />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · hodnoty zůstanou, zapíšou se do §3 Remote',
	render: () => (
		<Proposal
			decision="D19"
			variant="C · dnešní časy jako metriky Remote v jeho §3 specu"
			note="Vypadá stejně jako dnes, jen pravidlo: §3 Remote už píše 180 / 160 / 140ms, doplní se křivka a lint je pustí jako schválenou výjimku (jako drag a swipe). Remote tak zůstane jediný povrch s vlastními časy příchodu."
			facts={[
				'pixely a časy: beze změny',
				'§2.5 schválené výjimky + Remote 160/180ms a křivka',
				'menu zůstane na --motion-state, nebo dostane 140ms jako metriku',
			]}
			css={BOARD_CSS}
		>
			<Rows variant={METRIC} />
		</Proposal>
	),
}
