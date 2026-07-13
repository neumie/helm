/**
 * Styles for the in-page Helm widget, injected into its (closed) shadow root by
 * `content.tsx`. Design tokens live on `:host`; everything is class-scoped, so the
 * shadow root keeps the page's styles out and ours in.
 */
export const WIDGET_STYLES = `
	:host {
		--vg-bg: #17181a;            /* card base */
		--vg-surface: #1e2024;       /* header / elevated */
		--vg-overlay: #292c31;       /* hover */
		--vg-border: rgba(255, 255, 255, 0.09);
		--vg-border-strong: rgba(255, 255, 255, 0.16);

		--vg-text: #ededee;
		--vg-text-dim: #a6a9af;
		--vg-text-faint: #6b6f77;

		--vg-accent: #4c9aff;
		--vg-accent-fill: #3b82f6;
		--vg-accent-soft: rgba(76, 154, 255, 0.15);

		--vg-green: #4ec98a;  --vg-green-soft: rgba(78, 201, 138, 0.16);
		--vg-amber: #e0b341;  --vg-amber-soft: rgba(224, 179, 65, 0.16);
		--vg-red: #f2585b;    --vg-red-soft: rgba(242, 88, 91, 0.15);
		--vg-blue: #4c9aff;   --vg-blue-soft: rgba(76, 154, 255, 0.16);
		--vg-gray: #8a8f98;   --vg-gray-soft: rgba(138, 143, 152, 0.15);

		--vg-radius-card: 14px;
		--vg-radius-ctl: 8px;
		--vg-shadow: 0 10px 30px -8px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.35);
		--vg-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		--vg-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
	}

	* { box-sizing: border-box; margin: 0; padding: 0; }

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
		padding: 0 13px 0 11px;
		background: var(--vg-surface);
		border: 1px solid var(--vg-border);
		border-radius: 999px;
		box-shadow: var(--vg-shadow);
		cursor: pointer;
		font-family: var(--vg-font);
		transition: background 150ms ease, transform 150ms ease, border-color 150ms ease;
	}
	.vg-pill:hover { background: var(--vg-overlay); transform: translateY(-1px); }
	.vg-pill--cta { border-color: var(--vg-accent-soft); }
	.vg-pill--cta:hover { border-color: var(--vg-accent); background: var(--vg-accent-soft); }
	.vg-pill__brand { color: var(--vg-accent); font-size: 12px; font-weight: 800; letter-spacing: -0.02em; }
	.vg-pill__label { color: var(--vg-text); font-size: 12px; font-weight: 550; }
	.vg-pill__label--faint { color: var(--vg-text-faint); font-weight: 500; }
	.vg-pill__label--accent { color: var(--vg-accent); font-weight: 600; }
	.vg-pill__label--danger { color: var(--vg-red); }

	/* ---------------- status dot ---------------- */
	.vg-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; position: relative; }
	.vg-dot::after {
		content: "";
		position: absolute;
		inset: -3px;
		border-radius: 50%;
		border: 1px solid currentColor;
		opacity: 0.25;
	}
	.vg-dot--pulse { animation: vg-pulse 1.6s ease-in-out infinite; }
	@keyframes vg-pulse {
		0%, 100% { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
		50% { box-shadow: 0 0 8px 1px currentColor; opacity: 0.85; }
	}

	/* ---------------- card (expanded) ---------------- */
	.vg-card {
		position: fixed;
		bottom: 20px;
		left: 20px;
		z-index: 2147483647;
		width: 332px;
		background: var(--vg-bg);
		border: 1px solid var(--vg-border);
		border-radius: var(--vg-radius-card);
		box-shadow: var(--vg-shadow);
		font-family: var(--vg-font);
		overflow: hidden;
		animation: vg-rise 150ms ease-out;
	}
	@keyframes vg-rise {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: translateY(0); }
	}
	.vg-card__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 13px 16px;
		background: var(--vg-surface);
		border-bottom: 1px solid var(--vg-border);
	}
	.vg-card__id { display: flex; align-items: center; gap: 9px; min-width: 0; }
	.vg-card__status { color: var(--vg-text); font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }
	.vg-card__brand { color: var(--vg-accent); font-size: 13px; font-weight: 800; letter-spacing: -0.02em; }
	.vg-card__hactions { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }

	.vg-link-open {
		color: var(--vg-accent);
		text-decoration: none;
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		opacity: 0.85;
	}
	.vg-link-open:hover { opacity: 1; }
	.vg-close {
		color: var(--vg-text-faint);
		font-size: 18px;
		line-height: 1;
		cursor: pointer;
		border: none;
		background: none;
		padding: 0;
		font-family: var(--vg-font);
	}
	.vg-close:hover { color: var(--vg-text); }

	.vg-chip {
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		padding: 2px 7px;
		border-radius: 999px;
		line-height: 1.4;
	}

	.vg-card__body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
	.vg-text { font-size: 13px; line-height: 1.5; color: var(--vg-text-dim); }
	.vg-text--primary { color: var(--vg-text); }
	.vg-text--oneline {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.vg-summary { font-size: 13px; line-height: 1.55; color: var(--vg-text-dim); overflow-wrap: anywhere; }

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
	.vg-link-line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		font-size: 12px;
		color: var(--vg-text-faint);
	}
	.vg-link-line a {
		color: var(--vg-accent);
		text-decoration: none;
		font-weight: 600;
		max-width: 210px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.vg-link-line__value {
		color: var(--vg-text-dim);
		font-family: var(--vg-mono);
		font-size: 11px;
		max-width: 210px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.vg-agent {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		min-height: 32px;
	}
	.vg-agent__label {
		color: var(--vg-text-faint);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.vg-agent__seg {
		display: grid;
		grid-template-columns: repeat(2, 72px);
		height: 30px;
		padding: 2px;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid var(--vg-border);
		border-radius: var(--vg-radius-ctl);
	}
	.vg-model-select {
		appearance: none;
		-webkit-appearance: none;
		height: 30px;
		padding: 0 28px 0 10px;
		background-color: rgba(255, 255, 255, 0.05);
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%236b6f77' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 10px center;
		border: 1px solid var(--vg-border);
		border-radius: var(--vg-radius-ctl);
		color: var(--vg-text);
		font-family: var(--vg-font);
		font-size: 12px;
		font-weight: 650;
		cursor: pointer;
		outline: none;
	}
	.vg-model-select:hover { border-color: var(--vg-border-strong); }
	.vg-model-select:focus { border-color: var(--vg-accent); }
	.vg-model-select:disabled { cursor: default; opacity: 0.5; }
	.vg-model-select option { background: var(--vg-surface); color: var(--vg-text); }
	.vg-agent__option {
		height: 24px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--vg-text-dim);
		font-family: var(--vg-font);
		font-size: 12px;
		font-weight: 650;
		cursor: pointer;
	}
	.vg-agent__option.is-active {
		background: var(--vg-accent-fill);
		color: #fff;
	}
	.vg-agent__option:disabled {
		cursor: default;
		opacity: 0.5;
	}

	.vg-pr {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		align-self: flex-start;
		padding: 6px 11px;
		background: var(--vg-accent-soft);
		border: 1px solid transparent;
		border-radius: var(--vg-radius-ctl);
		color: var(--vg-accent);
		text-decoration: none;
		font-size: 12px;
		font-weight: 600;
		transition: border-color 150ms ease;
	}
	.vg-pr:hover { border-color: var(--vg-accent); }

	.vg-error {
		font-size: 12px;
		line-height: 1.5;
		color: var(--vg-red);
		background: var(--vg-red-soft);
		border-radius: var(--vg-radius-ctl);
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


	.vg-card__actions { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--vg-border); }

	.vg-btn {
		height: 30px;
		padding: 0 14px;
		border-radius: var(--vg-radius-ctl);
		font-family: var(--vg-font);
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
		transition: background 150ms ease, border-color 150ms ease, opacity 150ms ease;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.vg-btn--primary { background: var(--vg-accent-fill); color: #fff; }
	.vg-btn--primary:hover { background: #5a9dff; }
	.vg-btn--muted { background: transparent; border-color: var(--vg-border-strong); color: var(--vg-text-dim); }
	.vg-btn--muted:hover { background: var(--vg-overlay); color: var(--vg-text); }
	.vg-btn--danger { background: transparent; border-color: var(--vg-red-soft); color: var(--vg-red); }
	.vg-btn--danger:hover { background: var(--vg-red-soft); }
	.vg-btn:disabled { opacity: 0.45; cursor: default; }
	.vg-spacer { flex: 1; }

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
