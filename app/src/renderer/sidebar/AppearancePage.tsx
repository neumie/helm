// Settings → Appearance (docs/design-system.md §2.8): theme picker, text
// sizing, and per-token color wells for the terminal palette + UI accent.
// Every control live-applies through the appearance store; persistence is
// localStorage ('helm.appearance') + theme files in <userData>/themes.

import { useEffect, useSyncExternalStore } from 'react'
import { TERM_FONT_DEFAULT, TERM_FONT_MAX, TERM_FONT_MIN, UI_SCALES, appearance } from '../appearance'
import { Btn, Card, FieldLabel, PushHeader, Segmented, SelectInput } from './ui'

const TERM_WELLS: ReadonlyArray<{ token: string; label: string }> = [
	{ token: '--term-bg', label: 'Background' },
	{ token: '--term-fg', label: 'Foreground' },
	{ token: '--term-cursor', label: 'Cursor' },
]

const ANSI_WELLS: ReadonlyArray<{ token: string; label: string }> = [
	{ token: '--ansi-black', label: 'Black' },
	{ token: '--ansi-red', label: 'Red' },
	{ token: '--ansi-green', label: 'Green' },
	{ token: '--ansi-yellow', label: 'Yellow' },
	{ token: '--ansi-blue', label: 'Blue' },
	{ token: '--ansi-magenta', label: 'Magenta' },
	{ token: '--ansi-cyan', label: 'Cyan' },
	{ token: '--ansi-white', label: 'White' },
	{ token: '--ansi-bright-black', label: 'Bright black' },
	{ token: '--ansi-bright-red', label: 'Bright red' },
	{ token: '--ansi-bright-green', label: 'Bright green' },
	{ token: '--ansi-bright-yellow', label: 'Bright yellow' },
	{ token: '--ansi-bright-blue', label: 'Bright blue' },
	{ token: '--ansi-bright-magenta', label: 'Bright magenta' },
	{ token: '--ansi-bright-cyan', label: 'Bright cyan' },
	{ token: '--ansi-bright-white', label: 'Bright white' },
]

/** <input type=color> only speaks #rrggbb; normalize what the token holds. */
function hexColor(value: string | undefined): string {
	const v = (value ?? '').trim()
	if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase()
	if (/^#[0-9a-fA-F]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase()
	return '#000000'
}

function Swatch({
	label,
	value,
	onChange,
}: {
	label: string
	value: string | undefined
	onChange: (hex: string) => void
}) {
	return (
		<label className="swatch">
			<input
				type="color"
				className="color-input"
				value={hexColor(value)}
				aria-label={label}
				onChange={event => onChange(event.target.value)}
			/>
			<span className="swatch-label">{label}</span>
		</label>
	)
}

export function AppearancePage({ onBack }: { onBack: () => void }) {
	const snap = useSyncExternalStore(appearance.subscribe, appearance.getSnapshot)
	// Pick up theme files dropped into <userData>/themes since startup.
	useEffect(() => {
		void appearance.refreshThemes()
	}, [])
	const { state, themes, tokens } = snap
	const edited = Object.keys(state.overrides).length > 0

	return (
		<div className="page-frame">
			<PushHeader title="Appearance" onBack={onBack} />
			<div className="page-scroll">
				<Card
					label="Theme"
					trailing={
						edited ? (
							<Btn sm onClick={() => appearance.clearOverrides()}>
								Reset to preset
							</Btn>
						) : undefined
					}
				>
					<SelectInput
						ariaLabel="Theme"
						value={state.themeId}
						onChange={id => appearance.setTheme(id)}
						options={themes.map(theme => ({ value: theme.id, label: theme.name }))}
					/>
					<p className="meta-text">Themes are JSON token files in the app's themes folder; new files appear here.</p>
					<div className="swatch-grid">
						<Swatch
							label="UI accent"
							value={tokens['--accent']}
							onChange={hex =>
								// One well drives the whole accent family so buttons, links,
								// and focus rings stay coherent (hover derives via color-mix).
								appearance.setOverrides({
									'--accent': hex,
									'--accent-fill': hex,
									'--accent-fill-hover': `color-mix(in srgb, ${hex} 78%, white)`,
								})
							}
						/>
					</div>
				</Card>
				<Card label="Text">
					<div className="settings-field">
						<FieldLabel>Terminal font size</FieldLabel>
						<div className="stepper">
							<Btn
								sm
								ariaLabel="Smaller terminal text"
								disabled={state.termFontSize <= TERM_FONT_MIN}
								onClick={() => appearance.stepTermFontSize(-1)}
							>
								−
							</Btn>
							<span className="stepper-value">{state.termFontSize}px</span>
							<Btn
								sm
								ariaLabel="Bigger terminal text"
								disabled={state.termFontSize >= TERM_FONT_MAX}
								onClick={() => appearance.stepTermFontSize(1)}
							>
								+
							</Btn>
							{state.termFontSize !== TERM_FONT_DEFAULT && (
								<Btn sm tone="ghost" onClick={() => appearance.stepTermFontSize(0)}>
									Reset
								</Btn>
							)}
						</div>
						<p className="meta-text">⌘+ and ⌘− adjust it anywhere; ⌘0 resets.</p>
					</div>
					<div className="settings-field">
						<FieldLabel>UI text size</FieldLabel>
						<Segmented
							label="UI text size"
							options={UI_SCALES.map(scale => ({ value: String(scale.value), label: scale.label }))}
							value={String(state.uiScale)}
							onChange={value => appearance.setUiScale(Number(value))}
						/>
					</div>
				</Card>
				{/* Flush group: swatch rows sit at the flat group's exact fact pitch (§3.15). */}
				<Card label="Terminal palette" flush>
					<div className="swatch-grid">
						{[...TERM_WELLS, ...ANSI_WELLS].map(well => (
							<Swatch
								key={well.token}
								label={well.label}
								value={tokens[well.token]}
								onChange={hex => appearance.setOverride(well.token, hex)}
							/>
						))}
					</div>
				</Card>
			</div>
		</div>
	)
}
