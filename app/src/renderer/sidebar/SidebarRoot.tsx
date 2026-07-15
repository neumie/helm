// Native sidebar root — push-stack navigation (design-system.md §3.10) over
// the HelmBridge snapshot. Data arrives exclusively through the main-process
// bridge (window.helm.daemon) — never fetch :7474 from this file:// renderer.
//
// Navigation model: list → detail → plan/task, list → archive, list →
// settings → section. Every stacked page stays mounted (scroll + state
// preserved); non-top pages are inert. Esc pops the stack when focus is in
// the pane (menus/sheets handle their own Esc in the capture phase first).

import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './sidebar.css'
import type { HelmSnapshot } from '../../shared-helm'
import { showToast } from '../toast'
import { AppearancePage } from './AppearancePage'
import { DetailPage } from './DetailPage'
import { PlanPage, RunDetailsPage, RunSetupPage, TaskPage } from './DetailSubpages'
import { ListPage } from './ListPage'
import { NewItemSheet } from './NewItemSheet'
import { SettingsPage, SettingsSectionPage, useSettingsStore } from './SettingsPage'
import type { Route } from './model'
import type { RunSelectionDraft } from './run-selection'
import { type SwipeBackControl, attachSwipeBack } from './swipe'
import { PushHeader } from './ui'

const PUSH_MS = 150
const POP_MS = 120

function useHelmSnapshot(): HelmSnapshot | null {
	const [snapshot, setSnapshot] = useState<HelmSnapshot | null>(null)
	useEffect(() => {
		let alive = true
		const unsubscribe = window.helm.daemon.onSnapshot(next => {
			if (alive) setSnapshot(next)
		})
		// Initial state; pushes only arrive when polled state changes afterwards.
		void window.helm.daemon.subscribe().then(initial => {
			if (alive) setSnapshot(current => current ?? initial)
		})
		return () => {
			alive = false
			unsubscribe()
		}
	}, [])
	return snapshot
}

interface NavState {
	stack: Route[]
	/** Page animating out during a pop; rendered on top until the timer clears it. */
	leaving: Route | null
	phase: 'push' | 'pop' | null
}

function useNavStack() {
	const [nav, setNav] = useState<NavState>({ stack: [{ kind: 'list' }], leaving: null, phase: null })
	const timer = useRef<number | null>(null)
	// Mirror for imperative consumers (gesture controller, forward recording).
	const navRef = useRef(nav)
	navRef.current = nav
	// Forward memory (§3.10 gestures): pops park their route here; pushing a
	// new route clears it. A ref, not state — only shortcuts/gestures read it.
	const forward = useRef<Route[]>([])

	const settle = useCallback((ms: number) => {
		if (timer.current !== null) clearTimeout(timer.current)
		timer.current = window.setTimeout(() => {
			setNav(prev => ({ ...prev, leaving: null, phase: null }))
			timer.current = null
		}, ms + 30)
	}, [])

	const push = useCallback(
		(route: Route) => {
			forward.current = []
			setNav(prev => ({ stack: [...prev.stack, route], leaving: null, phase: 'push' }))
			settle(PUSH_MS)
		},
		[settle],
	)

	const recordForward = useCallback(() => {
		const stack = navRef.current.stack
		const top = stack[stack.length - 1]
		if (stack.length > 1 && top) forward.current.push(top)
	}, [])

	const pop = useCallback(() => {
		recordForward()
		setNav(prev => {
			if (prev.stack.length <= 1) return prev
			const top = prev.stack[prev.stack.length - 1] ?? null
			return { stack: prev.stack.slice(0, -1), leaving: top, phase: 'pop' }
		})
		settle(POP_MS)
	}, [settle, recordForward])

	/** Pop with NO leaving animation — the swipe controller already dragged the
	 *  pages into place; replaying the 120ms pop would flash. */
	const popInstant = useCallback(() => {
		recordForward()
		setNav(prev => {
			if (prev.stack.length <= 1) return prev
			return { stack: prev.stack.slice(0, -1), leaving: null, phase: null }
		})
	}, [recordForward])

	/** Re-push the most recently popped route (cmd+] / swipe forward). */
	const goForward = useCallback(() => {
		const route = forward.current.pop()
		if (!route) return
		setNav(prev => ({ stack: [...prev.stack, route], leaving: null, phase: 'push' }))
		settle(PUSH_MS)
	}, [settle])

	/** Replace the whole stack (helm:// deep links) instead of piling pushes. */
	const reset = useCallback(
		(stack: Route[]) => {
			forward.current = []
			setNav({ stack, leaving: null, phase: 'push' })
			settle(PUSH_MS)
		},
		[settle],
	)

	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current)
		},
		[],
	)

	return { nav, navRef, push, pop, popInstant, goForward, reset }
}

export function SidebarRoot() {
	const snapshot = useHelmSnapshot()
	const { nav, navRef, push, pop, popInstant, goForward, reset } = useNavStack()
	const [newItemOpen, setNewItemOpen] = useState(false)
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [runDrafts, setRunDrafts] = useState<Record<string, RunSelectionDraft>>({})
	const viewportRef = useRef<HTMLDivElement>(null)
	const newItemOpenRef = useRef(newItemOpen)
	newItemOpenRef.current = newItemOpen

	const settingsActive = nav.stack.some(route => route.kind === 'settings' || route.kind === 'settings-section')
	const settings = useSettingsStore(settingsActive)

	const openItem = useCallback(
		(id: string) => {
			setSelectedId(id)
			push({ kind: 'detail', id })
		},
		[push],
	)

	// helm://item/<id> (main's open-url → preload nav channel): jump straight
	// to the item, replacing whatever was stacked — a deep link is an absolute
	// destination, and repeated clicks must not pile up detail pages.
	useEffect(
		() =>
			window.helm.nav.onOpenItem(id => {
				setNewItemOpen(false)
				setSelectedId(id)
				reset([{ kind: 'list' }, { kind: 'detail', id }])
			}),
		[reset],
	)

	// Two-finger swipe-back (§3.10 gestures): interactive edge-tracking pop.
	// The controller lives outside React (inline transforms on the page
	// elements); refs feed it the current stack/sheet state. The control ref
	// lets the Go channel run the native/wheel single-owner check.
	const swipeControl = useRef<SwipeBackControl | null>(null)
	useEffect(() => {
		const viewport = viewportRef.current
		if (!viewport) return
		const control = attachSwipeBack(viewport, {
			canPop: () =>
				navRef.current.stack.length > 1 &&
				navRef.current.phase === null &&
				navRef.current.leaving === null &&
				!newItemOpenRef.current,
			getPages: () => {
				const pageEls = viewport.querySelectorAll<HTMLElement>(':scope > .nav-page')
				const top = pageEls[pageEls.length - 1]
				const under = pageEls[pageEls.length - 2]
				return top && under ? { top, under } : null
			},
			commitPop: popInstant,
			reducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
		})
		swipeControl.current = control
		return () => {
			swipeControl.current = null
			control.dispose()
		}
	}, [popInstant, navRef])

	// Back/forward from main — native three-finger swipe, the Go menu
	// (cmd+[ / cmd+]), and app-command mouse buttons share one channel. With
	// the "two or three fingers" system setting, ONE physical gesture can
	// arrive both as wheel deltas and as a native 'swipe' event, so back
	// defers to the wheel controller's single-owner check before popping.
	useEffect(
		() =>
			window.helm.nav.onGo(direction => {
				if (newItemOpenRef.current) return
				if (direction === 'back') {
					if (swipeControl.current?.interceptNativeNav()) return
					pop()
				} else goForward()
			}),
		[pop, goForward],
	)

	// Mouse back/forward buttons (3/4) reaching the renderer directly.
	useEffect(() => {
		const onMouseUp = (event: MouseEvent) => {
			if (event.button !== 3 && event.button !== 4) return
			if (newItemOpenRef.current) return
			event.preventDefault()
			if (event.button === 3) pop()
			else goForward()
		}
		window.addEventListener('mouseup', onMouseUp)
		return () => window.removeEventListener('mouseup', onMouseUp)
	}, [pop, goForward])

	// Esc = back (§4) — only when the event came from inside the pane, never
	// from the terminal, and not from a typing context. Menus and the sheet
	// intercept Esc in the capture phase before this bubble listener runs.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || newItemOpen) return
			const target = event.target as HTMLElement | null
			if (!target || !target.closest('#left')) return
			if (target.matches('input, textarea, select')) return
			pop()
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [pop, newItemOpen])

	// --ui-preview=<page>: auto-navigate once for the screenshot harness (list
	// is the default state; the background* previews are terminal-strip-owned —
	// renderer.ts handles them, the sidebar stays on the list).
	const previewDone = useRef(false)
	useEffect(() => {
		if (previewDone.current) return
		const preview = window.helm.uiPreview
		if (preview === 'settings') {
			previewDone.current = true
			push({ kind: 'settings' })
			return
		}
		if (preview === 'appearance') {
			previewDone.current = true
			reset([{ kind: 'list' }, { kind: 'settings' }, { kind: 'appearance' }])
			return
		}
		if (preview !== 'detail' && preview !== 'queue-detail' && preview !== 'archive-detail' && preview !== 'task') {
			previewDone.current = true
			return
		}
		// Item previews need an id from the first snapshot with items. Task prefers
		// a source-backed Item; queue-detail shows the ownership decision; archive-
		// detail exercises the deeper list → archive → detail stack.
		const items = snapshot?.items
		if (!items || items.length === 0) return
		previewDone.current = true
		let pick = items[0]
		if (preview === 'task') pick = items.find(i => i.source || i.captured) ?? items[0]
		else if (preview === 'queue-detail') pick = items.find(i => i.status === 'ready') ?? items[0]
		else if (preview === 'archive-detail')
			pick = items.find(i => i.status === 'done' || i.status === 'cancelled') ?? items[0]
		else
			pick =
				items.find(i => i.status === 'review' || i.status === 'failed') ??
				items.find(i => i.assessment !== null) ??
				items[0]
		if (pick && preview === 'task')
			reset([{ kind: 'list' }, { kind: 'detail', id: pick.id }, { kind: 'task', id: pick.id }])
		else if (pick && preview === 'archive-detail') {
			reset([{ kind: 'list' }, { kind: 'archive' }])
			window.setTimeout(() => openItem(pick.id), PUSH_MS + 40)
		} else if (pick) openItem(pick.id)
	}, [snapshot, push, reset, openItem])

	useEffect(() => {
		// Focusing an element while its page is translated offscreen makes Chromium
		// scroll it into view and visually skips the slide. Restore focus only after
		// push/pop motion has settled and the destination is no longer inert.
		if (nav.leaving !== null || nav.phase !== null) return
		const top = nav.stack[nav.stack.length - 1]
		requestAnimationFrame(() => {
			if (top?.kind === 'list' || top?.kind === 'archive') {
				const selected = document.querySelector<HTMLElement>(`[data-item-id="${selectedId ?? ''}"]`)
				selected?.focus()
				if (!selected) document.querySelector<HTMLElement>('.nav-page:not([aria-hidden="true"]) button')?.focus()
			} else {
				document.querySelector<HTMLElement>('.nav-page:not([aria-hidden="true"]) [data-page-heading]')?.focus()
			}
		})
	}, [nav.stack, nav.leaving, nav.phase, selectedId])

	const runCommand = useCallback(async (label: string, call: () => Promise<{ error?: string }>) => {
		const result = await call()
		if (result.error !== undefined) showToast({ message: `${label} failed`, detail: result.error, ttlMs: 6000 })
		else showToast({ message: label })
	}, [])

	const renderRoute = (route: Route) => {
		switch (route.kind) {
			case 'list':
			case 'archive':
				return (
					<ListPage
						snapshot={snapshot}
						archive={route.kind === 'archive'}
						selectedId={selectedId}
						onOpenItem={openItem}
						onNewItem={() => setNewItemOpen(true)}
						onOpenArchive={() => push({ kind: 'archive' })}
						onOpenSettings={() => push({ kind: 'settings' })}
						onPoll={() => void runCommand('Poll requested', () => window.helm.daemon.poll())}
						onPauseToggle={() =>
							void runCommand(snapshot?.status?.queue.paused ? 'Queue resumed' : 'Queue paused', () =>
								window.helm.daemon.pauseToggle(),
							)
						}
						onStartAgent={id => runCommand('Agent started', () => window.helm.daemon.itemAction(id, 'start', {}))}
						onWorkManually={id => runCommand('Marked active', () => window.helm.daemon.setStatus(id, 'active'))}
					/>
				)
			case 'detail':
				return (
					<DetailPage
						id={route.id}
						snapshot={snapshot}
						draft={runDrafts[route.id] ?? {}}
						onBack={pop}
						onOpenPlan={id => push({ kind: 'plan', id })}
						onOpenTask={id => push({ kind: 'task', id })}
						onOpenRun={id => push({ kind: 'run', id })}
						onOpenSetup={id => push({ kind: 'run-setup', id })}
					/>
				)
			case 'plan':
				return <PlanPage id={route.id} snapshot={snapshot} onBack={pop} />
			case 'task':
				return <TaskPage id={route.id} snapshot={snapshot} onBack={pop} />
			case 'run':
				return <RunDetailsPage id={route.id} snapshot={snapshot} onBack={pop} />
			case 'run-setup':
				return (
					<RunSetupPage
						id={route.id}
						snapshot={snapshot}
						onBack={pop}
						draft={runDrafts[route.id] ?? {}}
						onDraftChange={draft => setRunDrafts(current => ({ ...current, [route.id]: draft }))}
					/>
				)
			case 'settings':
				return (
					<SettingsPage
						store={settings}
						onBack={pop}
						onOpenSection={sectionId => push({ kind: 'settings-section', sectionId })}
						onOpenAppearance={() => push({ kind: 'appearance' })}
					/>
				)
			case 'settings-section':
				return <SettingsSectionPage store={settings} sectionId={route.sectionId} onBack={pop} />
			case 'appearance':
				return <AppearancePage onBack={pop} />
		}
	}

	// Archive is list-flavored but pushed — give it a header via wrapper below.
	const pages: Array<{ route: Route; key: string }> = nav.stack.map((route, index) => ({
		route,
		key: `${index}-${route.kind}-${'id' in route ? route.id : ''}${route.kind === 'settings-section' ? route.sectionId : ''}`,
	}))

	const topIndex = pages.length - 1

	return (
		<div className="sidebar">
			<div className="nav-viewport" ref={viewportRef}>
				{pages.map(({ route, key }, index) => {
					const isTop = index === topIndex && nav.leaving === null
					const classes = ['nav-page']
					if (nav.phase === 'push' && index === topIndex) classes.push('nav-push-in')
					if (nav.phase === 'push' && index === topIndex - 1) classes.push('nav-under-away')
					if (nav.phase === 'pop' && index === topIndex) classes.push('nav-under-back')
					return (
						<div
							key={key}
							className={classes.join(' ')}
							inert={!isTop || newItemOpen ? true : undefined}
							aria-hidden={!isTop}
						>
							{route.kind === 'archive' ? (
								<ArchiveFrame onBack={pop}>{renderRoute(route)}</ArchiveFrame>
							) : (
								renderRoute(route)
							)}
						</div>
					)
				})}
				{nav.leaving && (
					<div className="nav-page nav-pop-out" inert aria-hidden>
						{nav.leaving.kind === 'archive' ? (
							<ArchiveFrame onBack={pop}>{renderRoute(nav.leaving)}</ArchiveFrame>
						) : (
							renderRoute(nav.leaving)
						)}
					</div>
				)}
			</div>
			{newItemOpen && <NewItemSheet snapshot={snapshot} onClose={() => setNewItemOpen(false)} onCreated={openItem} />}
		</div>
	)
}

function ArchiveFrame({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
	return (
		<div className="archive-frame">
			<PushHeader title="Archive" onBack={onBack} />
			{children}
		</div>
	)
}

export function mountSidebar(container: HTMLElement): void {
	createRoot(container).render(<SidebarRoot />)
}
