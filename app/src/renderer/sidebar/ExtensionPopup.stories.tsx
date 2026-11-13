/// <reference types="vite/client" />
// The extension's toolbar popup (docs/design-system.md §3.28, §9 ruling 103): the REAL extension/src/popup.html +
// popup.ts in isolated iframes, byte for byte except the `popup.js` tag, which loads the production script from its
// TypeScript source through the Storybook dev server. Before it runs, an inline stub stands in for the two things a
// story has no access to: `chrome.storage.sync` (memory) and the daemon (`fetch`: /api/status + /api/config with a
// copy of the real MODEL_CATALOG). Three windows: connected with the favourite-model list, an unreachable daemon with
// the URL field focused, and an empty field (placeholder + forced hover). Storybook dev server only: a static build
// emits `?url` TypeScript as a plain asset. Kept in this one *.stories.tsx file so the Vite client types stay out of
// the production app typecheck.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { type ReactNode, useCallback, useRef } from 'react'
import popupHtml from '../../../../extension/src/popup.html?raw'
import popupScriptUrl from '../../../../extension/src/popup.ts?url'

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
	if (at < 0 || source.indexOf(search, at + 1) >= 0) throw new Error(`Extension popup: expected exactly one ${search}`)
	return source.slice(0, at) + replacement + source.slice(at + search.length)
}

function popupDocument(scenario: PopupScenario): string {
	const scriptSrc = new URL(popupScriptUrl, window.location.href).href
	const html = replaceOnce(
		popupHtml,
		'<script src="popup.js"></script>',
		`<script type="module" src="${scriptSrc}"></script>`,
	)
	return replaceOnce(html, '<head>', `<head>\n<script>${stubScript(scenario)}</script>`)
}

/**
 * One popup window. `connected` types into the URL field the way an edit does (popup.ts saves and tests the daemon,
 * then shows Connected and the model list); `offline` does the same against an unreachable daemon and leaves the field
 * focused (focus border, then Cannot connect); `empty` leaves the field empty (placeholder) and marks it
 * `data-force-state="hover"` (a pointer cannot hover inside a static screenshot).
 */
function PopupFrame({ scenario }: { scenario: PopupScenario }) {
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
		if (!(input instanceof view.HTMLInputElement)) throw new Error('Extension popup: #url field missing')
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
			srcDoc={popupDocument(scenario)}
			onLoad={onLoad}
			data-popup-scenario={scenario}
			style={{ display: 'block', width: 312, height: 160, border: 0, boxShadow: 'var(--shadow-2)' }}
		/>
	)
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div style={{ display: 'grid', gap: 8 }}>
			<span style={{ color: 'var(--text-1)', font: '12px / 18px var(--font-ui)' }}>{label}</span>
			{children}
		</div>
	)
}

const meta: Meta = { title: 'Views/Extension popup', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Popup: Story = {
	render: () => (
		<div style={{ display: 'flex', gap: 32, alignItems: 'flex-start', padding: 24, background: 'var(--chrome)' }}>
			<Cell label="Connected · favourite models">
				<PopupFrame scenario="connected" />
			</Cell>
			<Cell label="Daemon unreachable · field focused">
				<PopupFrame scenario="offline" />
			</Cell>
			<Cell label="Empty field · hover">
				<PopupFrame scenario="empty" />
			</Cell>
		</div>
	),
}
