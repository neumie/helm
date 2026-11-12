/// <reference types="vite/client" />
// D9 — the extension popup uses VS Code colours (13 literals, no Helm token) (docs/plans/design-system/proposals/D9.md).
// Every variant mounts the REAL popup (extension/src/popup.html + popup.ts) in isolated iframes: connected with the
// favourite-model list, an unreachable daemon with the URL field focused, and an empty field (placeholder + hover).
// The markup is the production file byte for byte except the `popup.js` tag: the production script is loaded from its
// TypeScript source through the Storybook dev server instead. Before it runs, an inline stub stands in for the two
// things a story has no access to: `chrome.storage.sync` (memory) and the daemon (`fetch`: /api/status + /api/config
// with a copy of the real MODEL_CATALOG). A variant only appends a <style> after the production one. Storybook dev
// server only: a static build emits `?url` TypeScript as a plain asset. Kept in this one *.stories.tsx file so the
// Vite client types stay out of the production app typecheck.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { type ReactNode, useCallback, useRef } from 'react'
import popupHtml from '../../../../../extension/src/popup.html?raw'
import popupScriptUrl from '../../../../../extension/src/popup.ts?url'
import { THEME_PRESETS } from '../../../theme-presets'
import { over, ratio } from '../contrast'
import { Proposal } from '../proposal'

// --- Measured values -------------------------------------------------------------------------------------------

const HELM = THEME_PRESETS.helm?.tokens ?? {}
const token = (name: string): string => {
	const value = HELM[name]
	if (value === undefined) throw new Error(`D9: Helm token ${name} is missing`)
	return value
}
/** rgba(255, 255, 255, a) → a; Helm's fills and lines are all white-alpha. */
const whiteAlpha = (name: string): number => {
	const match = /^rgba\(255, 255, 255, ([\d.]+)\)$/.exec(token(name))
	if (!match?.[1]) throw new Error(`D9: ${name} is not white-alpha`)
	return Number(match[1])
}

const PANE = token('--pane')
const FIELD = over('#ffffff', whiteAlpha('--fill-subtle'), PANE)
const HAIRLINE_ON_FIELD = over('#ffffff', whiteAlpha('--hairline'), FIELD)
const HOVER_ON_FIELD = over('#ffffff', whiteAlpha('--hairline-strong'), FIELD)

const CURRENT_FACTS = [
	'13 barevných literálů, 0 tokenů',
	`text #cccccc/#252526 ${ratio('#cccccc', '#252526')}`,
	`popisky + modely #808080 ${ratio('#808080', '#252526')}`,
	`nadpis #007acc ${ratio('#007acc', '#252526')}`,
	`Connected #6a9955 ${ratio('#6a9955', '#252526')}`,
	`Cannot connect #f14c4c ${ratio('#f14c4c', '#252526')}`,
	`okraj pole #3c3c3c/#1e1e1e ${ratio('#3c3c3c', '#1e1e1e')}`,
	`fokus #007acc/#1e1e1e ${ratio('#007acc', '#1e1e1e')}`,
	'nadpis 14px, rádius 3px, mezery 2/10/14px (mimo škálu)',
]

const TOKEN_FACTS_A = [
	`--pane ${PANE}`,
	`text + pole --text-0 ${ratio(token('--text-0'), PANE)}`,
	`popisky + modely --text-1 ${ratio(token('--text-1'), PANE)}`,
	`nadpis --accent ${ratio(token('--accent'), PANE)}`,
	`Connected --success ${ratio(token('--success'), PANE)}`,
	`Cannot connect --danger ${ratio(token('--danger'), PANE)}`,
	`pole --fill-subtle ${FIELD}, okraj --hairline ${ratio(HAIRLINE_ON_FIELD, FIELD)}`,
	`fokus --accent/pole ${ratio(token('--accent'), FIELD)}`,
	`(--text-2 by měl ${ratio(token('--text-2'), PANE)}, proto popisky --text-1)`,
]

const TOKEN_FACTS_B = [
	`--pane ${PANE}`,
	`text + pole --text-0 ${ratio(token('--text-0'), PANE)}`,
	`popisky + skupiny --text-1 ${ratio(token('--text-1'), PANE)}, modely --text-0 ${ratio(token('--text-0'), PANE)}`,
	`nadpis --accent ${ratio(token('--accent'), PANE)}`,
	`Connected --success ${ratio(token('--success'), PANE)}`,
	`Cannot connect --danger ${ratio(token('--danger'), PANE)}`,
	`pole --fill-subtle ${FIELD}, okraj --hairline ${ratio(HAIRLINE_ON_FIELD, FIELD)}, hover --hairline-strong ${ratio(HOVER_ON_FIELD, FIELD)}`,
	`placeholder --text-2 ${ratio(token('--text-2'), FIELD)}, fokus --accent/pole ${ratio(token('--accent'), FIELD)}`,
	'nadpis 13/600, popisky 12/500, skupiny 12/600, modely 12/400',
	'pole 28px (jako dnes), padding 0 10, rádius 6, mezery 4/8/12',
]

// --- Variant CSS (appended after popup.html's <style>) ---------------------------------------------------------

/** The Helm token values the popup needs, as the generated extension token block would carry them (D1 a). */
const TOKEN_BLOCK = `
:root {
	${[
		'--pane',
		'--hairline',
		'--hairline-strong',
		'--fill-subtle',
		'--text-0',
		'--text-1',
		'--text-2',
		'--accent',
		'--accent-fill',
		'--success',
		'--danger',
	]
		.map(name => `${name}: ${token(name)};`)
		.join('\n\t')}
	--font-ui: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
}
/* popup.ts writes the status colour inline; the real change would set a class, this stands in for it. */
#status[style*="rgb(106, 153, 85)"] { color: var(--success) !important; }
#status[style*="rgb(241, 76, 76)"] { color: var(--danger) !important; }
`

/** A: every colour literal becomes its Helm token; sizes, spacing and radius stay as they are. */
const COLOURS_CSS = `${TOKEN_BLOCK}
body { background: var(--pane); color: var(--text-0); font-family: var(--font-ui); color-scheme: dark; }
h1 { color: var(--accent); }
label, .models .group { color: var(--text-1); }
input { background: var(--fill-subtle); border-color: var(--hairline); color: var(--text-0); font-family: inherit; }
input:focus { border-color: var(--accent); }
.status { color: var(--success); }
.models .row input { accent-color: var(--accent-fill); }
`

/** B: A plus the widget/app type, spacing, radius and field scale (§2.2, §2.3, §2.4, §3.7). */
const SCALE_CSS = `${COLOURS_CSS}
body { letter-spacing: -0.01em; -webkit-font-smoothing: antialiased; }
h1 { font-size: 13px; margin: 0 0 12px; }
label { font-size: 12px; font-weight: 500; }
input[type="text"] { height: 28px; padding: 0 10px; border-radius: 6px; font-family: var(--font-ui); }
input[type="text"]::placeholder { color: var(--text-2); }
input[type="text"]:hover,
input[type="text"][data-force-state~="hover"] { border-color: var(--hairline-strong); }
input[type="text"]:focus { border-color: var(--accent); }
.status { margin-top: 8px; min-height: 18px; font-size: 12px; line-height: 18px; }
.models .group { margin: 12px 0 4px; font-size: 12px; font-weight: 600; }
.models .row { gap: 8px; margin: 0; padding: 4px 0; font-weight: 400; color: var(--text-0); }
.models .row input { margin: 0; }
`

// --- Popup frame ---------------------------------------------------------------------------------------------

/** Chrome draws an action popup at its content size, up to 800×600, and scrolls past that. */
const CHROME_POPUP_MAX_HEIGHT = 600

type PopupScenario = 'connected' | 'offline' | 'empty'

const FAVORITES = ['claude-opus-5-5', 'gpt-5.6-sol']

/**
 * Daemon /api/config `modelCatalog`, copied from src/solver/models.ts MODEL_CATALOG (2026-11; Pi trimmed to six).
 * Not imported: that file does not typecheck under the app's `noUncheckedIndexedAccess`.
 */
const MODEL_CATALOG = {
	claude: [
		{ id: 'claude-fable-5', label: 'Fable 5' },
		{ id: 'claude-opus-5-5', label: 'Opus 5.5' },
		{ id: 'claude-opus-5', label: 'Opus 5' },
		{ id: 'claude-opus-4-8', label: 'Opus 4.8' },
		{ id: 'claude-sonnet-5', label: 'Sonnet 5' },
		{ id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
	],
	codex: [
		{ id: 'gpt-6-astra', label: 'Astra' },
		{ id: 'gpt-6-sol', label: 'Sol (GPT-6)' },
		{ id: 'gpt-5.6-sol', label: 'Sol' },
		{ id: 'gpt-5.6-terra', label: 'Terra' },
		{ id: 'gpt-5.6-luna', label: 'Luna' },
		{ id: 'gpt-5.5', label: 'GPT-5.5' },
	],
	pi: [
		{ id: 'anthropic/claude-fable-5', label: 'Anthropic · Fable 5' },
		{ id: 'anthropic/claude-opus-5-5', label: 'Anthropic · Opus 5.5' },
		{ id: 'openai-codex/gpt-6-astra', label: 'OpenAI Codex · Astra' },
		{ id: 'openai-codex/gpt-5.6-sol', label: 'OpenAI Codex · Sol' },
		{ id: 'xai/grok-4.7', label: 'xAI · Grok 4.7' },
		{ id: 'xai/grok-4.6', label: 'xAI · Grok 4.6' },
	],
}

function stubScript(scenario: PopupScenario): string {
	const config = JSON.stringify({ data: { modelCatalog: MODEL_CATALOG } })
	return `
(() => {
	const store = { serverUrl: ${JSON.stringify(scenario === 'empty' ? '' : 'http://localhost:7474')}, favoriteModels: ${JSON.stringify(FAVORITES)} };
	window.chrome = {
		runtime: {},
		storage: {
			sync: {
				get(defaults, callback) {
					const items = {};
					for (const key of Object.keys(defaults)) items[key] = key in store ? store[key] : defaults[key];
					callback(items);
				},
				set(items, callback) { Object.assign(store, items); if (callback) callback(); },
			},
		},
	};
	const offline = ${JSON.stringify(scenario !== 'connected')};
	const config = ${JSON.stringify(config)};
	window.fetch = async input => {
		if (offline) throw new TypeError('Failed to fetch');
		const url = String(input);
		if (url.endsWith('/api/status')) return new Response('{}', { status: 200 });
		if (url.endsWith('/api/config')) return new Response(config, { status: 200 });
		return new Response('', { status: 404 });
	};
})();
`
}

function replaceOnce(source: string, search: string, replacement: string): string {
	const at = source.indexOf(search)
	if (at < 0 || source.indexOf(search, at + 1) >= 0) throw new Error(`D9 popup: expected exactly one ${search}`)
	return source.slice(0, at) + replacement + source.slice(at + search.length)
}

function popupDocument(scenario: PopupScenario, variantCss: string | undefined): string {
	const scriptSrc = new URL(popupScriptUrl, window.location.href).href
	let html = replaceOnce(
		popupHtml,
		'<script src="popup.js"></script>',
		`<script type="module" src="${scriptSrc}"></script>`,
	)
	html = replaceOnce(html, '<head>', `<head>\n<script>${stubScript(scenario)}</script>`)
	if (variantCss !== undefined) html = replaceOnce(html, '</head>', `<style>${variantCss}</style>\n</head>`)
	return html
}

/**
 * One popup window. `connected` types into the URL field the way an edit does (popup.ts saves and tests the daemon,
 * then shows Connected and the model list); `offline` does the same against an unreachable daemon and leaves the field
 * focused, which shows the focus border; `empty` leaves the field empty (placeholder) and marks it
 * `data-force-state="hover"`, which only B's hover rule reads (a pointer cannot hover inside a static screenshot).
 */
function PopupFrame({ scenario, variantCss }: { scenario: PopupScenario; variantCss?: string }) {
	const frame = useRef<HTMLIFrameElement>(null)
	const onLoad = useCallback(() => {
		const iframe = frame.current
		const view = iframe?.contentWindow as (Window & typeof globalThis) | null | undefined
		const doc = iframe?.contentDocument
		if (!iframe || !view || !doc) return
		const fit = () => {
			iframe.style.height = `${Math.min(doc.body.offsetHeight, CHROME_POPUP_MAX_HEIGHT)}px`
		}
		new view.ResizeObserver(fit).observe(doc.body)
		fit()
		const input = doc.getElementById('url')
		if (!(input instanceof view.HTMLInputElement)) throw new Error('D9 popup: #url field missing')
		if (scenario === 'empty') {
			input.dataset.forceState = 'hover'
			return
		}
		input.dispatchEvent(new view.Event('input', { bubbles: true }))
		if (scenario === 'offline') {
			view.focus()
			input.focus()
		}
	}, [scenario])
	return (
		<iframe
			ref={frame}
			title={`Extension popup · ${scenario}`}
			srcDoc={popupDocument(scenario, variantCss)}
			onLoad={onLoad}
			data-popup-scenario={scenario}
			style={{ display: 'block', width: 312, height: 160, border: 0 }}
		/>
	)
}

// --- Board ------------------------------------------------------------------------------------------------------

// Framing only (same in every variant).
const FRAME_CSS = `
/* Neutral Chrome-toolbar grey (dark mode) behind every popup, so no variant blends into the Storybook page. */
.proposal-stage .d9-board { display: flex; gap: 32px; align-items: flex-start; padding: 24px; background: #35363a; }
.proposal-stage .d9-cell { display: grid; gap: 8px; }
.proposal-stage .d9-label { color: var(--text-1); font: 12px / 18px var(--font-ui); }
.proposal-stage .d9-cell iframe { box-shadow: var(--shadow-2); }
`

function Board({ variantCss }: { variantCss?: string }) {
	return (
		<div className="d9-board">
			<Cell label="Připojeno · oblíbené modely">
				<PopupFrame scenario="connected" variantCss={variantCss} />
			</Cell>
			<Cell label="Daemon nedostupný · pole ve fokusu">
				<PopupFrame scenario="offline" variantCss={variantCss} />
			</Cell>
			<Cell label="Prázdné pole · hover">
				<PopupFrame scenario="empty" variantCss={variantCss} />
			</Cell>
		</div>
	)
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="d9-cell">
			<span className="d9-label">{label}</span>
			{children}
		</div>
	)
}

const meta: Meta = {
	title: 'Proposals/D9 Extension popup',
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · VS Code colours',
	render: () => (
		<Proposal
			decision="D9"
			variant="Current · barvy VS Code"
			note="Dnes: popup rozšíření (ikona v liště Chrome) má vlastní paletu z VS Code, žádný Helm token. Šedé popisky a modrý nadpis jsou pod AA. Pozadí kolem oken je šedá lišta Chrome, stejná ve všech variantách."
			facts={CURRENT_FACTS}
			css={FRAME_CSS}
		>
			<Board />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · Helm colours',
	render: () => (
		<Proposal
			decision="D9"
			variant="A · Helm barvy"
			note="Každý barevný literál nahradí jeho Helm token (stejné hodnoty jako --vg-* ve widgetu), plus tmavé checkboxy a pole v písmu stránky. Velikosti, mezery a rádius zůstanou, takže 14px nadpis, 3px rádius a mezery 2/10/14 dál zůstanou mimo škálu."
			facts={TOKEN_FACTS_A}
			css={FRAME_CSS}
		>
			<Board variantCss={COLOURS_CSS} />
		</Proposal>
	),
}

export const B: Story = {
	name: 'B · Helm colours + type and spacing scale (doporučuji)',
	render: () => (
		<Proposal
			decision="D9"
			variant="B · Helm barvy + škála písma a mezer (doporučuji)"
			note="A plus škála jako widget a sidebar: nadpis 13/600, popisky 12/500, pole 28px s rádiem 6, hover okrajem a placeholderem --text-2 (§3.7), mezery 4/8/12, checkboxy bez okraje zarovnané vlevo. Žádná hodnota nezůstane mimo škálu."
			facts={TOKEN_FACTS_B}
			css={FRAME_CSS}
		>
			<Board variantCss={SCALE_CSS} />
		</Proposal>
	),
}
