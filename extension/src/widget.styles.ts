/**
 * Styles for the in-page Helm widget, injected into its (closed) shadow root by
 * `content.tsx`. Design tokens live on `:host` — same values as the app's
 * (`app/src/theme-presets.ts` HELM_TOKENS), `--vg-` prefixed for shadow-root
 * isolation (docs/design-system.md §2). Everything is class-scoped, so the
 * shadow root keeps the page's styles out and ours in.
 *
 * The widget itself is a DETACHED surface floating over a foreign page — the
 * pill and card keep their hairline + shadow-2 chrome; content inside the card
 * stays flat (§1 principle 2).
 */
export const WIDGET_STYLES = `
	:host {
		/* Background ladder (§2.1) */
		--vg-chrome: #1a1c1f;        /* elevated: pill, menus */
		--vg-pane: #141517;          /* card base */

		/* Lines & fills */
		--vg-hairline: rgba(255, 255, 255, 0.07);
		--vg-hairline-strong: rgba(255, 255, 255, 0.16);
		--vg-fill-subtle: rgba(255, 255, 255, 0.05);
		--vg-fill-raised: rgba(255, 255, 255, 0.09);
		--vg-fill-strong: rgba(255, 255, 255, 0.13);
		--vg-thumb: rgba(255, 255, 255, 0.14);

		/* Text ladder */
		--vg-text-0: #ececee;
		--vg-text-1: #9a9ea6;
		--vg-text-2: #62666e;

		/* Accent & semantic tones; soft fills derived at exactly 15% (§2.1) */
		--vg-accent: #4c9aff;
		--vg-accent-fill: #3b82f6;
		--vg-accent-fill-hover: #5a9dff;
		--vg-on-accent: #ffffff;
		--vg-green: #4ec98a;
		--vg-amber: #e0b341;
		--vg-red: #f2585b;
		--vg-blue: #4c9aff;
		--vg-gray: #8a8f98;
		--vg-accent-soft: color-mix(in srgb, var(--vg-accent) 15%, transparent);
		--vg-green-soft: color-mix(in srgb, var(--vg-green) 15%, transparent);
		--vg-amber-soft: color-mix(in srgb, var(--vg-amber) 15%, transparent);
		--vg-red-soft: color-mix(in srgb, var(--vg-red) 15%, transparent);
		--vg-blue-soft: color-mix(in srgb, var(--vg-blue) 15%, transparent);
		--vg-gray-soft: color-mix(in srgb, var(--vg-gray) 15%, transparent);

		/* Radii ladder 8/6/4 (§2.4); elevation (§2.6) */
		--vg-radius-lg: 8px;
		--vg-radius-md: 6px;
		--vg-radius-sm: 4px;
		--vg-shadow-1: 0 8px 24px rgba(0, 0, 0, 0.35);
		--vg-shadow-2: 0 10px 30px -8px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.35);

		--vg-font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
		--vg-mono: 'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	* { box-sizing: border-box; margin: 0; padding: 0; }

	@media (prefers-reduced-motion: reduce) {
		*, *::before, *::after {
			animation-duration: 0.01ms !important;
			animation-iteration-count: 1 !important;
			transition-duration: 0.01ms !important;
		}
	}

	/* ---------------- pill (collapsed) ---------------- */
	.vg-pill {
		position: fixed;
		bottom: 20px;
		left: 20px;
		z-index: 2147483647;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 12px;
		background: var(--vg-chrome);
		border: 1px solid var(--vg-hairline);
		border-radius: 999px;
		box-shadow: var(--vg-shadow-2);
		cursor: pointer;
		font-family: var(--vg-font);
		letter-spacing: -0.01em;
		-webkit-font-smoothing: antialiased;
		transition: background-color 140ms ease-out, border-color 140ms ease-out, transform 140ms ease-out;
	}
	/* The pill paints over a foreign page, so hover fills mix into the opaque
	   chrome instead of layering a translucent fill over the page. */
	.vg-pill:hover {
		background: color-mix(in srgb, var(--vg-text-0) 7%, var(--vg-chrome));
		transform: translateY(-1px);
	}
	.vg-pill--cta { border-color: var(--vg-accent-soft); }
	.vg-pill--cta:hover {
		border-color: var(--vg-accent);
		background: color-mix(in srgb, var(--vg-accent) 15%, var(--vg-chrome));
	}
	.vg-pill__brand { color: var(--vg-accent); font-size: 12px; font-weight: 600; }
	.vg-pill__label { color: var(--vg-text-0); font-size: 12px; font-weight: 500; }
	.vg-pill__label--faint { color: var(--vg-text-2); }
	.vg-pill__label--accent { color: var(--vg-accent); font-weight: 600; }
	.vg-pill__label--danger { color: var(--vg-red); }

	/* ---------------- status dot (§3.5 — 8px, no halo) ---------------- */
	.vg-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.vg-dot--pulse { animation: vg-pulse 1.6s ease-in-out infinite; }
	@keyframes vg-pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.35; }
	}

	/* ---------------- card (expanded) ---------------- */
	.vg-card {
		position: fixed;
		bottom: 20px;
		left: 20px;
		z-index: 2147483647;
		width: 332px;
		background: var(--vg-pane);
		border: 1px solid var(--vg-hairline);
		border-radius: var(--vg-radius-lg);
		box-shadow: var(--vg-shadow-2);
		font-family: var(--vg-font);
		letter-spacing: -0.01em;
		-webkit-font-smoothing: antialiased;
		overflow: hidden;
		animation: vg-rise 150ms ease-out;
	}
	@keyframes vg-rise {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: translateY(0); }
	}
	/* Header sits flat on the card (§3.10): pane background, one hairline rule. */
	.vg-card__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--vg-hairline);
	}
	.vg-card__id { display: flex; align-items: center; gap: 8px; min-width: 0; }
	.vg-card__status { color: var(--vg-text-0); font-size: 13px; font-weight: 600; }
	.vg-card__brand { color: var(--vg-accent); font-size: 13px; font-weight: 600; }
	.vg-card__hactions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

	.vg-link-open {
		color: var(--vg-accent);
		text-decoration: none;
		font-size: 11px;
		font-weight: 500;
		opacity: 0.85;
	}
	.vg-link-open:hover { opacity: 1; }
	.vg-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		color: var(--vg-text-2);
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		border: none;
		border-radius: var(--vg-radius-md);
		background: none;
		padding: 0;
		font-family: var(--vg-font);
		transition: background-color 140ms ease-out, color 140ms ease-out;
	}
	.vg-close:hover { background: var(--vg-fill-subtle); color: var(--vg-text-0); }

	/* Chips (§3.4): sentence case, text-only — the tone carries the signal. */
	.vg-chip {
		display: inline-flex;
		align-items: center;
		font-size: 11px;
		font-weight: 500;
		padding: 2px 8px;
		border-radius: 999px;
		line-height: 1.4;
		white-space: nowrap;
	}

	.vg-card__body { padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
	.vg-text { font-size: 13px; line-height: 1.5; color: var(--vg-text-1); }
	.vg-text--primary { color: var(--vg-text-0); }
	.vg-text--oneline {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.vg-summary { font-size: 13px; line-height: 1.5; color: var(--vg-text-1); overflow-wrap: anywhere; }

	/* Run notices can be a long root-cause paragraph — clamp to a few lines and
	   expand on click (the block is the toggle). */
	.vg-notice {
		cursor: pointer;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 4;
		overflow: hidden;
	}
	.vg-notice.is-expanded {
		display: block;
		-webkit-line-clamp: unset;
		overflow: visible;
	}
	/* Fact row: Label style (12/500) label, accent only when the value leaves
	   the page (§3.15). */
	.vg-link-line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		font-size: 12px;
		font-weight: 500;
		color: var(--vg-text-2);
	}
	.vg-link-line a {
		color: var(--vg-accent);
		text-decoration: none;
		font-weight: 500;
		max-width: 210px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.vg-link-line__value {
		color: var(--vg-text-1);
		font-family: var(--vg-mono);
		font-size: 11px;
		font-weight: 400;
		max-width: 210px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.vg-agent {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: 28px;
	}
	.vg-agent__label {
		color: var(--vg-text-2);
		font-size: 12px;
		font-weight: 500;
	}
	/* Segmented (§3.2): the ring is an inset shadow, not a border, so
	   2px padding + 24px option + 2px padding = 28 exactly. */
	.vg-agent__seg {
		display: grid;
		grid-template-columns: repeat(2, 72px);
		height: 28px;
		padding: 2px;
		background: var(--vg-fill-subtle);
		border-radius: var(--vg-radius-md);
		box-shadow: inset 0 0 0 1px var(--vg-hairline);
	}
	/* Custom model dropdown — native <select> popups don't open inside the
	   closed shadow root on macOS Chromium, so the panel is ours. Trigger
	   mirrors the select spec (§3.7); panel follows the menu spec (§3.8:
	   chrome bg, hairline, radius-lg, shadow-1, 28px rows). */
	.vg-model { position: relative; display: flex; justify-content: flex-end; min-width: 0; }
	.vg-model__trigger {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 28px;
		max-width: 210px;
		padding: 0 10px;
		background: var(--vg-fill-subtle);
		border: 1px solid var(--vg-hairline);
		border-radius: var(--vg-radius-md);
		color: var(--vg-text-0);
		font-family: var(--vg-font);
		font-size: 12px;
		font-weight: 650;
		cursor: pointer;
		outline: none;
		transition: border-color 140ms ease-out;
	}
	.vg-model__trigger:hover { border-color: var(--vg-hairline-strong); }
	.vg-model__trigger:focus-visible { border-color: var(--vg-accent); }
	.vg-model__trigger.is-open { border-color: var(--vg-accent); }
	.vg-model__trigger:disabled { cursor: default; opacity: 0.5; }
	.vg-model__value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.vg-model__chevron {
		flex-shrink: 0;
		display: inline-flex;
		color: var(--vg-text-2);
		transition: transform 120ms ease-out;
	}
	.vg-model__trigger.is-open .vg-model__chevron { transform: rotate(180deg); }
	.vg-model__menu {
		position: absolute;
		right: 0;
		z-index: 40;
		min-width: 100%;
		width: max-content;
		max-width: 240px;
		padding: 4px;
		background: var(--vg-chrome);
		border: 1px solid var(--vg-hairline);
		border-radius: var(--vg-radius-lg);
		box-shadow: var(--vg-shadow-1);
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.vg-model__menu--down { top: calc(100% + 4px); animation: vg-menu-down 120ms ease-out; }
	.vg-model__menu--up { bottom: calc(100% + 4px); animation: vg-menu-up 120ms ease-out; }
	@keyframes vg-menu-down {
		from { opacity: 0; transform: translateY(4px); }
		to { opacity: 1; transform: translateY(0); }
	}
	@keyframes vg-menu-up {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.vg-model__menu::-webkit-scrollbar { width: 8px; }
	.vg-model__menu::-webkit-scrollbar-thumb {
		background: var(--vg-thumb);
		border-radius: 999px;
		border: 2px solid transparent;
		background-clip: content-box;
	}
	.vg-model__option {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		height: 28px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--vg-radius-sm);
		background: transparent;
		color: var(--vg-text-0);
		font-family: var(--vg-font);
		font-size: 13px;
		font-weight: 400;
		cursor: pointer;
		text-align: left;
		white-space: nowrap;
	}
	.vg-model__option.is-active { background: var(--vg-fill-subtle); }
	.vg-model__option.is-selected { color: var(--vg-accent); font-weight: 500; }
	.vg-model__option-label { overflow: hidden; text-overflow: ellipsis; }
	.vg-model__check { flex-shrink: 0; display: inline-flex; color: var(--vg-accent); }
	.vg-agent__option {
		height: 24px;
		border: 0;
		border-radius: var(--vg-radius-sm);
		background: transparent;
		color: var(--vg-text-1);
		font-family: var(--vg-font);
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 140ms ease-out, color 140ms ease-out;
	}
	/* The one sanctioned accent-filled segment: a true either/or commit (§3.2). */
	.vg-agent__option.is-active {
		background: var(--vg-accent-fill);
		color: var(--vg-on-accent);
	}
	.vg-agent__option:disabled {
		cursor: default;
		opacity: 0.45;
	}

	.vg-pr {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		align-self: flex-start;
		height: 28px;
		padding: 0 12px;
		background: var(--vg-accent-soft);
		border-radius: var(--vg-radius-md);
		color: var(--vg-accent);
		text-decoration: none;
		font-size: 12px;
		font-weight: 500;
		transition: background-color 140ms ease-out;
	}
	.vg-pr:hover { background: color-mix(in srgb, var(--vg-accent) 22%, transparent); }

	.vg-error {
		font-size: 12px;
		line-height: 1.5;
		color: var(--vg-red);
		background: var(--vg-red-soft);
		border-radius: var(--vg-radius-md);
		padding: 10px 12px;
		word-break: break-word;
	}
	.vg-error--dismissible {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}
	.vg-error--dismissible > span { flex: 1; }
	.vg-error__dismiss {
		flex-shrink: 0;
		background: transparent;
		border: 0;
		color: inherit;
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		opacity: 0.6;
		padding: 0;
	}
	.vg-error__dismiss:hover { opacity: 1; }


	.vg-card__actions { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--vg-hairline); }

	/* Buttons (§3.1): no borders in any tone — weight comes from the fill. */
	.vg-btn {
		height: 28px;
		padding: 0 12px;
		border: none;
		border-radius: var(--vg-radius-md);
		font-family: var(--vg-font);
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		transition: background-color 140ms ease-out, color 140ms ease-out;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.vg-btn--primary { background: var(--vg-accent-fill); color: var(--vg-on-accent); }
	.vg-btn--primary:hover:not(:disabled) { background: var(--vg-accent-fill-hover); }
	.vg-btn--muted { background: var(--vg-fill-raised); color: var(--vg-text-0); }
	.vg-btn--muted:hover:not(:disabled) { background: var(--vg-fill-strong); }
	.vg-btn--danger { background: var(--vg-red-soft); color: var(--vg-red); }
	.vg-btn--danger:hover:not(:disabled) { background: color-mix(in srgb, var(--vg-red) 22%, transparent); }
	.vg-btn:disabled { opacity: 0.45; cursor: default; }
	.vg-spacer { flex: 1; }

	/* Focus is visible everywhere (§4): accent ring on :focus-visible only;
	   fields (the model trigger) signal focus via their accent border instead. */
	.vg-btn:focus-visible,
	.vg-pill:focus-visible,
	.vg-close:focus-visible,
	.vg-agent__option:focus-visible,
	.vg-model__option:focus-visible,
	.vg-error__dismiss:focus-visible,
	.vg-link-open:focus-visible,
	.vg-pr:focus-visible {
		outline: 2px solid var(--vg-accent);
		outline-offset: 2px;
	}

	/* Dashboard tone helpers. */
	.c-gray { color: var(--vg-gray); }
	.c-blue { color: var(--vg-blue); }
	.c-green { color: var(--vg-green); }
	.c-amber { color: var(--vg-amber); }
	.c-red { color: var(--vg-red); }
	.bg-gray { background: var(--vg-gray); }
	.bg-blue { background: var(--vg-blue); }
	.bg-green { background: var(--vg-green); }
	.bg-amber { background: var(--vg-amber); }
	.bg-red { background: var(--vg-red); }
	.chip-gray { color: var(--vg-gray); background: var(--vg-gray-soft); }
	.chip-blue { color: var(--vg-blue); background: var(--vg-blue-soft); }
	.chip-green { color: var(--vg-green); background: var(--vg-green-soft); }
	.chip-amber { color: var(--vg-amber); background: var(--vg-amber-soft); }
	.chip-red { color: var(--vg-red); background: var(--vg-red-soft); }
`
