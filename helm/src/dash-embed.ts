// Embed re-skin for the vigil dashboard iframe.
//
// The dashboard is a separate app served by the daemon, and its document is
// cross-origin from the file:// renderer — so Helm restyles it by injecting a
// script from the main process (`webFrameMain.executeJavaScript`). Selectors
// target vigil's web/src DOM; its styles are inline React styles, hence the
// attribute selectors + !important. If vigil's markup drifts, rules stop
// matching and the stock dashboard shows — never a broken frame.

// Below this iframe width vigil's fixed-380px list + flexible detail column
// crush each other, so the injected CSS collapses to a single column. Keep in
// sync between the media query and the back-chip visibility check.
const COLLAPSE_MAX_WIDTH = 719

const EMBED_CSS = `
/* Vigil's list surface (#17191c) is off Helm's layering ladder; flattening
   --bg-1 onto the pane token makes the whole iframe read as the pane layer
   (chrome #1a1c1f -> pane #141517 -> terminal well #0f1113). */
:root { --bg-1: #141517; }

/* Mute the dashboard header so Helm's connection dot stays the one bold
   element: the filled "New Item" button becomes ghost/outline... */
header button[style*="var(--accent-fill)"] {
	background: transparent !important;
	border: 1px solid rgba(255, 255, 255, 0.12) !important;
	color: #4c9aff !important;
}
/* ...and the filled-red "N need you" pill becomes a tinted pill. The Needs
   tab badge in the list keeps the loud instance of that count. */
header > div:first-child > span[style*="var(--red)"] {
	background: rgba(242, 88, 91, 0.12) !important;
	color: #f2585b !important;
}

/* Narrow panes: list goes full-bleed; the detail column becomes a slide-over
   that shows only while an item or the create form is open. */
@media (max-width: ${COLLAPSE_MAX_WIDTH}px) {
	#root aside {
		width: auto !important;
		flex: 1 1 auto !important;
		border-right: none !important;
	}
	#root div:has(> main) { position: relative; }
	#root main {
		position: absolute !important;
		inset: 0 !important;
		z-index: 20;
		background: var(--bg-0, #141517) !important;
		padding: 24px 20px !important;
		transform: translateX(102%);
		transition: transform 140ms ease-out;
	}
	/* Item detail and the create form both render an h2/form; the empty,
	   loading, and gone-missing states are <p>-only, so they stay hidden
	   behind the full-bleed list. */
	#root main:has(h2, form) { transform: none; }
}

/* Injected escape hatch for the narrow-mode slide-over (see script below). */
#helm-back {
	position: fixed;
	left: 12px;
	bottom: 12px;
	z-index: 30;
	display: none;
	align-items: center;
	height: 26px;
	padding: 0 12px;
	border: 1px solid rgba(255, 255, 255, 0.12);
	border-radius: 999px;
	background: #1a1c1f;
	color: #d4d6da;
	font: 500 12px/1 var(--font-sans, -apple-system, sans-serif);
	cursor: pointer;
}
#helm-back:hover { background: #1e2024; }
#helm-back:focus-visible { outline: 2px solid #4c9aff; outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
	#root main { transition: none !important; }
}
`

/**
 * Source injected into the dashboard frame on every load. Idempotent per
 * document; must reference only what exists inside the frame.
 */
export function dashEmbedScript(): string {
	return `(() => {
	if (window.__helmEmbed) return;
	window.__helmEmbed = true;
	const style = document.createElement('style');
	style.id = 'helm-embed';
	style.textContent = ${JSON.stringify(EMBED_CSS)};
	document.head.appendChild(style);

	// Narrow-mode escape hatch: the slide-over covers the list and vigil has no
	// close control (its list is always visible at full width). Selection is
	// hash-routed, so clearing the hash deselects and the overlay slides away.
	// Appended to <body>, outside the React-managed #root subtree.
	const back = document.createElement('button');
	back.id = 'helm-back';
	back.type = 'button';
	back.textContent = '\\u2039 List';
	back.addEventListener('click', () => { location.hash = ''; });
	document.body.appendChild(back);
	const narrow = window.matchMedia('(max-width: ${COLLAPSE_MAX_WIDTH}px)');
	const overlayOpen = () => narrow.matches && /^#item\\//.test(location.hash);
	const reflect = () => { back.style.display = overlayOpen() ? 'inline-flex' : 'none'; };
	narrow.addEventListener('change', reflect);
	window.addEventListener('hashchange', reflect);
	window.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && overlayOpen()) location.hash = '';
	});
	reflect();
})()`
}
