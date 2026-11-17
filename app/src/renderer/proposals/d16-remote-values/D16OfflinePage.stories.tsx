/// <reference types="vite/client" />
// D16 · Offline page (docs/plans/design-system/proposals/D16.md): the page the Remote PWA's service worker serves when
// the host is unreachable. It cannot load tokens.css, so its type (16px / 24px) and padding (48px 24px) are written in
// the page; the generator already writes its `:root` colours. Each frame is the REAL `OFFLINE` string from
// app/assets/remote/remote-sw.js (read raw, unchanged) at phone width, with the variant CSS appended after its own.
// Kept in this *.stories.tsx file so the Vite client types stay out of the production app typecheck.
import type { Meta, StoryObj } from '@storybook/react-vite'
import workerSource from '../../../../assets/remote/remote-sw.js?raw'
import { Proposal } from '../proposal'
import { BOARD_CSS, Board, type FrameSpec } from './frame'

const OFFLINE = /const OFFLINE = `([\s\S]*?)`/.exec(workerSource)?.[1] ?? '<p>OFFLINE not found in remote-sw.js</p>'

const PHONE: FrameSpec = {
	id: 'offline',
	srcDoc: OFFLINE,
	label: 'Offline stránka · telefon 390',
	width: 390,
	height: 520,
}
const DETAIL: FrameSpec = {
	id: 'offline',
	srcDoc: OFFLINE,
	label: 'Offline stránka · nadpis a text',
	width: 390,
	height: 520,
	zoom: 1.5,
	crop: { selector: 'main', pad: 16 },
}
const FRAMES = [PHONE, DETAIL]

/** Remote's own steps (§9 ruling 101): reading 16, heading 21 at 600; padding on the spacing scale; the UI stack. */
const REMOTE_STEPS = `
:root { --font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; }
body { padding: 32px 24px; font: 16px/1.6 var(--font-ui); letter-spacing: -0.01em; }
h1 { font-size: 21px; font-weight: 600; line-height: 1.3; }
`

/** The app's scale (§2.2): page title 17/600, body 13; edge inset 16. */
const APP_SCALE = `
:root { --font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif; }
body { padding: 32px 16px; font: 13px/1.5 var(--font-ui); letter-spacing: -0.01em; }
h1 { font-size: 17px; font-weight: 600; line-height: 1.3; }
`

const meta: Meta = { title: 'Proposals/D16 Remote values/Offline page', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · 16 / 24, padding 48 24',
	render: () => (
		<Proposal
			decision="D16"
			variant="Current · text 16/1.6, nadpis 24 (váha 700 z prohlížeče), padding 48px 24px"
			note="Stránka se ukáže jen bez spojení s Macem. Barvy už generuje tokens:write, typ a odsazení jsou psané ručně: nadpis 24 px a odsazení 48 px nejsou na stupnici, nadpis má tučnost 700 z prohlížeče a font je vlastní zkrácený seznam."
			facts={['text 16/1.6', 'h1 24 / 700', 'padding 48 24', 'font -apple-system, BlinkMacSystemFont, sans-serif']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · stupně Remote (doporučuji)',
	render: () => (
		<Proposal
			decision="D16"
			variant="A · stupně Remote: text 16, nadpis 21/600, padding 32 24 (doporučuji)"
			note="Stejné hodnoty jako zbytek Remote na telefonu (§9 ruling 101: čtení 16, nadpis 21). Generátor do :root stránky zapíše i --font-ui. Nadpis menší a ne tučný 700, stránka začíná o 16 px výš."
			facts={[
				'text 16/1.6 (beze změny)',
				'h1 24/700 → 21/600',
				'padding 48 → 32 nahoře/dole, 24 po stranách',
				'font → --font-ui',
				'letter-spacing -0.01em',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={REMOTE_STEPS} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · stupnice aplikace',
	render: () => (
		<Proposal
			decision="D16"
			variant="B · stupnice aplikace: text 13, nadpis 17/600, padding 32 16"
			note="Hodnoty ze §2.2 bez výjimky Remote (titulek stránky 17, tělo 13, okraj 16). Na telefonu je to drobné písmo, menší než všechno ostatní v Remote."
			facts={[
				'text 16 → 13/1.5',
				'h1 24/700 → 17/600',
				'padding 48 24 → 32 16',
				'font → --font-ui',
				'letter-spacing -0.01em',
			]}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css={APP_SCALE} />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · výjimka offline stránky (vypadá stejně)',
	render: () => (
		<Proposal
			decision="D16"
			variant="C · hodnoty zůstanou jako výjimka offline stránky"
			note="Vypadá stejně jako Current. §3.23 řekne, že offline stránka je samostatný dokument bez tokens.css a smí mít vlastní typ a odsazení; lint ji přestane hlásit jako drift."
			facts={['pixely beze změny', 'h1 dál 700 (mimo pravidlo vah 400/500/600)']}
			css={BOARD_CSS}
		>
			<Board frames={FRAMES} css="" />
		</Proposal>
	),
}
