// B4 — window per file and tabs together (helm open spec D12). Story-only.
// macOS native window tabbing needs a framed window with titleBarStyle 'default' (internally kNormal); Electron
// sets NSWindowTabbingModeDisallowed for frameless or transparent windows. The prototype title row assumes
// titleBarStyle 'hidden', like the review window (window.ts), so the tabs here are Helm's own, drawn in the A1
// title row, with Helm's own Window menu items doing what the native ones would.
import { useLayoutEffect, useRef, useState } from 'react'
import { ChromeTitleRow, ExtTag, MultiTabs, TrafficLights, folderOf, shortPath } from './chrome'
import './chrome-combined.css'
import type { ViewerFile } from './types'

export type CombinedFrame = 'windows' | 'tabs' | 'menu' | 'palette'

/** A window behind the front one: only its title row shows. */
function BackWindow({ file, depth }: { file: ViewerFile; depth: number }) {
	return (
		<div className="b4-window b4-back" style={{ ['--depth' as string]: depth }} aria-hidden="true">
			<div className="b4-back-head">
				<TrafficLights />
				<ExtTag file={file} />
				<span className="b4-back-name">{file.name}</span>
			</div>
		</div>
	)
}

/** Static menu panel in the shared menu look, for a still frame. */
function MenuPanel({
	label,
	items,
	style,
	className,
}: {
	label: string
	items: ({ label: string; meta?: string; check?: boolean; disabled?: boolean } | 'sep')[]
	style?: React.CSSProperties
	className?: string
}) {
	return (
		// A still picture of a menu: hidden from assistive tech and not focusable.
		<div
			className={`menu-panel b4-menu${className ? ` ${className}` : ''}`}
			data-label={label}
			style={style}
			aria-hidden="true"
			inert
		>
			{items.map((item, index) =>
				item === 'sep' ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: static story menu.
					<div key={`sep-${index}`} className="menu-separator" aria-hidden="true" />
				) : (
					<button key={item.label} type="button" className="menu-item" disabled={item.disabled} tabIndex={-1}>
						<span className="menu-item-icon">{item.check ? '✓' : ''}</span>
						<span className="menu-item-label">{item.label}</span>
						{item.meta ? <span className="menu-item-meta">{item.meta}</span> : null}
					</button>
				),
			)}
		</div>
	)
}

/** Helm's own Window menu: what native tabbing would have added, plus the window list AppKit keeps. */
function WindowMenu({ windows, merged }: { windows: ViewerFile[]; merged: boolean }) {
	return (
		<div className="b4-menubar" aria-hidden="true">
			<span className="b4-menubar-app">Helm</span>
			<span>File</span>
			<span>Edit</span>
			<span>View</span>
			<span className="b4-menubar-open">
				Window
				<MenuPanel
					label="Window"
					className="b4-window-menu"
					items={[
						{ label: 'Minimize', meta: '⌘M' },
						'sep',
						{ label: 'Go to File…', meta: '⌘⇧O' },
						{ label: 'Open Files as Tabs' },
						'sep',
						{ label: 'Show Previous Tab', meta: '⌃⇧⇥', disabled: !merged },
						{ label: 'Show Next Tab', meta: '⌃⇥', disabled: !merged },
						{ label: 'Move Tab to New Window', disabled: !merged },
						{ label: 'Merge All Windows', disabled: merged },
						'sep',
						{ label: 'Bring All to Front' },
						'sep',
						...windows.map((file, index) => ({ label: file.name, check: index === 0 })),
					]}
				/>
			</span>
			<span>Help</span>
		</div>
	)
}

/** ⌘⇧O over both: the tabs of this window first, then the other windows, then recent files. */
function Palette({ tabs, windows, recent }: { tabs: ViewerFile[]; windows: ViewerFile[]; recent: ViewerFile[] }) {
	const field = useRef<HTMLInputElement>(null)
	useLayoutEffect(() => field.current?.focus(), [])
	const row = (file: ViewerFile, note: string, active = false) => (
		<button
			key={file.url}
			type="button"
			aria-current={active ? 'true' : undefined}
			className={`open-palette-row${active ? ' open-palette-row-active' : ''}`}
		>
			<ExtTag file={file} />
			<span className="open-palette-name">{file.name}</span>
			<span className="open-palette-path">{shortPath(folderOf(file.path), 36)}</span>
			<span className="open-palette-note">{note}</span>
		</button>
	)
	return (
		<>
			<div className="open-b2-scrim" />
			<section className="open-palette" aria-label="Go to file">
				<input ref={field} className="open-palette-field" placeholder="Go to file" />
				<div className="open-palette-list">
					<div className="open-palette-section">Tabs in this window</div>
					{tabs.map((file, index) => row(file, index === 0 ? 'This tab' : `⌘${index + 1}`))}
					<div className="open-palette-section">Other windows</div>
					{windows.map((file, index) => row(file, 'Window', index === 0))}
					<div className="open-palette-section">Recent</div>
					{recent.map(file => row(file, file.modified))}
				</div>
				<div className="open-palette-keys">
					<span>↑↓ choose</span>
					<span>↵ open</span>
					<span>⌘↵ new window</span>
					<span>esc close</span>
				</div>
			</section>
		</>
	)
}

/** The merged window's tab menu, anchored under the second tab. */
function TabMenu() {
	const marker = useRef<HTMLSpanElement>(null)
	const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
	useLayoutEffect(() => {
		// The desk's own ref is attached after this child's layout effect, so find it from a marker.
		const root = marker.current?.closest('.b4-desk')
		const tab = root?.querySelectorAll('.open-tab')[1]
		if (!root || !tab) return
		const box = tab.getBoundingClientRect()
		const origin = root.getBoundingClientRect()
		setPlace({ left: box.left - origin.left, top: box.bottom - origin.top + 4 })
	}, [])
	return (
		<>
			<span ref={marker} hidden />
			{place ? (
				<MenuPanel
					label="Tab"
					className="b4-tab-menu"
					style={{ left: place.left, top: place.top }}
					items={[
						{ label: 'Move tab to new window' },
						{ label: 'Close tab', meta: '⌘W' },
						{ label: 'Close other tabs' },
						'sep',
						{ label: 'Show in Finder' },
					]}
				/>
			) : null}
		</>
	)
}

/**
 * B4: every file opens in its own window by default (B2); Window → Merge All Windows, or the "Open Files as
 * Tabs" setting, puts them in one window's tab strip (B1). A tab dragged out, or Move Tab to New Window, is a
 * window again. ⌘⇧O finds a file wherever it is.
 */
export function MultiCombined({ files, frame }: { files: ViewerFile[]; frame: CombinedFrame }) {
	const open = files.slice(0, 3)
	const front = open[0]
	if (!front) return null
	const merged = frame === 'tabs'
	return (
		<div className="b4-desk" data-frame={frame}>
			{merged
				? null
				: open
						.slice(1)
						.reverse()
						.map((file, index) => <BackWindow key={file.url} file={file} depth={index} />)}
			<div className="b4-window b4-front" style={{ ['--depth' as string]: merged ? 0 : open.length - 1 }}>
				{merged ? <MultiTabs files={open} /> : <ChromeTitleRow file={front} companionOpen={false} />}
				{frame === 'palette' ? <Palette tabs={[front]} windows={open.slice(1)} recent={files.slice(3, 6)} /> : null}
			</div>
			{merged ? <TabMenu /> : null}
			{frame === 'menu' ? <WindowMenu windows={open} merged={false} /> : null}
		</div>
	)
}
