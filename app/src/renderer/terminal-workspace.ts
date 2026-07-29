import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { shouldOpenTerminalLink } from '../external-url'
import type { HelmApi, RestoredSession, TabGroup, TabGroupActionIntent, TabGroupSurface } from '../shared'
import { TAB_GROUP_COLORS, TAB_GROUP_COLOR_LABELS, type TabGroupColor, tabGroupColorCssVar } from '../tab-group-colors'
import { type PlacementDrag, type PlacementSnapshot, TerminalPlacement, terminalId } from '../terminal-placement'
import { ProductionSessionPlacementPort } from '../terminal-placement-production-port'
import { TerminalTransferRendererController } from '../terminal-transfer-renderer'
import { createActivityIndicator, setActivityIndicatorState } from './activity-indicator'
import { appearance as productionAppearance } from './appearance'
import { createIconButton } from './icon-button'
import { type SynchronizedOutputGuard, createSynchronizedOutputGuard } from './synchronized-output'
import {
	dragThresholdExceeded,
	groupDropInsertionIndex,
	pointInExpandedRect,
	stripDropInsertionIndex,
	tabStripAutoScrollDelta,
} from './tab-drag'
import {
	type TabGroupActionTarget,
	type TabGroupSection,
	composeTabGroups,
	tabGroupHeading,
	tabGroupMembersId,
} from './tab-groups'
import { decideTabTitle, isShellDefaultTitle, normalizeTabTitle } from './tab-title'
import { terminalShortcut } from './terminal-keybindings'
import {
	type TerminalProgressTracker,
	createTerminalProgressTracker,
	shouldMarkTerminalCompletion,
} from './terminal-progress'
import { showToast } from './toast'

export type TerminalWorkspaceHelm = Pick<
	HelmApi,
	| 'appearance'
	| 'buffers'
	| 'external'
	| 'platform'
	| 'profiles'
	| 'pty'
	| 'sessions'
	| 'tabs'
	| 'termCmd'
	| 'termScroll'
	| 'terminalTransfer'
	| 'titleStickyMs'
	| 'uiPreview'
>

export interface TerminalWorkspaceMountOptions {
	/** Static production shell; it retains the established terminal IDs/selectors. */
	root: ParentNode
	/** Token-fenced renderer bridge captured by the preload for this profile generation. */
	helm: TerminalWorkspaceHelm
	/** Explicit runtime dependency; production passes the shared appearance owner. */
	appearance?: typeof productionAppearance
}

export interface MountedTerminalWorkspace {
	/** Resolves after session hydration, attachment, and screenshot-preview setup. */
	ready: Promise<void>
	/** Stops mount-owned listeners/observers and disposes live terminal views. */
	dispose(): void
	/** Divider bootstrap uses this existing terminal-fit seam after drag release. */
	fitActive(): void
}

export function mountTerminalWorkspace(options: TerminalWorkspaceMountOptions): MountedTerminalWorkspace {
	const { root, helm } = options
	const appearance = options.appearance ?? productionAppearance
	let disposed = false
	function el<T extends HTMLElement>(id: string): T {
		const node = root instanceof Document ? root.getElementById(id) : root.querySelector(`#${id}`)
		if (!node) throw new Error(`missing #${id}`)
		return node as T
	}

	const tabsEl = el<HTMLDivElement>('tabs')
	const newTabButton = el<HTMLButtonElement>('new-tab')
	const termsEl = el<HTMLDivElement>('terms')
	const tabStripRegion = el<HTMLDivElement>('tab-strip-region')
	const topbarDragSpace = el<HTMLDivElement>('topbar-drag-space')
	const bgRoot = el<HTMLDivElement>('bg-root')
	const bgToggle = el<HTMLButtonElement>('bg-toggle')
	const bgCurrent = el<HTMLSpanElement>('bg-current')
	const bgCount = el<HTMLSpanElement>('bg-count')
	const bgPopover = el<HTMLDivElement>('bg-popover')
	const bgRows = el<HTMLDivElement>('bg-rows')

	// ---------- terminal tabs ----------
	// The xterm theme comes from the appearance token map (--term-* / --ansi-*,
	// docs/design-system.md §2.8) — the old hardcoded termTheme literal is gone;
	// theme-presets.ts HELM_TOKENS carries the canonical ANSI-16 values.

	interface Tab {
		ptyId: number | null
		/** dtach session behind the pty; null while spawning or when persistence is off. */
		sessionId: string | null
		closed: boolean
		/** Transfer fence: blocks input, close, rename, group, and snapshot mutation. */
		transferring: boolean
		/** In the background list (strip-right stack button + popover) instead of the strip. */
		parked: boolean
		/** Persisted opaque membership; fresh tabs begin without a group. */
		groupId: string | null
		/** Renderer identity while a fresh pty has not received a session id. */
		visualId: string
		/** Exit code when the pty ended while parked — the popover row stays, state "Exited". */
		exitCode: number | null
		/** False only for exited/missing runtime rows; run-owned sessions remain placeable. */
		placementEligible: boolean
		/** Current APPLIED normalized title (label when unpinned; popover/toast text). */
		title: string
		/** Raw form of `title` — the tooltip shows it when normalization changed it. */
		titleRaw: string
		/** Last SEEN live OSC title (normalized/raw), applied or not — pinned tabs'
		 *  tooltip shows it and an unpin falls back to it. Null until OSC arrives. */
		oscTitle: string | null
		oscRaw: string | null
		/** Manual rename pin: label text, OSC-immune, persisted as registry customName. */
		customName: string | null
		/** Reattached an existing dtach session — arms restored-title stickiness. */
		restored: boolean
		/** A non-default OSC title applied since attach; stickiness is over. */
		titleSettled: boolean
		/** performance.now() when pty:spawn resolved; Infinity while spawning. */
		attachedAt: number
		/** Output arrived since the last buffer-snapshot save (10s autosave picks it up). */
		dirty: boolean
		/** Holds the last complete viewport over xterm while a large DEC synchronized
		 *  redraw parses; snapshot/scrollbar work also waits for this to clear. */
		frameOutputPending: boolean
		frameFreeze: HTMLElement | null
		outputGuard: SynchronizedOutputGuard
		/** Explicit OSC 9;4 state from Pi; never inferred from terminal output. */
		agentRunning: boolean
		/** A protocol-observed active→clear transition not yet viewed by the user. */
		agentAttention: boolean
		progressTracker: TerminalProgressTracker
		runningEl: HTMLOutputElement
		term: Terminal
		fit: FitAddon
		/** Buffer serializer for snapshot saves (restore-before-attach, app/src/buffers.ts). */
		serialize: SerializeAddon
		holder: HTMLDivElement
		tabButton: HTMLDivElement
		/** The tab's label span — renderTabLabel owns its text/tooltip. */
		labelEl: HTMLSpanElement
		/** Custom overlay scrollbar (§3.14): full-pane track + pill thumb. */
		scrollbar: HTMLDivElement
		thumb: HTMLDivElement
		/** rAF-coalescing flags (one pending frame each, never stacked). */
		fitRetryPending: boolean
		scrollSyncPending: boolean
		/** dtach's attach client home+clears (\e[H\e[J) as its FIRST output on every
		 *  attach (verified against attach with `-r none`: the stream is exactly
		 *  those 6 bytes) — it would wipe a restored buffer snapshot, so the first
		 *  chunk of a session-backed spawn is filtered once (see filterAttachClear). */
		attachClearPending: boolean
		attachClearHeld: string
	}

	// FitAddon measures getComputedStyle(term.element.parentElement).width, which
	// under box-sizing:border-box INCLUDES that element's own padding — so xterm
	// must be mounted in an UNPADDED .term-mount inside the padded .term-holder,
	// or fit overcounts columns by the padding and the last cells paint past the
	// pane edge (that exact bug shipped once; don't mount into the holder again).

	const tabs: Tab[] = []
	/** Runtime remains xterm/PTY-owned; placement only stores stable visual IDs. */
	const runtimeById = new Map<string, Tab>()
	let tabGroups: TabGroup[] = []
	let tabGroupsVersion = 0
	let placementInventoryVersion = 0
	let placementHydrated = false
	let applyingPlacementSnapshot = false
	/** Drag-only DOM surface; Tab.parked remains committed PTY ownership. */
	let projectedSurfaceById: ReadonlyMap<string, 'strip' | 'background'> | null = null
	const profileToken = helm.terminalTransfer.profileToken()
	const tokenSeparator = profileToken.lastIndexOf(':')
	const placementProfileId = tokenSeparator > 0 ? profileToken.slice(0, tokenSeparator) : profileToken
	const parsedPlacementGeneration = Number(profileToken.slice(tokenSeparator + 1))
	const placementGeneration = Number.isSafeInteger(parsedPlacementGeneration) ? parsedPlacementGeneration : 0
	const placementPort = new ProductionSessionPlacementPort(helm.sessions, {
		sessionIdFor: visualId => runtimeById.get(visualId)?.sessionId ?? null,
		terminalIdFor: sessionId =>
			[...runtimeById.values()].find(tab => tab.sessionId === sessionId && !tab.closed)?.visualId ?? null,
		placementEligibleFor: visualId => {
			const tab = runtimeById.get(visualId)
			return tab?.placementEligible === true && tab.exitCode === null && !tab.closed
		},
	})
	const placement = new TerminalPlacement({
		profileId: placementProfileId,
		generation: placementGeneration,
		port: placementPort,
	})
	let nextVisualTabId = 1
	const suppressedGroupToggleClicks = new Set<string>()
	// Background terminals (iTerm "bury session" analog): parked tabs leave the
	// strip but keep their Terminal instance mounted in the hidden holder — the
	// pty stays attached and scrollback keeps accumulating. Memory cost equals an
	// inactive strip tab (those are already hidden, live xterm instances).
	const parked: Tab[] = []
	// These arrays are projection caches only. Runtime still owns the Tab/xterm/PTY holders.
	let activeTab: Tab | null = null

	function placementId(tab: Tab): ReturnType<typeof terminalId> {
		return terminalId(tab.visualId)
	}

	function inventoryPlacement(tab: Tab, type: 'add' | 'remove'): void {
		if (!placementHydrated) return
		placementInventoryVersion += 1
		if (type === 'add') {
			placement.inventory({
				type,
				profileId: placementProfileId,
				generation: placementGeneration,
				version: placementInventoryVersion,
				terminal: { id: placementId(tab), surface: tab.parked ? 'background' : 'strip', groupId: tab.groupId },
			})
		} else {
			placement.inventory({
				type,
				profileId: placementProfileId,
				generation: placementGeneration,
				version: placementInventoryVersion,
				id: placementId(tab),
			})
		}
	}

	function projectPlacementSnapshot(snapshot: PlacementSnapshot): void {
		if (!placementHydrated || disposed) return
		const lookup = (id: string): Tab | null => runtimeById.get(id) ?? null
		// A drag projection is visual only. Ownership remains the committed snapshot so
		// runtime PTY/title/exit paths keep Background semantics until commit succeeds.
		const visual = snapshot.drag ?? snapshot
		projectedSurfaceById = snapshot.drag
			? new Map<string, 'strip' | 'background'>([
					...snapshot.drag.strip.map(id => [id as string, 'strip'] as [string, 'strip' | 'background']),
					...snapshot.drag.background.map(id => [id as string, 'background'] as [string, 'strip' | 'background']),
				])
			: null
		const strip = visual.strip.flatMap(id => {
			const tab = lookup(id)
			return tab && !tab.closed ? [tab] : []
		})
		const background = visual.background.flatMap(id => {
			const tab = lookup(id)
			return tab && !tab.closed ? [tab] : []
		})
		const listed = new Set([...strip, ...background])
		for (const tab of runtimeById.values()) {
			if (!tab.closed && !listed.has(tab))
				(snapshot.background.includes(placementId(tab)) ? background : strip).push(tab)
		}
		const membership = new Map<string, string | null>()
		for (const group of visual.groups) for (const id of group.memberIds) membership.set(id, group.id)
		for (const tab of [...strip, ...background]) {
			tab.parked = snapshot.background.includes(placementId(tab))
			tab.groupId = membership.get(tab.visualId) ?? null
		}
		applyingPlacementSnapshot = true
		projectStripOrder(strip, snapshot.drag !== null)
		parked.splice(0, parked.length, ...background)
		tabGroups = snapshot.groups.map(group => ({
			id: group.id,
			name: group.name,
			color: group.color as TabGroup['color'],
			collapsedStrip: group.collapsedStrip,
			collapsedBackground: group.collapsedBackground,
		}))
		tabGroupsVersion += 1
		const selected = snapshot.selectedId ? lookup(snapshot.selectedId) : null
		if (selected) activate(selected)
		else {
			activeTab = null
			for (const tab of [...tabs, ...parked]) tab.holder.classList.remove('active')
			renderTabGroups()
			syncEmptyState()
			updateBackgroundUi()
		}
		applyingPlacementSnapshot = false
	}

	const unsubscribePlacement = placement.subscribe(projectPlacementSnapshot)

	function hydratePlacement(): void {
		if (placementHydrated) return
		placementHydrated = true
		placement.hydrate({
			profileId: placementProfileId,
			generation: placementGeneration,
			inventoryVersion: placementInventoryVersion,
			terminals: [...tabs, ...parked].map(tab => ({
				id: placementId(tab),
				surface: tab.parked ? 'background' : 'strip',
				groupId: tab.groupId,
			})),
			groups: tabGroups,
		})
	}

	function reconcilePlacementGroups(groups: readonly TabGroup[]): void {
		if (!placementHydrated) return
		placement.reconcileGroups({
			profileId: placementProfileId,
			generation: placementGeneration,
			version: ++tabGroupsVersion,
			groups,
		})
	}

	const findByPty = (id: number): Tab | undefined => tabs.find(t => t.ptyId === id) ?? parked.find(t => t.ptyId === id)

	// Title normalization + arbitration (stickiness/pin rules) live in
	// ./tab-title.ts — pure and node-testable (tests/helm-tab-title.test.ts).

	/** Displayed tab name: the manual pin wins over the live/restored OSC title. */
	function displayName(tab: Tab): string {
		return tab.customName ?? tab.title
	}

	function tabIdentity(tab: Tab): string {
		return tab.sessionId ?? tab.visualId
	}

	function applyGroupColor(element: HTMLElement, color: TabGroupColor | null): void {
		if (color !== null) element.style.setProperty('--group-color', tabGroupColorCssVar(color))
	}

	// Heroicons “Folder”, 16px solid (MIT). See THIRD_PARTY_NOTICES.md.
	const GROUP_ICON_PATH =
		'M2 3.5A1.5 1.5 0 0 1 3.5 2h2.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 9.62 4H12.5A1.5 1.5 0 0 1 14 5.5v1.401a2.986 2.986 0 0 0-1.5-.401h-9c-.546 0-1.059.146-1.5.401V3.5ZM2 9.5v3A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-3A1.5 1.5 0 0 0 12.5 8h-9A1.5 1.5 0 0 0 2 9.5Z'

	function createGroupIcon(): SVGSVGElement {
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
		svg.classList.add('group-icon')
		svg.setAttribute('viewBox', '0 0 16 16')
		svg.setAttribute('fill', 'currentColor')
		svg.setAttribute('aria-hidden', 'true')
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
		path.setAttribute('d', GROUP_ICON_PATH)
		svg.append(path)
		return svg
	}

	function groupHeader(section: TabGroupSection): HTMLElement | null {
		const heading = tabGroupHeading(section)
		if (heading === null) return null
		const toggle = document.createElement('button')
		toggle.type = 'button'
		toggle.className = 'tab-group-header tab-group-toggle'
		toggle.dataset.tabGroupHeader = 'true'
		toggle.dataset.groupId = section.groupId as string
		toggle.dataset.surface = section.surface
		applyGroupColor(toggle, section.color)
		const label = document.createElement('span')
		label.textContent = heading
		const summary = document.createElement('span')
		summary.className = 'tab-group-summary'
		summary.append(createGroupIcon())
		summary.append(label)
		toggle.append(summary)
		if (section.collapsed || section.surface === 'background') {
			const count = document.createElement('span')
			count.className = 'tab-group-count'
			count.textContent = String(section.members.length)
			toggle.append(count)
		}
		toggle.setAttribute('aria-expanded', String(!section.collapsed))
		toggle.setAttribute('aria-controls', tabGroupMembersId(section.groupId, section.surface))
		toggle.title = `${section.collapsed ? 'Expand' : 'Collapse'} ${section.name}`
		const toggleKey = `${section.surface}:${section.groupId as string}`
		toggle.addEventListener('click', () => {
			if (suppressedGroupToggleClicks.delete(toggleKey)) return
			setGroupCollapsed(section.groupId as string, section.surface, !section.collapsed)
		})
		toggle.addEventListener('pointerdown', event => beginGroupPointerDrag(section, toggle, event))
		const openMenu = (x: number, y: number) => openGroupMenu(section, x, y, toggle)
		toggle.addEventListener('contextmenu', event => {
			event.preventDefault()
			openMenu(event.clientX, event.clientY)
		})
		toggle.addEventListener('keydown', event => {
			if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
			event.preventDefault()
			const rect = toggle.getBoundingClientRect()
			openMenu(rect.left, rect.bottom)
		})
		if (section.surface !== 'background') return toggle
		const restoreTarget = section.actionTargets.find(target => target.action === 'restore')
		if (!restoreTarget) return toggle
		const row = document.createElement('div')
		row.className = 'bg-group-header-row'
		const restore = createIconButton({
			label: `Restore ${section.name} group to tabs`,
			glyph: '⇥',
			glyphClassName: 'bg-action-glyph',
			onClick: () => runGroupAction(restoreTarget),
		})
		restore.classList.add('bg-group-restore')
		const closeSlot = document.createElement('span')
		closeSlot.className = 'bg-group-close-slot'
		closeSlot.setAttribute('aria-hidden', 'true')
		row.append(toggle, restore, closeSlot)
		return row
	}

	interface FocusedGroupHeader {
		groupId: string
		surface: TabGroupSurface
	}

	function focusedGroupHeader(root: HTMLElement): FocusedGroupHeader | null {
		const header =
			document.activeElement instanceof HTMLElement
				? document.activeElement.closest<HTMLElement>('[data-tab-group-header]')
				: null
		if (!header || !root.contains(header)) return null
		const groupId = header.dataset.groupId
		const surface = header.dataset.surface
		if (!groupId || (surface !== 'strip' && surface !== 'background')) return null
		return { groupId, surface }
	}

	function restoreFocusedGroupHeader(root: HTMLElement, focused: FocusedGroupHeader | null): void {
		if (!focused) return
		for (const header of root.querySelectorAll<HTMLElement>('[data-tab-group-header]')) {
			if (header.dataset.groupId === focused.groupId && header.dataset.surface === focused.surface) {
				header.focus()
				return
			}
		}
	}

	function tabGroupComposition() {
		return composeTabGroups({
			tabs: [...tabs, ...parked].map(tab => ({
				id: tabIdentity(tab),
				groupId: tab.groupId,
				parked: tab.parked,
				surface: projectedSurfaceById?.get(tab.visualId),
				name: displayName(tab),
				agentRunning: tab.agentRunning,
				agentAttention: tab.agentAttention,
			})),
			groups: tabGroups,
			activeTabId: activeTab ? tabIdentity(activeTab) : null,
		})
	}

	function createStripSection(
		section: TabGroupSection,
		byId: ReadonlyMap<string, Tab>,
		cloneMembers = false,
	): HTMLElement {
		const sectionEl = document.createElement('div')
		sectionEl.className = `tab-group-section${section.collapsed ? ' collapsed' : ''}`
		sectionEl.dataset.groupId = section.groupId ?? ''
		applyGroupColor(sectionEl, section.color)
		const header = groupHeader(section)
		if (header) sectionEl.append(header)
		const membersEl = document.createElement('div')
		membersEl.className = section.kind === 'group' ? 'tab-group-members' : 'tab-group-members ungrouped-tab-members'
		if (section.kind === 'group') membersEl.id = tabGroupMembersId(section.groupId, section.surface)
		membersEl.setAttribute('role', 'tablist')
		membersEl.setAttribute('aria-label', section.kind === 'group' ? `${section.name} terminals` : 'Terminals')
		membersEl.hidden = section.collapsed
		for (const member of section.members) {
			const tab = byId.get(member.id)
			if (!tab) continue
			// Live sections retain terminal button identity. Drag projections clone the
			// same DOM so their intrinsic width cannot drift from the eventual result.
			const button = cloneMembers ? createTabStripProjection(tab) : tab.tabButton
			button.hidden = false
			membersEl.append(button)
		}
		sectionEl.append(membersEl)
		return section.kind === 'group' ? sectionEl : membersEl
	}

	function renderTabGroups(): void {
		const focusedHeader = focusedGroupHeader(tabsEl)
		const byId = new Map(tabs.map(tab => [tabIdentity(tab), tab]))
		tabsEl.textContent = ''
		for (const section of tabGroupComposition().strip) tabsEl.append(createStripSection(section, byId))
		restoreFocusedGroupHeader(tabsEl, focusedHeader)
	}

	function setGroupCollapsed(groupId: string, surface: TabGroupSurface, collapsed: boolean): void {
		if (!placementHydrated) return
		void placement.execute({ type: 'set-collapsed', groupId, surface, collapsed })
	}

	function changeGroupColor(groupId: string, color: TabGroupColor): void {
		void helm.sessions.groups
			.setColor(groupId, color)
			.then(() => loadTabGroups())
			.catch(() => loadTabGroups())
	}

	function loadTabGroups(): void {
		const version = ++tabGroupsVersion
		void helm.sessions.groups
			.list()
			.then(groups => {
				if (version !== tabGroupsVersion) return
				if (placementHydrated) reconcilePlacementGroups(groups)
				else {
					tabGroups = groups
					renderTabGroups()
					updateBackgroundUi()
				}
			})
			.catch(() => {})
	}

	/**
	 * Render the label + tooltip from tab state. Unpinned: label = normalized
	 * title, tooltip = raw title when normalization changed it (today's behavior).
	 * Pinned: label = customName, tooltip = the live OSC title (raw preferred) so
	 * the underlying shell/program identity stays one hover away.
	 */
	function renderTabLabel(tab: Tab): void {
		const text = displayName(tab)
		tab.labelEl.textContent = text
		const state = tab.agentRunning ? 'Running' : tab.agentAttention ? 'Run finished — unchecked' : null
		tab.tabButton.setAttribute('aria-label', state ? `${text} — ${state}` : text)
		const tip = tab.customName !== null ? (tab.oscRaw ?? tab.oscTitle ?? (tab.titleRaw || tab.title)) : tab.titleRaw
		if (tip && tip !== text) tab.labelEl.title = tip
		else tab.labelEl.removeAttribute('title')
	}

	function renderTabAgentState(tab: Tab): void {
		tab.runningEl.hidden = !tab.agentRunning && !tab.agentAttention
		if (tab.agentAttention) {
			setActivityIndicatorState(tab.runningEl, 'attention', 'Run finished — open tab to clear')
		} else {
			setActivityIndicatorState(tab.runningEl, 'progress', 'Running')
		}
		renderTabLabel(tab)
		// Real OSC state changes can change a collapsed group's representative.
		// Callers return before this function for idempotent active keepalives.
		renderTabGroups()
		if (tab.parked) updateBackgroundUi()
	}

	function persistTabActivity(tab: Tab): void {
		if (tab.sessionId)
			helm.sessions.setActivity(tab.sessionId, { agentRunning: tab.agentRunning, agentAttention: tab.agentAttention })
	}

	function setTabAgentAttention(tab: Tab, attention: boolean): void {
		if (tab.agentAttention === attention) return
		tab.agentAttention = attention
		persistTabActivity(tab)
		renderTabAgentState(tab)
	}

	function clearTabAgentAttention(tab: Tab): void {
		setTabAgentAttention(tab, false)
	}

	function setTabAgentRunning(tab: Tab, running: boolean): void {
		if (tab.agentRunning === running) return
		const wasRunning = tab.agentRunning
		tab.agentRunning = running
		if (running) tab.agentAttention = false
		else {
			tab.agentAttention = shouldMarkTerminalCompletion({
				wasRunning,
				closed: tab.closed,
				tabSelected: activeTab === tab,
				windowFocused: document.hasFocus(),
			})
		}
		persistTabActivity(tab)
		renderTabAgentState(tab)
	}

	// ---------- manual rename (double-click a tab / context-menu "Rename…") ----------
	// A committed name PINS the tab (registry customName): OSC never overwrites
	// it, it survives relaunch and park/restore. An empty commit unpins — OSC
	// title following resumes. Spec: docs/design-system.md §3.14 (tab labels).

	function commitCustomName(tab: Tab, name: string | null): void {
		const trimmed = (name ?? '').trim().slice(0, 200)
		tab.customName = trimmed === '' ? null : trimmed
		if (tab.sessionId) helm.sessions.setCustomName(tab.sessionId, tab.customName)
		if (tab.customName === null && tab.oscTitle !== null) {
			// Unpin resumes OSC following from the live truth seen while pinned.
			tab.title = tab.oscTitle
			tab.titleRaw = tab.oscRaw ?? ''
			if (tab.sessionId) helm.sessions.setTitle(tab.sessionId, tab.title)
		}
		renderTabLabel(tab)
		if (tab.parked) updateBackgroundUi()
	}

	function startRename(tab: Tab): void {
		if (tab.closed || tab.tabButton.querySelector('.tab-rename')) return
		const input = document.createElement('input')
		input.className = 'tab-rename'
		input.type = 'text'
		input.value = displayName(tab)
		input.setAttribute('aria-label', 'Rename terminal')
		tab.labelEl.hidden = true
		tab.tabButton.insertBefore(input, tab.labelEl)
		let done = false
		const finish = (commit: boolean): void => {
			if (done) return
			done = true
			const value = input.value
			input.remove()
			tab.labelEl.hidden = false
			// Unchanged value is a no-op — a stray double-click + click-away must
			// not silently pin the current OSC title.
			if (commit && value.trim() !== displayName(tab).trim()) commitCustomName(tab, value)
			if (tab === activeTab) tab.term.focus()
		}
		input.addEventListener('keydown', event => {
			event.stopPropagation() // keep ⌘1-9/global capture handlers out of the field
			if (event.key === 'Enter') finish(true)
			else if (event.key === 'Escape') finish(false)
		})
		input.addEventListener('blur', () => finish(true))
		// Don't let the click that opened the editor re-activate/re-open things.
		input.addEventListener('pointerdown', event => event.stopPropagation())
		input.focus()
		input.select()
	}

	// Vertical inset flexes so the grid packs the MAXIMUM rows that fit (§3.14):
	// with a fixed 14px inset pair, the integer-row remainder (0..cellHeight-1)
	// stacked on the bottom inset left up to ~31px blank below the last line —
	// more than a whole row, which read as "one line is missing". Rows are now
	// computed against the minimum inset (6px); the leftover splits into
	// top/bottom insets capped at the nominal 14px (any excess beyond that stays
	// at the bottom, exactly like the old remainder).
	const TERM_VINSET_NOMINAL = 14
	const TERM_VINSET_MIN = 6

	/** xterm core render service (same private seam FitAddon reads/uses). */
	interface CoreRenderAccess {
		_core: {
			_renderService: {
				dimensions: { css: { cell: { height: number } } }
				clear(): void
			}
		}
	}

	function cellHeightOf(term: Terminal): number {
		return (term as unknown as CoreRenderAccess)._core._renderService.dimensions.css.cell.height
	}

	function fitTab(tab: Tab): void {
		// Hidden/zero-size holders measure 0x0 — fitting then would clamp the grid
		// to FitAddon's 2x1 floor. DEFER instead of silently skipping: retry on the
		// next frames until the holder is measurable (first-paint guard — an open
		// before layout settles must not leave a mis-sized terminal until a manual
		// resize). Parked/backgrounded holders stay 0x0 by design; activate()'s rAF
		// refits those once visible, so the retry loop only chases the ACTIVE tab.
		if (tab.holder.clientWidth === 0 || tab.holder.clientHeight === 0) {
			scheduleFitRetry(tab)
			return
		}
		// Cols come from FitAddon (width math unchanged — vertical padding never
		// affects the mount's width); rows are packed against the flexed inset.
		const proposal = tab.fit.proposeDimensions()
		const cellHeight = cellHeightOf(tab.term)
		if (!proposal || Number.isNaN(proposal.cols) || !(cellHeight > 0)) {
			scheduleFitRetry(tab) // renderer metrics not ready yet (fresh open)
			return
		}
		// clientHeight = padding box (border-box, no border): the full pane height.
		const paneHeight = tab.holder.clientHeight
		const rows = Math.max(2, Math.floor((paneHeight - 2 * TERM_VINSET_MIN) / cellHeight))
		const leftover = Math.max(0, paneHeight - Math.ceil(rows * cellHeight))
		const padTop = Math.max(TERM_VINSET_MIN, Math.min(TERM_VINSET_NOMINAL, Math.floor(leftover / 2)))
		const padBottom = Math.max(TERM_VINSET_MIN, leftover - padTop)
		tab.holder.style.paddingTop = `${padTop}px`
		tab.holder.style.paddingBottom = `${padBottom}px`
		const cols = Math.max(2, proposal.cols)
		if (tab.term.cols !== cols || tab.term.rows !== rows) {
			// Mirror FitAddon.fit(): clear the renderer before resizing, else the
			// DOM renderer can leave artifacts of the old grid.
			;(tab.term as unknown as CoreRenderAccess)._core._renderService.clear()
			tab.term.resize(cols, rows)
		}
		scheduleScrollbarSync(tab)
	}

	function scheduleFitRetry(tab: Tab): void {
		if (tab.fitRetryPending || tab.closed) return
		tab.fitRetryPending = true
		requestAnimationFrame(() => {
			tab.fitRetryPending = false
			// Only the active tab is meant to be measurable; a tab hidden/parked
			// since the skip gets its deferred fit from activate() instead.
			if (disposed || tab.closed || tab !== activeTab) return
			fitTab(tab)
		})
	}

	function fitActive(): void {
		if (activeTab) fitTab(activeTab)
	}

	/**
	 * Force the pty to the terminal's CURRENT fitted size after spawn/reattach.
	 * fit.fit() only calls term.resize when dims changed, and term.onResize only
	 * fires on change — so an equal-size fit sends nothing, and an equal-size pty
	 * resize emits no SIGWINCH. For restored dtach sessions the REMOTE app's size
	 * belief is stale from the previous run, so `nudge` forces a real WINCH pair
	 * (cols-1 then cols): two TIOCSWINSZ changes → dtach client SIGWINCH → client
	 * pushes its winsize to the session master → remote app relearns and relayouts.
	 */
	function syncPtySize(tab: Tab, spawnCols: number, spawnRows: number, nudge: boolean): void {
		if (tab.ptyId === null) return
		const { cols, rows } = tab.term
		if (cols !== spawnCols || rows !== spawnRows) {
			// Fitted size drifted while the spawn was in flight (onResize was not
			// attached yet, so the update was lost) — replay it.
			helm.pty.resize(tab.ptyId, cols, rows)
		} else if (nudge && cols > 2) {
			helm.pty.resize(tab.ptyId, cols - 1, rows)
			helm.pty.resize(tab.ptyId, cols, rows)
		}
	}

	// ---------- overlay scrollbar (§3.14) ----------
	// xterm 6 scrolls through a monaco SmoothScrollableElement whose track is
	// inline-sized to rows*cellHeight starting at the screen's top — inside the
	// padded holder it can never reach the pane edges, and its square slider reads
	// as a generic web scrollbar. Helm hides it (styles.css) and renders its own
	// macOS-style overlay: a track spanning the FULL pane height with a pill
	// thumb. Pure overlay — it lives inside FitAddon's fixed 14px scrollbar
	// reserve, so it never reserves layout space or shifts terminal columns
	// (columns are identical with or without scrollback).

	const THUMB_MIN_PX = 24

	function thumbMetrics(tab: Tab): { trackHeight: number; thumbHeight: number; maxTop: number } {
		const trackHeight = tab.scrollbar.clientHeight
		const thumbHeight = Math.max(
			THUMB_MIN_PX,
			Math.round((trackHeight * tab.term.rows) / tab.term.buffer.active.length),
		)
		return { trackHeight, thumbHeight, maxTop: Math.max(0, trackHeight - thumbHeight) }
	}

	function syncScrollbar(tab: Tab): void {
		// xterm's model mutates while a synchronized redraw is still hidden behind
		// the last complete visual frame. Keep the matching scrollbar stable too.
		if (tab.frameOutputPending) return
		const buffer = tab.term.buffer.active
		// Alt-screen apps (vim/less) own the whole viewport — no scrollbar, like
		// Terminal.app. baseY === 0 = nothing has scrolled out yet.
		if (buffer.type === 'alternate' || buffer.baseY === 0) {
			tab.scrollbar.hidden = true
			return
		}
		tab.scrollbar.hidden = false
		const { trackHeight, thumbHeight, maxTop } = thumbMetrics(tab)
		if (trackHeight === 0) {
			// Hidden holder measures 0 — restore/activate refits and resyncs.
			tab.scrollbar.hidden = true
			return
		}
		const top = Math.round((maxTop * buffer.viewportY) / buffer.baseY)
		tab.thumb.style.height = `${thumbHeight}px`
		tab.thumb.style.transform = `translateY(${Math.min(maxTop, Math.max(0, top))}px)`
	}

	function scheduleScrollbarSync(tab: Tab): void {
		// rAF-coalesced: onWriteParsed can fire per chunk on the pty:data path —
		// one style write per frame, never per chunk (§6.2).
		if (tab.scrollSyncPending || tab.closed) return
		tab.scrollSyncPending = true
		requestAnimationFrame(() => {
			tab.scrollSyncPending = false
			if (!disposed && !tab.closed) syncScrollbar(tab)
		})
	}

	function attachScrollbarInput(tab: Tab): void {
		tab.thumb.addEventListener('pointerdown', down => {
			if (down.button !== 0) return
			down.preventDefault()
			down.stopPropagation()
			tab.thumb.setPointerCapture(down.pointerId)
			tab.thumb.classList.add('active')
			const grabLine = tab.term.buffer.active.viewportY
			const startY = down.clientY
			const onMove = (move: PointerEvent): void => {
				const buffer = tab.term.buffer.active
				const { maxTop } = thumbMetrics(tab)
				if (maxTop <= 0) return
				const line = Math.round(grabLine + ((move.clientY - startY) * buffer.baseY) / maxTop)
				tab.term.scrollToLine(Math.min(buffer.baseY, Math.max(0, line)))
			}
			const onUp = (): void => {
				tab.thumb.classList.remove('active')
				tab.thumb.removeEventListener('pointermove', onMove)
				tab.thumb.removeEventListener('pointerup', onUp)
				tab.thumb.removeEventListener('pointercancel', onUp)
			}
			tab.thumb.addEventListener('pointermove', onMove)
			tab.thumb.addEventListener('pointerup', onUp)
			tab.thumb.addEventListener('pointercancel', onUp)
		})
		// Track click: macOS "jump to the spot that's clicked" — center the thumb
		// on the pointer.
		tab.scrollbar.addEventListener('pointerdown', event => {
			if (event.target !== tab.scrollbar || event.button !== 0) return
			event.preventDefault()
			const buffer = tab.term.buffer.active
			const { thumbHeight, maxTop } = thumbMetrics(tab)
			if (maxTop <= 0) return
			const top = Math.min(maxTop, Math.max(0, event.offsetY - thumbHeight / 2))
			tab.term.scrollToLine(Math.round((top * buffer.baseY) / maxTop))
		})
	}

	// ---------- buffer snapshots (restore-before-attach) ----------
	// dtach preserves the PROCESS, not the SCREEN: a reattached session renders
	// nothing until new output, so restored tabs used to come back black. Each
	// session-backed tab serializes its buffer (colors + scrollback tail) and main
	// persists it (<userData>/buffers, app/src/buffers.ts); reattach writes the
	// snapshot into the fresh xterm BEFORE the live pty stream, and the normal
	// fit → syncPtySize WINCH nudge redraws the prompt/TUI in place under it — no
	// marker line, the natural redraw is the seam.

	/** Target snapshot size. The ladder steps the serialized scrollback down until
	 *  the output fits — front-truncating VT output would shear escape sequences. */
	const SNAPSHOT_MAX_CHARS = 200_000
	const SNAPSHOT_SCROLLBACK_LADDER = [2000, 500, 120, 0]
	const SNAPSHOT_AUTOSAVE_MS = 10_000

	function serializeSnapshot(tab: Tab): string | null {
		for (const scrollback of SNAPSHOT_SCROLLBACK_LADDER) {
			let output: string
			try {
				// Alt-screen content is excluded: a live TUI repaints itself on the
				// reattach WINCH; replaying its stale frame first would only flash.
				output = tab.serialize.serialize({ scrollback, excludeAltBuffer: true })
			} catch {
				return null
			}
			if (output.length <= SNAPSHOT_MAX_CHARS) return output
		}
		return null
	}

	function saveSnapshot(tab: Tab): void {
		if (tab.transferring) return
		// Never persist xterm's transient clear/partial replay. Leave dirty set so
		// the next autosave captures the completed synchronized frame.
		if (tab.frameOutputPending) return
		tab.dirty = false
		if (!tab.sessionId) return
		const snapshot = serializeSnapshot(tab)
		// Empty serialize (nothing ever painted) must not clobber a good snapshot.
		if (snapshot) helm.buffers.save(tab.sessionId, snapshot)
	}

	function saveAllSnapshots(): void {
		for (const tab of [...tabs, ...parked]) {
			if (!tab.closed && tab.ptyId !== null && tab.sessionId) saveSnapshot(tab)
		}
	}

	function transferredTab(sessionId: string): Tab | null {
		return [...tabs, ...parked].find(tab => tab.sessionId === sessionId && !tab.closed) ?? null
	}

	/** Resolve only after xterm parsed every output chunk queued before this barrier. */
	function waitForTerminalWrites(tab: Tab): Promise<void> {
		return new Promise(resolve => tab.term.write('', resolve))
	}

	function disposeTransferredTab(tab: Tab): void {
		tab.closed = true
		runtimeById.delete(tab.visualId)
		inventoryPlacement(tab, 'remove')
		tab.outputGuard.abort()
		tab.progressTracker.clear()
		// Placement inventory removal synchronously reprojects order/selection caches.
		tab.term.dispose()
		tab.holder.remove()
		tab.tabButton.remove()
		renderTabGroups()
		syncEmptyState()
		updateBackgroundUi()
	}

	const terminalTransferController = new TerminalTransferRendererController({
		currentProfileToken: () => helm.terminalTransfer.profileToken(),
		freeze(sessionId) {
			const tab = transferredTab(sessionId)
			if (!tab || tab.transferring) throw new Error('terminal is unavailable')
			tab.transferring = true
			tab.term.options.disableStdin = true
			closeTabMenu()
		},
		async saveSnapshot(sessionId) {
			const tab = transferredTab(sessionId)
			if (!tab || !tab.sessionId) return { snapshotFlushed: false }
			await waitForTerminalWrites(tab)
			if (tab.frameOutputPending) return { snapshotFlushed: false }
			const snapshot = serializeSnapshot(tab)
			if (!snapshot) return { snapshotFlushed: false }
			tab.dirty = false
			return { snapshotFlushed: await helm.buffers.saveAndAck(sessionId, snapshot) }
		},
		metadata(sessionId) {
			const tab = transferredTab(sessionId)
			return tab
				? {
						title: tab.title,
						titleRaw: tab.titleRaw,
						oscTitle: tab.oscTitle,
						oscRaw: tab.oscRaw,
						customName: tab.customName,
						agentRunning: tab.agentRunning,
						agentAttention: tab.agentAttention,
					}
				: null
		},
		dispose(sessionId) {
			const tab = transferredTab(sessionId)
			if (!tab) throw new Error('terminal disappeared before transfer commit')
			disposeTransferredTab(tab)
		},
		unfreeze(sessionId) {
			const tab = transferredTab(sessionId)
			if (!tab) throw new Error('terminal disappeared before rollback')
			tab.transferring = false
			tab.term.options.disableStdin = false
		},
	})

	const unsubscribeTerminalTransfer = helm.terminalTransfer.onEvent(event => {
		if (disposed) return
		void (async () => {
			const request = {
				transactionId: event.transactionId,
				sessionId: event.sessionId,
				profileToken: event.profileToken,
			}
			const result =
				event.type === 'prepare'
					? await terminalTransferController.prepare(request)
					: event.type === 'checkpoint'
						? await terminalTransferController.checkpoint(request)
						: event.type === 'commit'
							? await terminalTransferController.commit(request)
							: await terminalTransferController.rollback(request)
			await helm.terminalTransfer.ack(event, result)
		})()
	})

	// Throttled autosave: only tabs whose pty produced output since the last save.
	const snapshotAutosave = setInterval(() => {
		for (const tab of [...tabs, ...parked]) {
			if (!tab.closed && !tab.transferring && tab.dirty && tab.ptyId !== null && tab.sessionId) saveSnapshot(tab)
		}
	}, SNAPSHOT_AUTOSAVE_MS)

	// Quit/window-close: main intercepts the close, asks for one final flush
	// (before the xterm instances are torn down), and resumes the close on the ack.
	const unsubscribeBuffersFlush = helm.buffers.onFlush(() => {
		if (disposed) return
		saveAllSnapshots()
		helm.buffers.flushed()
	})

	/** dtach attach.c writes cursor-home + erase-below to its terminal the moment
	 *  a client attaches — BEFORE the WINCH redraw it requests from the program.
	 *  Left alone it erases the just-restored snapshot (the black-terminal bug in
	 *  its second form). Strip exactly that one leading sequence from the spawn's
	 *  first output; anything else (including a split chunk) passes through intact. */
	const ATTACH_CLEAR = '\x1b[H\x1b[J'

	function filterAttachClear(tab: Tab, data: string): string {
		const buffered = tab.attachClearHeld + data
		if (buffered.length < ATTACH_CLEAR.length && ATTACH_CLEAR.startsWith(buffered)) {
			// Whole chunk is still a prefix of the clear — hold it, emit nothing yet.
			tab.attachClearHeld = buffered
			return ''
		}
		tab.attachClearPending = false
		tab.attachClearHeld = ''
		return buffered.startsWith(ATTACH_CLEAR) ? buffered.slice(ATTACH_CLEAR.length) : buffered
	}

	function freezeTerminalFrame(tab: Tab): void {
		tab.frameOutputPending = true
		if (tab.frameFreeze) return
		const screen = tab.holder.querySelector('.xterm-screen')
		if (!(screen instanceof HTMLElement) || !screen.parentElement) return
		const freeze = screen.cloneNode(true)
		if (!(freeze instanceof HTMLElement)) return
		freeze.classList.add('term-frame-freeze')
		freeze.setAttribute('aria-hidden', 'true')
		// cloneNode does not copy canvas pixels. The current renderer is DOM-based,
		// but preserving canvases keeps this guard correct if xterm changes renderer.
		const sourceCanvases = screen.querySelectorAll('canvas')
		const frozenCanvases = freeze.querySelectorAll('canvas')
		for (let index = 0; index < Math.min(sourceCanvases.length, frozenCanvases.length); index += 1) {
			const source = sourceCanvases.item(index)
			const target = frozenCanvases.item(index)
			const context = target.getContext('2d')
			if (context) context.drawImage(source, 0, 0)
		}
		screen.parentElement.append(freeze)
		tab.frameFreeze = freeze
	}

	function unfreezeTerminalFrame(tab: Tab): void {
		tab.frameOutputPending = false
		tab.frameFreeze?.remove()
		tab.frameFreeze = null
		scheduleScrollbarSync(tab)
	}

	function scheduleTerminalFrameRelease(tab: Tab, release: () => void): () => void {
		const lastRow = Math.max(0, tab.term.rows - 1)
		if (!tab.frameFreeze || !tab.holder.classList.contains('active')) {
			release()
			return () => {}
		}
		let cancelled = false
		const rendered = tab.term.onRender(({ start, end }) => {
			if (start > 0 || end < Math.max(0, tab.term.rows - 1)) return
			rendered.dispose()
			if (!cancelled) release()
		})
		// Parsing and painting are separate xterm queues. Request a complete viewport
		// paint after the closing marker parsed and keep the old frame until onRender.
		tab.term.refresh(0, lastRow)
		return () => {
			cancelled = true
			rendered.dispose()
		}
	}

	function activate(tab: Tab): void {
		if (placementHydrated && !applyingPlacementSnapshot) {
			void placement.execute({ type: 'select', id: placementId(tab) })
			return
		}
		activeTab = tab
		clearTabAgentAttention(tab)
		for (const t of [...tabs, ...parked]) t.holder.classList.toggle('active', t === tab)
		for (const t of tabs) {
			t.tabButton.classList.toggle('active', t === tab)
			t.tabButton.setAttribute('aria-selected', String(t === tab))
		}
		renderTabGroups()
		syncEmptyState()
		updateBackgroundUi()
		// Fit after the holder becomes visible; hidden containers measure as 0x0.
		requestAnimationFrame(() => {
			if (disposed) return
			fitActive()
			// A double-click runs activate (click) before startRename (dblclick):
			// this deferred focus would land on the just-opened rename input and
			// blur-commit it within a frame. The editor owns focus while open.
			if (document.activeElement?.classList.contains('tab-rename')) return
			tab.term.focus()
		})
	}

	// A completion that arrived while Helm was behind another app remains unseen
	// even when its tab was selected; focusing Helm is the user's explicit check.
	const onWindowFocus = () => {
		if (activeTab) clearTabAgentAttention(activeTab)
	}
	window.addEventListener('focus', onWindowFocus)

	function cycleTab(delta: number): void {
		if (tabs.length === 0) return
		const activeIndex = activeTab ? tabs.indexOf(activeTab) : -1
		const current = activeIndex >= 0 ? activeIndex : delta > 0 ? -1 : 0
		const next = tabs[(current + delta + tabs.length) % tabs.length]
		if (next && next !== activeTab) activate(next)
	}

	function closeTab(tab: Tab): void {
		if (groupPointerDrag || tab.closed || tab.transferring) return
		tab.closed = true
		// Snapshot before releasing a synchronized redraw guard: saveSnapshot skips
		// a pending replacement frame, preserving the previous complete snapshot.
		if (tab.ptyId !== null) saveSnapshot(tab)
		tab.outputGuard.abort()
		tab.progressTracker.clear()
		const { title, customName, groupId } = tab
		const shown = customName ?? title
		// Soft close (okena-style): main only DETACHES the pty client and arms a
		// grace timer — the dtach session dies when it fires. The toast's Undo
		// cancels the timer and reattaches the same session as a new tab.
		if (tab.ptyId !== null) {
			void helm.sessions.closeWithGrace(tab.ptyId).then(grace => {
				if (!grace) return // non-persistent pty — already fully killed, nothing to undo
				const toast = showToast({
					message: `${shown} closed`,
					ttlMs: grace.graceMs,
					countdown: true,
					action: {
						label: 'Undo',
						onClick: () => {
							toast.dismiss()
							void helm.sessions.undoClose(grace.sessionId).then(alive => {
								// Undo keeps the rename pin — it reattaches the same session.
								if (alive) void createTerminal({ sessionId: grace.sessionId, title, customName, groupId })
							})
						},
					},
				})
			})
		}
		tab.term.dispose()
		tab.holder.remove()
		tab.tabButton.remove()
		inventoryPlacement(tab, 'remove')
		runtimeById.delete(tab.visualId)
		syncEmptyState()
	}

	// ---------- background terminals (park / restore / kill + strip control) ----------
	// iTerm2 "bury session" analog. A parked tab leaves the strip; its Terminal
	// stays mounted in the hidden holder and the pty stays attached, so output
	// keeps landing in scrollback. The strip-right stack button (visible only when
	// parked.length > 0) opens the popover listing them.

	function parkTab(tab: Tab, _allowDuringGroupSettle = false): void {
		if (tab.closed || tab.parked || tab.transferring || !placementHydrated || applyingPlacementSnapshot) return
		// Buffer snapshots are runtime-owned; foreground/Background ownership is placement-owned.
		if (tab.ptyId !== null) saveSnapshot(tab)
		void placement.execute({ type: 'park', id: placementId(tab) })
	}

	/** Open the terminal pane without changing persisted Background ownership. */
	function openParked(tab: Tab): void {
		if (!parked.includes(tab) || tab.closed || !placementHydrated || applyingPlacementSnapshot) return
		closeBackgroundPopover()
		void placement.execute({ type: 'open-background', id: placementId(tab) })
	}

	/** Move back to the strip end, focused and refit. */
	function restoreParked(tab: Tab, _targetOrder?: readonly Tab[]): void {
		if (tab.transferring || !placementHydrated || applyingPlacementSnapshot) return
		void placement.execute({ type: 'restore', id: placementId(tab) })
	}

	/** Popover ✕: grace-close path; Undo restores to the BACKGROUND list, not a tab. */
	function killParkedTab(tab: Tab): void {
		if (groupPointerDrag || tab.transferring) return
		const index = parked.indexOf(tab)
		if (index === -1 || tab.closed) return
		tab.closed = true
		// Same snapshot-before-guard-release rule as closeTab.
		if (tab.ptyId !== null) saveSnapshot(tab)
		tab.outputGuard.abort()
		tab.progressTracker.clear()
		const { title, customName, groupId } = tab
		const shown = customName ?? title
		if (tab.ptyId !== null) {
			void helm.sessions.closeWithGrace(tab.ptyId).then(grace => {
				if (!grace) return
				const toast = showToast({
					message: `${shown} closed`,
					ttlMs: grace.graceMs,
					countdown: true,
					action: {
						label: 'Undo',
						onClick: () => {
							toast.dismiss()
							void helm.sessions.undoClose(grace.sessionId).then(alive => {
								if (alive) void createTerminal({ sessionId: grace.sessionId, title, customName, groupId, parked: true })
							})
						},
					},
				})
			})
		}
		// Exited rows (ptyId null) just remove — the session is already gone.
		tab.term.dispose()
		tab.holder.remove()
		inventoryPlacement(tab, 'remove')
		runtimeById.delete(tab.visualId)
		syncEmptyState()
		updateBackgroundUi()
	}

	let bgOpen = false

	function updateBackgroundUi(): void {
		const empty = parked.length === 0
		const focusWasInPopover = empty && bgPopover.contains(document.activeElement)
		const opened = activeTab?.parked ? activeTab : null
		const openedName = opened ? displayName(opened) : null
		bgToggle.hidden = empty
		bgCurrent.hidden = openedName === null
		bgCurrent.textContent = openedName ?? ''
		bgToggle.title = openedName ? `Background terminals — viewing ${openedName}` : 'Background terminals'
		bgToggle.setAttribute('aria-label', bgToggle.title)
		bgCount.textContent = String(parked.length)
		if (empty) {
			closeBackgroundPopover()
			if (focusWasInPopover) newTabButton.focus()
			return
		}
		if (bgOpen) renderBackgroundRows()
	}

	function renderBackgroundRows(): void {
		// Preserve the row or a disclosure header across activity/title re-renders.
		const focusedHeader = focusedGroupHeader(bgRows)
		const focusedRow = document.activeElement?.closest<HTMLElement>('.bg-row')
		const focusedId = focusedRow?.dataset.tabId ?? null
		bgRows.textContent = ''
		const byId = new Map(parked.map(tab => [tabIdentity(tab), tab]))
		for (const section of tabGroupComposition().background) {
			const sectionEl = document.createElement('section')
			sectionEl.className = `bg-group-section${section.collapsed ? ' collapsed' : ''}`
			sectionEl.dataset.groupId = section.groupId ?? ''
			applyGroupColor(sectionEl, section.color)
			const header = groupHeader(section)
			if (header) sectionEl.append(header)
			const membersEl = document.createElement('div')
			membersEl.className = 'bg-group-members'
			if (section.kind === 'group') membersEl.id = tabGroupMembersId(section.groupId, section.surface)
			membersEl.hidden = section.collapsed
			for (const member of section.members) {
				const tab = byId.get(member.id)
				if (!tab) continue
				const exitedState = tab.exitCode === null ? null : `Exited (${tab.exitCode})`
				const agentState = tab.agentAttention
					? 'Run finished, needs attention'
					: tab.agentRunning
						? 'Agent running'
						: null
				const accessibleState = [exitedState, agentState].filter(Boolean).join(', ')
				const row = document.createElement('div')
				row.className = `bg-row${activeTab === tab ? ' active' : ''}`
				row.dataset.tabId = tabIdentity(tab)

				const open = document.createElement('button')
				open.className = 'bg-open'
				open.title = 'Open and keep in background · Drag to tabs'
				open.setAttribute(
					'aria-label',
					`Open ${displayName(tab)} and keep in background${accessibleState ? ` — ${accessibleState}` : ''}`,
				)
				open.addEventListener('click', () => {
					if (suppressTabClick.has(tab)) return
					openParked(tab)
				})
				open.addEventListener('pointerdown', event => beginBackgroundTabPointerDrag(tab, open, event))

				if (tab.agentRunning || tab.agentAttention) {
					const indicator = createActivityIndicator(
						tab.agentAttention ? 'Run finished — open terminal to clear' : 'Agent running',
						tab.agentAttention ? 'attention' : 'progress',
					)
					indicator.classList.add('bg-activity')
					open.append(indicator)
				}

				const copy = document.createElement('span')
				copy.className = 'bg-open-copy'
				const title = document.createElement('span')
				title.className = `bg-title${exitedState ? ' exited' : ''}`
				title.textContent = displayName(tab) // rename pin shows here too
				copy.append(title)
				if (exitedState) {
					const state = document.createElement('span')
					state.className = 'bg-state'
					state.textContent = exitedState
					copy.append(state)
				}
				open.append(copy)

				const restore = createIconButton({
					label: `Move ${displayName(tab)} to tabs and open`,
					glyph: '⇥',
					glyphClassName: 'bg-action-glyph',
					onClick: () => restoreParked(tab),
				})

				const kill = createIconButton({
					label: `Close ${displayName(tab)}`,
					glyph: '×',
					glyphClassName: 'bg-kill-glyph',
					onClick: () => killParkedTab(tab),
				})

				row.append(open, restore, kill)
				membersEl.appendChild(row)
			}
			sectionEl.appendChild(membersEl)
			bgRows.appendChild(section.kind === 'group' ? sectionEl : membersEl)
		}
		if (focusedId !== null) {
			const row = [...bgRows.querySelectorAll<HTMLElement>('.bg-row')].find(
				candidate => candidate.dataset.tabId === focusedId,
			)
			if (!row?.hidden) row?.querySelector<HTMLElement>('.bg-open')?.focus()
		} else {
			restoreFocusedGroupHeader(bgRows, focusedHeader)
		}
	}

	function onBgOutside(event: PointerEvent): void {
		if (event.target instanceof Node && bgRoot.contains(event.target)) return
		const clickedTitlebar = event.target === topbarDragSpace
		closeBackgroundPopover()
		// A native titlebar target cannot receive DOM focus. Avoid leaving focus in
		// the now-hidden row; ordinary outside controls receive focus after pointerdown.
		if (clickedTitlebar) bgToggle.focus()
	}

	function onBgKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.stopPropagation()
			closeBackgroundPopover()
			bgToggle.focus()
			return
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
		const rows = [...bgRows.querySelectorAll<HTMLElement>('.bg-open')]
		if (rows.length === 0) return
		event.preventDefault()
		const current = rows.indexOf(document.activeElement as HTMLElement)
		const next =
			event.key === 'ArrowDown' ? rows[Math.min(current + 1, rows.length - 1)] : rows[Math.max(current - 1, 0)]
		next?.focus()
	}

	function openBackgroundPopover(): void {
		if (bgOpen || parked.length === 0) return
		closeTabMenu()
		bgOpen = true
		renderBackgroundRows()
		bgPopover.hidden = false
		bgToggle.setAttribute('aria-expanded', 'true')
		// Native Electron drag regions swallow DOM pointer events. While this
		// non-modal popover is open, make only the trailing whitespace a regular
		// hit target so clicking the titlebar dismisses it; closing restores drag.
		topbarDragSpace.classList.add('popover-catcher')
		bgRows.querySelector<HTMLElement>('.bg-open')?.focus()
		document.addEventListener('pointerdown', onBgOutside, true)
		document.addEventListener('keydown', onBgKeydown, true)
	}

	function closeBackgroundPopover(): void {
		if (!bgOpen) return
		bgOpen = false
		bgPopover.hidden = true
		bgToggle.setAttribute('aria-expanded', 'false')
		topbarDragSpace.classList.remove('popover-catcher')
		document.removeEventListener('pointerdown', onBgOutside, true)
		document.removeEventListener('keydown', onBgKeydown, true)
	}

	const onBackgroundToggle = () => {
		if (bgOpen) closeBackgroundPopover()
		else openBackgroundPopover()
	}
	bgToggle.addEventListener('click', onBackgroundToggle)

	// ---------- direct-manipulation tab drag (live reorder / magnetic park) ----------

	type TabDropTarget = 'strip' | 'background' | null

	interface TabPointerDrag {
		tab: Tab
		pointerId: number
		startX: number
		startY: number
		x: number
		y: number
		offsetX: number
		offsetY: number
		originalGroupId: string | null
		placementDrag: PlacementDrag | null
		started: boolean
		preview: HTMLDivElement | null
		dropTarget: TabDropTarget
		dropGroupId: string | null
		frame: number | null
	}

	let tabPointerDrag: TabPointerDrag | null = null
	/** A committed pointer-up keeps its real clone/placeholder until authorization settles. */
	let pendingTabDragSettlement: TabPointerDrag | null = null
	const suppressTabClick = new WeakSet<Tab>()
	const stripReflowAnimations = new WeakMap<HTMLElement, Animation>()

	function reducedMotion(): boolean {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches
	}

	function stripDragUnitKey(unit: StripDragUnit): string | null {
		const first = unit.members[0]
		if (!first) return null
		return first.groupId ? `group:${first.groupId}` : `tab:${tabIdentity(first)}`
	}

	function animateStripReflow(element: HTMLElement, delta: number): void {
		stripReflowAnimations.get(element)?.cancel()
		const animation = element.animate([{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }], {
			duration: 160,
			easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
		})
		stripReflowAnimations.set(element, animation)
		animation.addEventListener('finish', () => {
			if (stripReflowAnimations.get(element) === animation) stripReflowAnimations.delete(element)
		})
	}

	/** Placement snapshot projector: preserve the shared 160ms semantic-unit FLIP. */
	function projectStripOrder(next: readonly Tab[], animate: boolean): boolean {
		if (next.length === tabs.length && next.every((candidate, index) => candidate === tabs[index])) return false
		const previousUnits = new Map(
			stripDragUnitsExcluding('').flatMap(unit => {
				const key = stripDragUnitKey(unit)
				return key === null ? [] : [[key, unit.rect.left] as const]
			}),
		)
		const previousTabs = new Map(tabs.map(candidate => [candidate, candidate.tabButton.getBoundingClientRect().left]))
		tabs.splice(0, tabs.length, ...next)
		renderTabGroups()
		if (animate && !reducedMotion()) {
			const animatedUnits = new Set<string>()
			for (const unit of stripDragUnitsExcluding('')) {
				const key = stripDragUnitKey(unit)
				const previous = key === null ? undefined : previousUnits.get(key)
				if (key === null || previous === undefined) continue
				const delta = previous - unit.element.getBoundingClientRect().left
				if (Math.abs(delta) < 1) continue
				animatedUnits.add(key)
				animateStripReflow(unit.element, delta)
			}
			for (const candidate of tabs) {
				const unitKey = candidate.groupId ? `group:${candidate.groupId}` : `tab:${tabIdentity(candidate)}`
				if (animatedUnits.has(unitKey)) continue
				const previous = previousTabs.get(candidate)
				if (previous === undefined) continue
				const delta = previous - candidate.tabButton.getBoundingClientRect().left
				if (Math.abs(delta) < 1) continue
				animateStripReflow(candidate.tabButton, delta)
			}
		}
		return true
	}

	function positionTabPreview(drag: TabPointerDrag): void {
		if (!drag.preview) return
		const left = drag.x - drag.offsetX
		const top = drag.y - drag.offsetY
		const scale = drag.dropTarget === 'background' ? 0.92 : 1.02
		drag.preview.style.transform = `translate3d(${left}px, ${top}px, 0) scale(${scale})`
	}

	function restoreTabDragOrigin(drag: TabPointerDrag, _animate: boolean): void {
		drag.dropGroupId = drag.originalGroupId
		drag.placementDrag?.reset()
	}

	function stripGroupAtPoint(x: number, y: number): string | null {
		const hit = document.elementFromPoint(x, y)
		const section = hit instanceof Element ? hit.closest<HTMLElement>('.tab-group-section') : null
		return section?.dataset.groupId || null
	}

	function updateTabDragTarget(drag: TabPointerDrag): void {
		const backgroundRect = bgToggle.getBoundingClientRect()
		const overNewTab = pointInExpandedRect(drag.x, drag.y, newTabButton.getBoundingClientRect())
		if (!overNewTab && pointInExpandedRect(drag.x, drag.y, backgroundRect, 8)) {
			drag.dropTarget = 'background'
			drag.placementDrag?.project({ surface: 'background', index: parked.length })
			bgToggle.classList.add('drag-over')
			drag.preview?.classList.add('over-background')
			positionTabPreview(drag)
			return
		}

		bgToggle.classList.remove('drag-over')
		drag.preview?.classList.remove('over-background')
		const stripRect = tabsEl.getBoundingClientRect()
		if (!pointInExpandedRect(drag.x, drag.y, stripRect, 10)) {
			drag.dropTarget = null
			restoreTabDragOrigin(drag, true)
			positionTabPreview(drag)
			return
		}

		drag.dropTarget = 'strip'
		const targetGroupId = drag.tab.sessionId ? stripGroupAtPoint(drag.x, drag.y) : drag.originalGroupId
		const targetPeers = tabs.filter(tab => tab !== drag.tab && tab.groupId === targetGroupId)
		const visiblePeerRects = targetPeers
			.map(tab => tab.tabButton.getBoundingClientRect())
			.filter(rect => rect.width > 0)
		const peerInsertionIndex =
			visiblePeerRects.length === targetPeers.length
				? stripDropInsertionIndex(drag.x, visiblePeerRects)
				: targetPeers.length
		const remainingTabs = tabs.filter(tab => tab !== drag.tab)
		const fallbackInsertionIndex = stripDropInsertionIndex(
			drag.x,
			remainingTabs.map(tab => tab.tabButton.getBoundingClientRect()),
		)
		const insertionIndex = groupDropInsertionIndex(
			tabs,
			drag.tab,
			targetGroupId,
			peerInsertionIndex,
			fallbackInsertionIndex,
		)
		drag.dropGroupId = targetGroupId
		// groupDropInsertionIndex is anchored in the pre-removal strip. Placement
		// requires post-removal raw terminal index, so subtract the dragged tab when
		// its original slot precedes the anchor.
		const originalIndex = tabs.indexOf(drag.tab)
		const postRemovalIndex = insertionIndex - (originalIndex >= 0 && originalIndex < insertionIndex ? 1 : 0)
		drag.placementDrag?.project({ surface: 'strip', index: postRemovalIndex, groupId: targetGroupId })
		positionTabPreview(drag)
	}

	function tabDragFrame(): void {
		const drag = tabPointerDrag
		if (!drag?.started) return
		if (drag.dropTarget === 'strip') {
			const stripRect = tabsEl.getBoundingClientRect()
			const delta = tabStripAutoScrollDelta(
				drag.x,
				stripRect,
				tabsEl.scrollLeft,
				tabsEl.scrollWidth,
				tabsEl.clientWidth,
			)
			if (delta !== 0) {
				tabsEl.scrollLeft += delta
				updateTabDragTarget(drag)
			}
		}
		drag.frame = requestAnimationFrame(tabDragFrame)
	}

	function startTabPointerDrag(drag: TabPointerDrag): void {
		drag.placementDrag = placement.beginDrag({ type: 'terminal', id: placementId(drag.tab) })
		if (!drag.placementDrag.project({ surface: 'strip', index: tabs.indexOf(drag.tab) }).ok) return
		drag.started = true
		closeTabMenu()
		closeBackgroundPopover()
		const rect = drag.tab.tabButton.getBoundingClientRect()
		const preview = drag.tab.tabButton.cloneNode(true) as HTMLDivElement
		preview.className = 'tab tab-drag-preview'
		preview.setAttribute('aria-hidden', 'true')
		preview.style.width = `${rect.width}px`
		document.body.appendChild(preview)
		drag.preview = preview
		drag.tab.tabButton.classList.add('drag-placeholder')
		renderTabGroups()
		document.body.classList.add('tab-dragging')
		bgToggle.hidden = false
		bgToggle.classList.add('drag-ready')
		bgToggle.title = 'Move to background'
		positionTabPreview(drag)
		updateTabDragTarget(drag)
		drag.frame = requestAnimationFrame(tabDragFrame)
	}

	function removeTabPointerListeners(drag: TabPointerDrag): void {
		document.removeEventListener('pointermove', onTabPointerMove)
		document.removeEventListener('pointerup', onTabPointerUp)
		document.removeEventListener('pointercancel', onTabPointerCancel)
		document.removeEventListener('keydown', onTabDragKeydown, true)
		window.removeEventListener('blur', onTabDragBlur)
		try {
			if (drag.tab.tabButton.hasPointerCapture(drag.pointerId)) drag.tab.tabButton.releasePointerCapture(drag.pointerId)
		} catch {
			// synthetic screenshot drag / element removed mid-gesture
		}
	}

	function settleTabPreview(drag: TabPointerDrag, target: DOMRect | null, intoBackground: boolean): void {
		const preview = drag.preview
		const cleanup = () => {
			preview?.remove()
			drag.tab.tabButton.classList.remove('drag-placeholder')
			if (pendingTabDragSettlement === drag) pendingTabDragSettlement = null
		}
		if (disposed || !preview || !target || reducedMotion()) {
			cleanup()
			return
		}
		const left = drag.x - drag.offsetX
		const top = drag.y - drag.offsetY
		const destinationX = intoBackground ? target.left + (target.width - preview.offsetWidth) / 2 : target.left
		const destinationY = intoBackground ? target.top + (target.height - preview.offsetHeight) / 2 : target.top
		try {
			const animation = preview.animate(
				[
					{ transform: `translate3d(${left}px, ${top}px, 0) scale(${intoBackground ? 0.92 : 1.02})`, opacity: 1 },
					{
						transform: `translate3d(${destinationX}px, ${destinationY}px, 0) scale(${intoBackground ? 0.72 : 1})`,
						opacity: intoBackground ? 0 : 1,
					},
				],
				{ duration: intoBackground ? 140 : 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
			)
			animation.addEventListener('finish', cleanup, { once: true })
			animation.addEventListener('cancel', cleanup, { once: true })
		} catch {
			// A tab/workspace can disappear between final target lookup and animation.
			cleanup()
		}
	}

	function visibleElementTarget(element: HTMLElement | null): DOMRect | null {
		if (!element?.isConnected) return null
		const rect = element.getBoundingClientRect()
		return rect.width > 0 && rect.height > 0 ? rect : null
	}

	function connectedTabTarget(tab: Tab): DOMRect | null {
		if (tab.closed) return null
		const tabTarget = visibleElementTarget(tab.tabButton)
		if (tabTarget || !tab.groupId) return tabTarget
		// A collapsed group's member buttons stay mounted inside display:none.
		// Settle into its visible header instead of flying toward their 0×0 rect.
		for (const header of tabsEl.querySelectorAll<HTMLElement>('[data-tab-group-header]')) {
			if (header.dataset.groupId === tab.groupId && header.dataset.surface === 'strip')
				return visibleElementTarget(header)
		}
		return null
	}

	function connectedDropTarget(drag: TabPointerDrag): DOMRect | null {
		return drag.dropTarget === 'background' ? visibleElementTarget(bgToggle) : connectedTabTarget(drag.tab)
	}

	async function commitTabDrag(drag: TabPointerDrag): Promise<boolean> {
		// Membership and order are carried in the same PlacementDrag projection.
		try {
			return (await drag.placementDrag?.commit())?.ok === true
		} catch {
			return false
		}
	}

	function finishTabPointerDrag(cancelled: boolean): void {
		const drag = tabPointerDrag
		if (!drag) return
		tabPointerDrag = null
		removeTabPointerListeners(drag)
		if (drag.frame !== null) cancelAnimationFrame(drag.frame)
		if (!drag.started) return

		suppressTabClick.add(drag.tab)
		setTimeout(() => suppressTabClick.delete(drag.tab), 0)
		const acceptedDrop = !cancelled && drag.dropTarget !== null
		if (!acceptedDrop) {
			restoreTabDragOrigin(drag, true)
			drag.placementDrag?.cancel()
		}
		document.body.classList.remove('tab-dragging')
		bgToggle.classList.remove('drag-ready', 'drag-over')
		bgToggle.title = 'Background terminals'
		updateBackgroundUi()
		if (!acceptedDrop) {
			settleTabPreview(drag, connectedTabTarget(drag.tab), false)
			return
		}
		// Keep the live projection, clone, and placeholder intact while main authorizes
		// the durable placement. The resolved snapshot renders the connected target.
		pendingTabDragSettlement = drag
		void commitTabDrag(drag).then(accepted => {
			if (accepted) settleTabPreview(drag, connectedDropTarget(drag), drag.dropTarget === 'background')
			else settleTabPreview(drag, connectedTabTarget(drag.tab), false)
		})
	}

	function onTabPointerMove(event: PointerEvent): void {
		const drag = tabPointerDrag
		if (!drag || event.pointerId !== drag.pointerId) return
		drag.x = event.clientX
		drag.y = event.clientY
		if (!drag.started) {
			if (!dragThresholdExceeded(drag.startX, drag.startY, drag.x, drag.y)) return
			startTabPointerDrag(drag)
		} else {
			updateTabDragTarget(drag)
		}
		event.preventDefault()
	}

	function onTabPointerUp(event: PointerEvent): void {
		const drag = tabPointerDrag
		if (!drag || event.pointerId !== drag.pointerId) return
		drag.x = event.clientX
		drag.y = event.clientY
		if (drag.started) updateTabDragTarget(drag)
		finishTabPointerDrag(false)
	}

	function onTabPointerCancel(event: PointerEvent): void {
		if (tabPointerDrag && event.pointerId === tabPointerDrag.pointerId) finishTabPointerDrag(true)
	}

	function onTabDragKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || !tabPointerDrag) return
		event.preventDefault()
		finishTabPointerDrag(true)
	}

	function onTabDragBlur(): void {
		if (tabPointerDrag) finishTabPointerDrag(true)
	}

	function createTabPointerDrag(tab: Tab, pointerId: number, x: number, y: number): TabPointerDrag {
		const rect = tab.tabButton.getBoundingClientRect()
		return {
			tab,
			pointerId,
			startX: x,
			startY: y,
			x,
			y,
			offsetX: x - rect.left,
			offsetY: y - rect.top,
			originalGroupId: tab.groupId,
			placementDrag: null,
			started: false,
			preview: null,
			dropTarget: null,
			dropGroupId: tab.groupId,
			frame: null,
		}
	}

	function beginTabPointerDrag(tab: Tab, event: PointerEvent): void {
		if (
			tabPointerDrag ||
			backgroundTabPointerDrag ||
			groupPointerDrag ||
			event.button !== 0 ||
			tab.closed ||
			tab.parked ||
			tab.tabButton.querySelector('.tab-rename') ||
			(event.target instanceof Element && event.target.closest('.tab-close, .tab-rename'))
		) {
			return
		}
		tabPointerDrag = createTabPointerDrag(tab, event.pointerId, event.clientX, event.clientY)
		tab.tabButton.setPointerCapture(event.pointerId)
		document.addEventListener('pointermove', onTabPointerMove, { passive: false })
		document.addEventListener('pointerup', onTabPointerUp)
		document.addEventListener('pointercancel', onTabPointerCancel)
		document.addEventListener('keydown', onTabDragKeydown, true)
		window.addEventListener('blur', onTabDragBlur)
	}

	interface BackgroundTabPointerDrag {
		tab: Tab
		source: HTMLButtonElement
		pointerId: number
		startX: number
		startY: number
		x: number
		y: number
		offsetX: number
		offsetY: number
		placementDrag: PlacementDrag | null
		started: boolean
		projected: boolean
		preview: HTMLDivElement | null
		dropTarget: 'strip' | null
		dropUnitIndex: number
		frame: number | null
	}

	let backgroundTabPointerDrag: BackgroundTabPointerDrag | null = null

	function createTabStripProjection(tab: Tab, className = '', forceActive = false): HTMLDivElement {
		const clone = tab.tabButton.cloneNode(true) as HTMLDivElement
		clone.hidden = false
		clone.removeAttribute('id')
		clone.classList.remove('drag-placeholder')
		if (className) clone.classList.add(className)
		if (forceActive) clone.classList.add('active')
		clone.tabIndex = -1
		clone.setAttribute('aria-hidden', 'true')
		for (const descendant of clone.querySelectorAll<HTMLElement>('[id], button, [tabindex]')) {
			descendant.removeAttribute('id')
			descendant.tabIndex = -1
		}
		return clone
	}

	function clearBackgroundTabDropTarget(): void {
		tabStripRegion.classList.remove('background-restore-over')
	}

	function projectBackgroundTabAtUnit(drag: BackgroundTabPointerDrag, unitIndex: number): void {
		drag.projected = true
		drag.dropUnitIndex = unitIndex
		drag.tab.tabButton.classList.add('background-tab-drop-placeholder', 'active')
		drag.placementDrag?.project({
			surface: 'strip',
			index: placementIndexForStripUnits(stripDragUnitsExcluding(drag.tab.groupId ?? '', drag.tab), unitIndex),
		})
	}

	function restoreBackgroundTabProjection(drag: BackgroundTabPointerDrag, _animate: boolean): void {
		if (!drag.projected) return
		drag.projected = false
		drag.tab.tabButton.classList.remove('background-tab-drop-placeholder')
		drag.placementDrag?.reset()
	}

	async function commitBackgroundTabProjection(drag: BackgroundTabPointerDrag): Promise<boolean> {
		const result = await drag.placementDrag?.commit()
		if (!result?.ok) return false
		closeBackgroundPopover()
		return true
	}

	function positionBackgroundTabPreview(drag: BackgroundTabPointerDrag): void {
		if (!drag.preview) return
		drag.preview.style.transform = `translate3d(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px, 0) scale(1.02)`
	}

	function updateBackgroundTabDragTarget(drag: BackgroundTabPointerDrag): void {
		clearBackgroundTabDropTarget()
		const stripRect = tabStripRegion.getBoundingClientRect()
		if (!pointInExpandedRect(drag.x, drag.y, stripRect, 6)) {
			restoreBackgroundTabProjection(drag, true)
			drag.dropTarget = null
			positionBackgroundTabPreview(drag)
			return
		}

		drag.dropTarget = 'strip'
		tabStripRegion.classList.add('background-restore-over')
		const units = stripDragUnitsExcluding(drag.tab.groupId ?? '', drag.tab)
		drag.dropUnitIndex = stripDropInsertionIndex(
			drag.x,
			units.map(unit => unit.rect),
		)
		projectBackgroundTabAtUnit(drag, drag.dropUnitIndex)
		positionBackgroundTabPreview(drag)
	}

	function backgroundTabDragFrame(): void {
		const drag = backgroundTabPointerDrag
		if (!drag?.started) return
		if (drag.dropTarget === 'strip') {
			const stripRect = tabsEl.getBoundingClientRect()
			const delta = tabStripAutoScrollDelta(
				drag.x,
				stripRect,
				tabsEl.scrollLeft,
				tabsEl.scrollWidth,
				tabsEl.clientWidth,
			)
			if (delta !== 0) {
				tabsEl.scrollLeft += delta
				updateBackgroundTabDragTarget(drag)
			}
		}
		drag.frame = requestAnimationFrame(backgroundTabDragFrame)
	}

	function startBackgroundTabPointerDrag(drag: BackgroundTabPointerDrag): void {
		// When this member reunites a split group, project the full existing group
		// block so its strip peers move with the semantic unit. Only Background
		// members actually change surface.
		const splitGroupId =
			drag.tab.groupId && tabs.some(tab => tab.groupId === drag.tab.groupId) ? drag.tab.groupId : null
		drag.placementDrag = placement.beginDrag(
			splitGroupId ? { type: 'group', groupId: splitGroupId } : { type: 'terminal', id: placementId(drag.tab) },
		)
		if (!drag.placementDrag.project({ surface: 'strip', index: tabs.length }).ok) return
		drag.started = true
		const preview = createTabStripProjection(drag.tab, 'background-tab-drag-preview', true)
		preview.classList.add('tab-drag-preview')
		document.body.append(preview)
		drag.preview = preview
		tabStripRegion.classList.add('background-restore-ready')
		closeBackgroundPopover()
		document.body.classList.add('tab-dragging')
		positionBackgroundTabPreview(drag)
		updateBackgroundTabDragTarget(drag)
		drag.frame = requestAnimationFrame(backgroundTabDragFrame)
	}

	function removeBackgroundTabPointerListeners(drag: BackgroundTabPointerDrag): void {
		document.removeEventListener('pointermove', onBackgroundTabPointerMove)
		document.removeEventListener('pointerup', onBackgroundTabPointerUp)
		document.removeEventListener('pointercancel', onBackgroundTabPointerCancel)
		document.removeEventListener('keydown', onBackgroundTabDragKeydown, true)
		window.removeEventListener('blur', onBackgroundTabDragBlur)
		try {
			if (drag.source.hasPointerCapture(drag.pointerId)) drag.source.releasePointerCapture(drag.pointerId)
		} catch {
			// The Background popover may rerender while a pointer gesture settles.
		}
	}

	function settleBackgroundTabPreview(drag: BackgroundTabPointerDrag, target: DOMRect, restored: boolean): void {
		const preview = drag.preview
		if (!preview) return
		const cleanup = (): void => {
			preview.remove()
			drag.tab.tabButton.classList.remove('background-tab-drop-placeholder')
		}
		if (disposed || reducedMotion()) {
			cleanup()
			return
		}
		const left = drag.x - drag.offsetX
		const top = drag.y - drag.offsetY
		const animation = preview.animate(
			[
				{ transform: `translate3d(${left}px, ${top}px, 0) scale(1.02)`, opacity: 1 },
				{
					transform: `translate3d(${target.left}px, ${target.top}px, 0) scale(${restored ? 1 : 0.72})`,
					opacity: restored ? 1 : 0,
				},
			],
			{ duration: restored ? 180 : 140, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
		)
		animation.addEventListener('finish', cleanup, { once: true })
		animation.addEventListener('cancel', cleanup, { once: true })
	}

	function finishBackgroundTabPointerDrag(cancelled: boolean): void {
		const drag = backgroundTabPointerDrag
		if (!drag) return
		backgroundTabPointerDrag = null
		removeBackgroundTabPointerListeners(drag)
		if (drag.frame !== null) cancelAnimationFrame(drag.frame)
		if (!drag.started) return

		suppressTabClick.add(drag.tab)
		setTimeout(() => suppressTabClick.delete(drag.tab), 0)
		const restored = !cancelled && drag.dropTarget === 'strip' && drag.projected
		if (!restored) {
			restoreBackgroundTabProjection(drag, true)
			drag.placementDrag?.cancel()
		}
		const target = restored ? drag.tab.tabButton.getBoundingClientRect() : bgToggle.getBoundingClientRect()
		clearBackgroundTabDropTarget()
		tabStripRegion.classList.remove('background-restore-ready')
		document.body.classList.remove('tab-dragging')
		updateBackgroundUi()
		settleBackgroundTabPreview(drag, target, restored)
		if (restored) void commitBackgroundTabProjection(drag).then(ok => ok && activate(drag.tab))
	}

	function onBackgroundTabPointerMove(event: PointerEvent): void {
		const drag = backgroundTabPointerDrag
		if (!drag || event.pointerId !== drag.pointerId) return
		drag.x = event.clientX
		drag.y = event.clientY
		if (!drag.started) {
			if (!dragThresholdExceeded(drag.startX, drag.startY, drag.x, drag.y)) return
			startBackgroundTabPointerDrag(drag)
		} else {
			updateBackgroundTabDragTarget(drag)
		}
		event.preventDefault()
	}

	function onBackgroundTabPointerUp(event: PointerEvent): void {
		const drag = backgroundTabPointerDrag
		if (!drag || event.pointerId !== drag.pointerId) return
		drag.x = event.clientX
		drag.y = event.clientY
		if (drag.started) updateBackgroundTabDragTarget(drag)
		finishBackgroundTabPointerDrag(false)
	}

	function onBackgroundTabPointerCancel(event: PointerEvent): void {
		if (backgroundTabPointerDrag?.pointerId === event.pointerId) finishBackgroundTabPointerDrag(true)
	}

	function onBackgroundTabDragKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || !backgroundTabPointerDrag) return
		event.preventDefault()
		finishBackgroundTabPointerDrag(true)
	}

	function onBackgroundTabDragBlur(): void {
		if (backgroundTabPointerDrag) finishBackgroundTabPointerDrag(true)
	}

	function createBackgroundTabPointerDrag(
		tab: Tab,
		source: HTMLButtonElement,
		pointerId: number,
		x: number,
		y: number,
	): BackgroundTabPointerDrag {
		const rect = source.getBoundingClientRect()
		return {
			tab,
			source,
			pointerId,
			startX: x,
			startY: y,
			x,
			y,
			offsetX: Math.min(x - rect.left, 168),
			offsetY: Math.min(y - rect.top, 26),
			placementDrag: null,
			started: false,
			projected: false,
			preview: null,
			dropTarget: null,
			dropUnitIndex: tabs.length,
			frame: null,
		}
	}

	function beginBackgroundTabPointerDrag(tab: Tab, source: HTMLButtonElement, event: PointerEvent): void {
		if (
			backgroundTabPointerDrag ||
			tabPointerDrag ||
			groupPointerDrag ||
			event.button !== 0 ||
			tab.closed ||
			!tab.parked
		)
			return
		backgroundTabPointerDrag = createBackgroundTabPointerDrag(
			tab,
			source,
			event.pointerId,
			event.clientX,
			event.clientY,
		)
		source.setPointerCapture(event.pointerId)
		document.addEventListener('pointermove', onBackgroundTabPointerMove, { passive: false })
		document.addEventListener('pointerup', onBackgroundTabPointerUp)
		document.addEventListener('pointercancel', onBackgroundTabPointerCancel)
		document.addEventListener('keydown', onBackgroundTabDragKeydown, true)
		window.addEventListener('blur', onBackgroundTabDragBlur)
	}

	interface GroupPointerDrag {
		groupId: string
		originSurface: TabGroupSurface
		members: Tab[]
		header: HTMLButtonElement
		pointerId: number
		startX: number
		startY: number
		x: number
		y: number
		offsetX: number
		offsetY: number
		sourceWidth: number
		sourceHeight: number
		placementDrag: PlacementDrag | null
		started: boolean
		projected: boolean
		preview: HTMLDivElement | null
		dropTarget: 'strip' | 'background' | null
		dropUnitIndex: number
		frame: number | null
	}

	interface StripDragUnit {
		members: Tab[]
		rect: DOMRect
		element: HTMLElement
	}

	let groupPointerDrag: GroupPointerDrag | null = null

	function stripGroupElement(groupId: string): HTMLElement | null {
		return ([...tabsEl.children].find(
			child =>
				child instanceof HTMLElement &&
				child.classList.contains('tab-group-section') &&
				child.dataset.groupId === groupId,
		) ?? null) as HTMLElement | null
	}

	function backgroundGroupElement(groupId: string): HTMLElement | null {
		return (
			[...bgRows.querySelectorAll<HTMLElement>('.bg-group-section')].find(
				section => section.dataset.groupId === groupId,
			) ?? null
		)
	}

	function groupElement(groupId: string, surface: TabGroupSurface): HTMLElement | null {
		return surface === 'strip' ? stripGroupElement(groupId) : backgroundGroupElement(groupId)
	}

	/** Convert a visual semantic-unit insertion point into TerminalPlacement's raw terminal index. */
	function placementIndexForStripUnits(units: readonly StripDragUnit[], unitIndex: number): number {
		return units
			.slice(0, Math.max(0, Math.min(unitIndex, units.length)))
			.reduce((count, unit) => count + unit.members.length, 0)
	}

	function stripDragUnitsExcluding(groupId: string, excludedTab?: Tab): StripDragUnit[] {
		const byId = new Map(tabs.map(tab => [tabIdentity(tab), tab]))
		const units: StripDragUnit[] = []
		for (const section of tabGroupComposition().strip) {
			if (section.kind === 'group') {
				if (section.groupId === groupId) continue
				const sectionEl = stripGroupElement(section.groupId as string)
				const members = section.members.flatMap(member => {
					const tab = byId.get(member.id)
					return tab ? [tab] : []
				})
				if (sectionEl && members.length > 0)
					units.push({ members, rect: sectionEl.getBoundingClientRect(), element: sectionEl })
				continue
			}
			for (const member of section.members) {
				const tab = byId.get(member.id)
				if (tab && tab !== excludedTab)
					units.push({ members: [tab], rect: tab.tabButton.getBoundingClientRect(), element: tab.tabButton })
			}
		}
		return units
	}

	function projectBackgroundGroupAtUnit(
		drag: GroupPointerDrag,
		units: readonly StripDragUnit[],
		unitIndex: number,
	): void {
		drag.projected = true
		drag.placementDrag?.project({ surface: 'strip', index: placementIndexForStripUnits(units, unitIndex) })
		stripGroupElement(drag.groupId)?.classList.add('group-drop-placeholder')
	}

	function restoreBackgroundGroupProjection(drag: GroupPointerDrag, _animate: boolean): void {
		if (!drag.projected) return
		drag.projected = false
		drag.placementDrag?.reset()
	}

	async function commitBackgroundGroupProjection(drag: GroupPointerDrag): Promise<boolean> {
		const result = await drag.placementDrag?.commit()
		if (!result?.ok) return false
		closeBackgroundPopover()
		const focusTarget = drag.members.at(-1)
		if (focusTarget) activate(focusTarget)
		return true
	}

	function markGroupDragPlaceholder(drag: GroupPointerDrag): void {
		if (drag.originSurface === 'background') {
			if (drag.projected) stripGroupElement(drag.groupId)?.classList.add('group-drop-placeholder')
			return
		}
		groupElement(drag.groupId, drag.originSurface)?.classList.add('group-drag-placeholder')
	}

	function positionGroupPreview(drag: GroupPointerDrag): void {
		if (!drag.preview) return
		const scale = drag.dropTarget === 'background' ? 0.92 : 1.02
		drag.preview.style.transform = `translate3d(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px, 0) scale(${scale})`
	}

	function restoreGroupDragOrigin(drag: GroupPointerDrag): void {
		if (drag.originSurface === 'background') restoreBackgroundGroupProjection(drag, true)
		else drag.placementDrag?.reset()
		markGroupDragPlaceholder(drag)
	}

	function updateGroupDragTarget(drag: GroupPointerDrag): void {
		tabStripRegion.classList.remove('background-restore-over')
		const backgroundRect = bgToggle.getBoundingClientRect()
		const overNewTab = pointInExpandedRect(drag.x, drag.y, newTabButton.getBoundingClientRect())
		if (drag.originSurface === 'strip' && !overNewTab && pointInExpandedRect(drag.x, drag.y, backgroundRect, 8)) {
			drag.dropTarget = 'background'
			drag.placementDrag?.project({ surface: 'background', index: parked.length })
			bgToggle.classList.add('drag-over')
			drag.preview?.classList.add('over-background')
			positionGroupPreview(drag)
			return
		}

		bgToggle.classList.remove('drag-over')
		drag.preview?.classList.remove('over-background')
		const stripRect = tabStripRegion.getBoundingClientRect()
		if (!pointInExpandedRect(drag.x, drag.y, stripRect, 6)) {
			drag.dropTarget = null
			restoreGroupDragOrigin(drag)
			positionGroupPreview(drag)
			return
		}

		drag.dropTarget = 'strip'
		if (drag.originSurface === 'background') tabStripRegion.classList.add('background-restore-over')
		const units = stripDragUnitsExcluding(drag.groupId)
		drag.dropUnitIndex = stripDropInsertionIndex(
			drag.x,
			units.map(unit => unit.rect),
		)
		if (drag.originSurface === 'strip') {
			drag.placementDrag?.project({ surface: 'strip', index: placementIndexForStripUnits(units, drag.dropUnitIndex) })
			markGroupDragPlaceholder(drag)
		} else {
			projectBackgroundGroupAtUnit(drag, units, drag.dropUnitIndex)
		}
		positionGroupPreview(drag)
	}

	function groupDragFrame(): void {
		const drag = groupPointerDrag
		if (!drag?.started) return
		if (drag.dropTarget === 'strip') {
			const stripRect = tabsEl.getBoundingClientRect()
			const delta = tabStripAutoScrollDelta(
				drag.x,
				stripRect,
				tabsEl.scrollLeft,
				tabsEl.scrollWidth,
				tabsEl.clientWidth,
			)
			if (delta !== 0) {
				tabsEl.scrollLeft += delta
				updateGroupDragTarget(drag)
			}
		}
		drag.frame = requestAnimationFrame(groupDragFrame)
	}

	function createGroupDragPreview(drag: GroupPointerDrag, sectionEl: HTMLElement): HTMLDivElement {
		const preview = document.createElement('div')
		preview.className = 'tab-group-section collapsed tab-group-drag-preview'
		preview.setAttribute('aria-hidden', 'true')
		const groupColor = sectionEl.style.getPropertyValue('--group-color')
		if (groupColor) preview.style.setProperty('--group-color', groupColor)
		const header = drag.header.cloneNode(true) as HTMLButtonElement
		header.tabIndex = -1
		if (!header.querySelector('.tab-group-count')) {
			const count = document.createElement('span')
			count.className = 'tab-group-count'
			count.textContent = String(drag.members.length)
			header.append(count)
		}
		preview.append(header)
		return preview
	}

	function startGroupPointerDrag(drag: GroupPointerDrag): void {
		const sectionEl = groupElement(drag.groupId, drag.originSurface)
		if (!sectionEl) return
		drag.placementDrag = placement.beginDrag({ type: 'group', groupId: drag.groupId })
		const startIndex =
			drag.originSurface === 'strip' ? tabs.indexOf(drag.members[0] as Tab) : parked.indexOf(drag.members[0] as Tab)
		if (!drag.placementDrag.project({ surface: drag.originSurface, index: Math.max(0, startIndex) }).ok) return
		drag.started = true
		closeTabMenu()
		const preview = createGroupDragPreview(drag, sectionEl)
		document.body.append(preview)
		drag.preview = preview
		const previewRect = preview.getBoundingClientRect()
		drag.offsetX = (drag.offsetX / drag.sourceWidth) * previewRect.width
		drag.offsetY = (drag.offsetY / drag.sourceHeight) * previewRect.height
		if (drag.originSurface === 'background') tabStripRegion.classList.add('background-restore-ready')
		markGroupDragPlaceholder(drag)
		closeBackgroundPopover()
		document.body.classList.add('group-dragging')
		if (drag.originSurface === 'strip') {
			bgToggle.hidden = false
			bgToggle.classList.add('drag-ready')
			bgToggle.title = 'Move group to background'
		}
		positionGroupPreview(drag)
		updateGroupDragTarget(drag)
		drag.frame = requestAnimationFrame(groupDragFrame)
	}

	function removeGroupPointerListeners(drag: GroupPointerDrag): void {
		document.removeEventListener('pointermove', onGroupPointerMove)
		document.removeEventListener('pointerup', onGroupPointerUp)
		document.removeEventListener('pointercancel', onGroupPointerCancel)
		document.removeEventListener('keydown', onGroupDragKeydown, true)
		window.removeEventListener('blur', onGroupDragBlur)
		try {
			if (drag.header.hasPointerCapture(drag.pointerId)) drag.header.releasePointerCapture(drag.pointerId)
		} catch {
			// Header may have been replaced by a live strip reorder or hidden popover.
		}
	}

	function settleGroupPreview(drag: GroupPointerDrag, target: DOMRect, intoBackground = false): void {
		const preview = drag.preview
		const cleanup = () => preview?.remove()
		if (disposed || !preview || reducedMotion()) {
			cleanup()
			return
		}
		const left = drag.x - drag.offsetX
		const top = drag.y - drag.offsetY
		const destinationX = intoBackground ? target.left + (target.width - preview.offsetWidth) / 2 : target.left
		const destinationY = intoBackground ? target.top + (target.height - preview.offsetHeight) / 2 : target.top
		const animation = preview.animate(
			[
				{ transform: `translate3d(${left}px, ${top}px, 0) scale(${intoBackground ? 0.92 : 1.02})`, opacity: 1 },
				{
					transform: `translate3d(${destinationX}px, ${destinationY}px, 0) scale(${intoBackground ? 0.72 : 1})`,
					opacity: intoBackground ? 0 : 1,
				},
			],
			{ duration: intoBackground ? 140 : 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
		)
		animation.addEventListener('finish', cleanup, { once: true })
		animation.addEventListener('cancel', cleanup, { once: true })
	}

	function resetGroupDragChrome(): void {
		document.body.classList.remove('group-dragging')
		tabStripRegion.classList.remove('background-restore-ready', 'background-restore-over')
		bgToggle.classList.remove('drag-ready', 'drag-over')
		bgToggle.title = 'Background terminals'
		updateBackgroundUi()
	}

	function finishGroupPointerDrag(cancelled: boolean): void {
		const drag = groupPointerDrag
		if (!drag) return
		groupPointerDrag = null
		removeGroupPointerListeners(drag)
		if (drag.frame !== null) cancelAnimationFrame(drag.frame)
		if (!drag.started) return
		const acceptedDrop = !cancelled && drag.dropTarget !== null
		if (!acceptedDrop) {
			restoreGroupDragOrigin(drag)
			drag.placementDrag?.cancel()
		}
		const toggleKey = `${drag.originSurface}:${drag.groupId}`
		suppressedGroupToggleClicks.add(toggleKey)
		setTimeout(() => suppressedGroupToggleClicks.delete(toggleKey), 0)
		const target =
			drag.dropTarget === 'background'
				? bgToggle.getBoundingClientRect()
				: (stripGroupElement(drag.groupId)?.getBoundingClientRect() ?? drag.header.getBoundingClientRect())
		resetGroupDragChrome()
		settleGroupPreview(drag, target, drag.dropTarget === 'background')
		if (!acceptedDrop) return
		void (drag.originSurface === 'background' ? commitBackgroundGroupProjection(drag) : drag.placementDrag?.commit())
	}

	function onGroupPointerMove(event: PointerEvent): void {
		const drag = groupPointerDrag
		if (!drag || event.pointerId !== drag.pointerId) return
		drag.x = event.clientX
		drag.y = event.clientY
		if (!drag.started) {
			if (!dragThresholdExceeded(drag.startX, drag.startY, drag.x, drag.y)) return
			startGroupPointerDrag(drag)
		} else {
			updateGroupDragTarget(drag)
		}
		event.preventDefault()
	}

	function onGroupPointerUp(event: PointerEvent): void {
		const drag = groupPointerDrag
		if (!drag || event.pointerId !== drag.pointerId) return
		drag.x = event.clientX
		drag.y = event.clientY
		if (drag.started) updateGroupDragTarget(drag)
		finishGroupPointerDrag(false)
	}

	function onGroupPointerCancel(event: PointerEvent): void {
		if (groupPointerDrag && event.pointerId === groupPointerDrag.pointerId) finishGroupPointerDrag(true)
	}

	function onGroupDragKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || !groupPointerDrag) return
		event.preventDefault()
		finishGroupPointerDrag(true)
	}

	function onGroupDragBlur(): void {
		if (groupPointerDrag) finishGroupPointerDrag(true)
	}

	function createGroupPointerDrag(
		section: TabGroupSection,
		header: HTMLButtonElement,
		pointerId: number,
		clientX: number,
		clientY: number,
	): GroupPointerDrag | null {
		if (section.groupId === null) return null
		const sourceTabs = section.surface === 'strip' ? tabs : parked
		const byId = new Map(sourceTabs.map(tab => [tabIdentity(tab), tab]))
		const members = section.members.flatMap(member => {
			const tab = byId.get(member.id)
			return tab ? [tab] : []
		})
		if (members.length === 0) return null
		const rect = header.getBoundingClientRect()
		return {
			groupId: section.groupId,
			originSurface: section.surface,
			members,
			header,
			pointerId,
			startX: clientX,
			startY: clientY,
			x: clientX,
			y: clientY,
			offsetX: clientX - rect.left,
			offsetY: clientY - rect.top,
			sourceWidth: rect.width,
			sourceHeight: rect.height,
			placementDrag: null,
			started: false,
			projected: false,
			preview: null,
			dropTarget: null,
			dropUnitIndex: 0,
			frame: null,
		}
	}

	function beginGroupPointerDrag(section: TabGroupSection, header: HTMLButtonElement, event: PointerEvent): void {
		if (tabPointerDrag || backgroundTabPointerDrag || groupPointerDrag || event.button !== 0) return
		const drag = createGroupPointerDrag(section, header, event.pointerId, event.clientX, event.clientY)
		if (!drag) return
		groupPointerDrag = drag
		header.setPointerCapture(event.pointerId)
		document.addEventListener('pointermove', onGroupPointerMove, { passive: false })
		document.addEventListener('pointerup', onGroupPointerUp)
		document.addEventListener('pointercancel', onGroupPointerCancel)
		document.addEventListener('keydown', onGroupDragKeydown, true)
		window.addEventListener('blur', onGroupDragBlur)
	}

	// ---------- tab/group context menus (§3.8 panels at the pointer) ----------

	let tabMenuCleanup: (() => void) | null = null

	function closeTabMenu(): void {
		tabMenuCleanup?.()
	}

	interface TabMenuItem {
		label: string
		icon: string
		color?: TabGroupColor
		hint?: string
		destructive?: boolean
		disabled?: boolean
		separatorBefore?: boolean
		onPick: () => void
	}

	function openMenu(items: readonly TabMenuItem[], x: number, y: number, trigger: HTMLElement): void {
		closeTabMenu()
		closeBackgroundPopover()
		const panel = document.createElement('div')
		panel.className = 'menu-panel menu-fixed'
		panel.setAttribute('role', 'menu')
		const buttons: HTMLButtonElement[] = []
		for (const item of items) {
			if (item.separatorBefore) {
				const separator = document.createElement('div')
				separator.className = 'menu-separator'
				separator.setAttribute('role', 'separator')
				panel.append(separator)
			}
			const button = document.createElement('button')
			button.type = 'button'
			button.className = `menu-item${item.destructive ? ' menu-item-danger' : ''}`
			button.setAttribute('role', 'menuitem')
			button.disabled = item.disabled === true
			const icon = document.createElement('span')
			icon.className = `menu-item-icon${item.color ? ' menu-item-color' : ''}`
			icon.setAttribute('aria-hidden', 'true')
			if (item.color) applyGroupColor(icon, item.color)
			icon.textContent = item.icon
			const label = document.createElement('span')
			label.className = 'menu-item-label'
			label.textContent = item.label
			button.append(icon, label)
			if (item.hint) {
				const hint = document.createElement('span')
				hint.className = 'menu-hint'
				hint.textContent = item.hint
				button.append(hint)
			}
			button.addEventListener('click', () => {
				if (button.disabled) return
				closeTabMenu()
				if (trigger.isConnected) trigger.focus()
				item.onPick()
			})
			buttons.push(button)
			panel.append(button)
		}
		const onOutside = (event: PointerEvent): void => {
			if (!(event.target instanceof Node) || !panel.contains(event.target)) closeTabMenu()
		}
		const onKeydown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				event.stopPropagation()
				closeTabMenu()
				trigger.focus()
				return
			}
			const enabledButtons = buttons.filter(button => !button.disabled)
			if (event.key === 'Home' || event.key === 'End') {
				event.preventDefault()
				enabledButtons[event.key === 'Home' ? 0 : enabledButtons.length - 1]?.focus()
				return
			}
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
			event.preventDefault()
			const current = enabledButtons.indexOf(document.activeElement as HTMLButtonElement)
			const delta = event.key === 'ArrowDown' ? 1 : -1
			enabledButtons[(current + delta + enabledButtons.length) % enabledButtons.length]?.focus()
		}
		tabMenuCleanup = () => {
			tabMenuCleanup = null
			panel.remove()
			document.removeEventListener('pointerdown', onOutside, true)
			document.removeEventListener('keydown', onKeydown, true)
		}
		document.addEventListener('pointerdown', onOutside, true)
		document.addEventListener('keydown', onKeydown, true)
		document.body.append(panel)
		const rect = panel.getBoundingClientRect()
		panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
		panel.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
		buttons.find(button => !button.disabled)?.focus()
	}

	function openGroupNameMenu(
		label: string,
		initialValue: string,
		x: number,
		y: number,
		trigger: HTMLElement,
		onSubmit: (name: string) => void,
	): void {
		closeTabMenu()
		closeBackgroundPopover()
		const panel = document.createElement('form')
		panel.className = 'menu-panel menu-fixed menu-name-form'
		panel.setAttribute('aria-label', label)
		const input = document.createElement('input')
		input.className = 'menu-name-input'
		input.type = 'text'
		input.maxLength = 200
		input.value = initialValue
		input.setAttribute('aria-label', label)
		const submit = document.createElement('button')
		submit.type = 'submit'
		submit.className = 'menu-item'
		const icon = document.createElement('span')
		icon.className = 'menu-item-icon'
		icon.setAttribute('aria-hidden', 'true')
		icon.textContent = '✓'
		const copy = document.createElement('span')
		copy.className = 'menu-item-label'
		copy.textContent = label
		submit.append(icon, copy)
		panel.append(input, submit)
		const dismiss = (): void => {
			closeTabMenu()
			trigger.focus()
		}
		panel.addEventListener('submit', event => {
			event.preventDefault()
			const name = input.value.trim()
			if (!name) return
			closeTabMenu()
			if (trigger.isConnected) trigger.focus()
			onSubmit(name)
		})
		const onOutside = (event: PointerEvent): void => {
			if (!(event.target instanceof Node) || !panel.contains(event.target)) dismiss()
		}
		const onKeydown = (event: KeyboardEvent): void => {
			if (event.key !== 'Escape') return
			event.preventDefault()
			event.stopPropagation()
			dismiss()
		}
		tabMenuCleanup = () => {
			tabMenuCleanup = null
			panel.remove()
			document.removeEventListener('pointerdown', onOutside, true)
			document.removeEventListener('keydown', onKeydown, true)
		}
		document.addEventListener('pointerdown', onOutside, true)
		document.addEventListener('keydown', onKeydown, true)
		document.body.append(panel)
		const rect = panel.getBoundingClientRect()
		panel.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`
		panel.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`
		input.focus()
		input.select()
	}

	function moveTabToGroup(tab: Tab, groupId: string | null): void {
		if (tab.closed || !placementHydrated) return
		void placement.execute({ type: 'set-membership', id: placementId(tab), groupId })
	}

	function createGroupForTab(tab: Tab, name: string): void {
		if (!tab.sessionId || tab.closed) return
		void helm.sessions.groups.create(name, [tab.sessionId as string]).then(async group => {
			if (!group || tab.closed) return
			const groups = await helm.sessions.groups.list().catch(() => [])
			reconcilePlacementGroups(groups)
			void placement.execute({ type: 'set-membership', id: placementId(tab), groupId: group.id })
		})
	}

	function openTabMoveMenu(tab: Tab, x: number, y: number, trigger: HTMLElement): void {
		const groups = tabGroups.filter(group => group.id !== tab.groupId)
		openMenu(
			[
				...groups.map(group => ({
					label: group.name,
					icon: '›',
					onPick: () => moveTabToGroup(tab, group.id),
				})),
				...(tab.groupId === null
					? []
					: [
							{
								label: 'Remove from group',
								icon: '–',
								separatorBefore: groups.length > 0,
								onPick: () => moveTabToGroup(tab, null),
							},
						]),
			],
			x,
			y,
			trigger,
		)
	}

	function openProfileMoveMenu(tab: Tab, x: number, y: number): void {
		if (!tab.sessionId || tab.transferring) return
		void helm.terminalTransfer.preflight(tab.sessionId).then(async preflight => {
			if (preflight.status !== 'available') {
				openMenu([{ label: 'No available profiles', icon: '→', disabled: true, onPick: () => {} }], x, y, tab.tabButton)
				return
			}
			const profiles = await helm.profiles.list()
			const names = profiles.data
				? new Map(profiles.data.profiles.map(profile => [profile.id, profile.name]))
				: new Map<string, string>()
			openMenu(
				preflight.targetProfileIds.map(profileId => ({
					label: names.get(profileId) ?? 'Unavailable profile',
					icon: '→',
					onPick: () => {
						void helm.terminalTransfer.move(tab.sessionId as string, profileId).then(result => {
							if (result.status === 'moved') {
								showToast({ message: `Moved to Background in ${names.get(profileId) ?? 'profile'}` })
								return
							}
							// The renderer controller alone owns freeze/rollback. A quarantined
							// post-detach transfer must remain frozen until ownership is repaired.
							showToast({ message: 'Could not move terminal' })
						})
					},
				})),
				x,
				y,
				tab.tabButton,
			)
		})
	}

	function openTabMenu(tab: Tab, x: number, y: number): void {
		if (groupPointerDrag) return
		const movable = tab.sessionId !== null && !tab.transferring
		openMenu(
			[
				{ label: 'Rename…', icon: '✎', onPick: () => startRename(tab) },
				{
					label: 'Move to existing group',
					icon: '›',
					disabled: !movable || tabGroups.length === 0,
					onPick: () => openTabMoveMenu(tab, x, y, tab.tabButton),
				},
				{
					label: 'Move to new group…',
					icon: '+',
					disabled: !movable,
					onPick: () =>
						openGroupNameMenu('Create group', '', x, y, tab.tabButton, name => createGroupForTab(tab, name)),
				},
				{
					label: 'Move to profile…',
					icon: '→',
					disabled: !movable,
					onPick: () => openProfileMoveMenu(tab, x, y),
				},
				{ label: 'Move to background', icon: '⇩', hint: '⇧⌘B', onPick: () => parkTab(tab), separatorBefore: true },
				{ label: 'Close', icon: '×', hint: '⌘W', destructive: true, onPick: () => closeTab(tab) },
			],
			x,
			y,
			tab.tabButton,
		)
	}

	function renameGroup(groupId: string, name: string): void {
		const intent: TabGroupActionIntent = { type: 'rename', groupId, name }
		void helm.sessions.groups.intent(intent).then(accepted => {
			if (!accepted) return
			void helm.sessions.groups.rename(groupId, name).then(() => loadTabGroups())
		})
	}

	function deleteGroup(groupId: string): void {
		void helm.sessions.groups.delete(groupId).then(deleted => {
			if (deleted) loadTabGroups()
		})
	}

	function openGroupMembers(current: ReadonlyMap<string, Tab>, memberIds: readonly string[]): void {
		for (const id of memberIds) {
			const tab = current.get(id)
			if (tab?.parked) openParked(tab)
		}
	}

	function closeGroupMembers(current: ReadonlyMap<string, Tab>, memberIds: readonly string[]): void {
		for (const id of memberIds) {
			const tab = current.get(id)
			if (tab?.parked) killParkedTab(tab)
			else if (tab) closeTab(tab)
		}
	}

	async function executeGroupAction(target: TabGroupActionTarget): Promise<boolean> {
		const authorization = await helm.sessions.groups.intent(target.intent)
		if (!authorization) return false
		const current = new Map([...tabs, ...parked].map(tab => [tabIdentity(tab), tab]))
		switch (target.action) {
			case 'open':
				openGroupMembers(current, authorization.memberIds)
				return true
			case 'restore': {
				const result = await placement.execute({ type: 'restore-group', groupId: target.groupId })
				return result.ok
			}
			case 'background': {
				const result = await placement.execute({ type: 'move-group-to-background', groupId: target.groupId })
				return result.ok
			}
			case 'close':
				closeGroupMembers(current, authorization.memberIds)
				return true
		}
	}

	function runGroupAction(target: TabGroupActionTarget): void {
		if (groupPointerDrag) return
		void executeGroupAction(target)
	}

	function openGroupColorMenu(
		groupId: string,
		currentColor: TabGroupColor,
		x: number,
		y: number,
		trigger: HTMLElement,
	): void {
		openMenu(
			TAB_GROUP_COLORS.map(color => ({
				label: TAB_GROUP_COLOR_LABELS[color],
				icon: '●',
				color,
				disabled: color === currentColor,
				hint: color === currentColor ? 'Current' : undefined,
				onPick: () => changeGroupColor(groupId, color),
			})),
			x,
			y,
			trigger,
		)
	}

	function openGroupMenu(section: TabGroupSection, x: number, y: number, trigger: HTMLElement): void {
		if (groupPointerDrag || section.groupId === null) return
		const groupId = section.groupId
		const color = section.color ?? 'blue'
		const actions = section.actionTargets.map((target, index) => ({
			label:
				target.action === 'open'
					? 'Open all'
					: target.action === 'restore'
						? 'Restore all'
						: target.action === 'background'
							? 'Move group to Background'
							: 'Close all',
			icon: target.action === 'close' ? '×' : target.action === 'background' ? '⇩' : '⇥',
			destructive: target.action === 'close',
			separatorBefore: index === 0,
			onPick: () => runGroupAction(target),
		}))
		openMenu(
			[
				{
					label: 'Rename…',
					icon: '✎',
					onPick: () =>
						openGroupNameMenu('Rename group', section.name, x, y, trigger, name => renameGroup(groupId, name)),
				},
				{
					label: 'Color…',
					icon: '●',
					color,
					onPick: () => openGroupColorMenu(groupId, color, x, y, trigger),
				},
				{ label: 'Delete', icon: '×', destructive: true, onPick: () => deleteGroup(groupId) },
				...actions,
			],
			x,
			y,
			trigger,
		)
	}

	// Zero terminals is a valid state — show a quiet hint instead of respawning
	// (closing the last tab used to auto-open a new one; deliberate removal).
	function syncEmptyState(): void {
		const empty = document.getElementById('no-terms')
		if (empty) empty.hidden = tabs.length > 0 || activeTab !== null
	}

	interface TerminalOpts {
		/** Restored/undone session to reattach; omitted = create a fresh session. */
		sessionId?: string
		/** Persisted label shown until the shell emits a fresh OSC title. */
		title?: string | null
		/** Persisted manual rename pin — label text, never overwritten by OSC. */
		customName?: string | null
		/** Create straight into the background list (startup parked restore, kill-undo). */
		parked?: boolean
		/** Restored opaque membership; new terminals begin without a group. */
		groupId?: string | null
		agentRunning?: boolean
		agentAttention?: boolean
		/** Main-only scheduled adoption has already attached this opaque PTY. */
		placementEligible?: boolean
		attachedPty?: { id: number; sessionId: string }
	}

	async function createTerminal(opts?: TerminalOpts): Promise<void> {
		if (disposed) return
		const startParked = opts?.parked === true
		const term = new Terminal({
			cursorBlink: true,
			scrollback: 10000,
			fontSize: appearance.getTermFontSize(),
			fontFamily: "'SF Mono', Menlo, ui-monospace, monospace",
			// Spec asks for CSS line-height 1.45 (13px -> ~19px). xterm's lineHeight
			// multiplies the font's natural cell height (~15.5px here), so 1.2 lands
			// at that same ~19px; a literal 1.45 would render ~22px cells.
			lineHeight: 1.2,
			macOptionIsMeta: true,
			theme: appearance.getTermTheme(),
		})
		const fit = new FitAddon()
		term.loadAddon(fit)
		const serialize = new SerializeAddon()
		term.loadAddon(serialize)
		// The addon's default handler opens about:blank before assigning the URL;
		// Helm denies that transient Electron window. Use the restricted main-process
		// browser handoff directly, gated behind the explicit macOS Command-click.
		term.loadAddon(
			new WebLinksAddon((event, uri) => {
				if (!shouldOpenTerminalLink(event)) return
				event.preventDefault()
				void helm.external.open(uri)
			}),
		)

		const holder = document.createElement('div')
		holder.className = 'term-holder'
		// Unpadded measurement/mount element — see the comment above interface Tab.
		const mount = document.createElement('div')
		mount.className = 'term-mount'
		holder.appendChild(mount)
		// Overlay scrollbar: sibling of the mount, so the track spans the holder's
		// FULL padding box (pane top to pane bottom) instead of the inset text area.
		const scrollbar = document.createElement('div')
		scrollbar.className = 'term-scrollbar'
		scrollbar.hidden = true
		scrollbar.setAttribute('aria-hidden', 'true')
		const thumb = document.createElement('div')
		thumb.className = 'term-scrollbar-thumb'
		scrollbar.appendChild(thumb)
		holder.appendChild(scrollbar)
		termsEl.appendChild(holder)
		term.open(mount)

		const tabButton = document.createElement('div')
		tabButton.className = 'tab'
		tabButton.setAttribute('role', 'tab')
		tabButton.tabIndex = 0
		const label = document.createElement('span')
		label.className = 'tab-label'
		const running = createActivityIndicator('Running')
		running.classList.add('tab-running')
		running.hidden = true
		const close = document.createElement('button')
		close.className = 'tab-close'
		close.textContent = '×'
		close.title = 'Close (⌘W)'
		close.setAttribute('aria-label', 'Close terminal')
		tabButton.append(running, label, close)

		let tab!: Tab
		const outputGuard = createSynchronizedOutputGuard({
			onFreeze: () => freezeTerminalFrame(tab),
			onUnfreeze: () => unfreezeTerminalFrame(tab),
			scheduleVisualRelease: release => scheduleTerminalFrameRelease(tab, release),
		})
		const progressTracker = createTerminalProgressTracker(active => setTabAgentRunning(tab, active))
		tab = {
			ptyId: null,
			sessionId: null,
			closed: false,
			transferring: false,
			parked: startParked,
			groupId: opts?.groupId ?? null,
			visualId: `tab-${nextVisualTabId++}`,
			exitCode: null,
			placementEligible: opts?.placementEligible ?? opts?.attachedPty === undefined,
			title: '',
			titleRaw: '',
			oscTitle: null,
			oscRaw: null,
			customName: opts?.customName ?? null,
			// Reattaching an existing session arms restored-title stickiness; a
			// fresh tab keeps today's title behavior exactly.
			restored: opts?.sessionId !== undefined,
			titleSettled: false,
			attachedAt: Number.POSITIVE_INFINITY,
			dirty: false,
			frameOutputPending: false,
			frameFreeze: null,
			outputGuard,
			agentRunning: opts?.agentRunning === true,
			agentAttention: opts?.agentAttention === true,
			progressTracker,
			runningEl: running,
			term,
			fit,
			serialize,
			holder,
			tabButton,
			labelEl: label,
			scrollbar,
			thumb,
			fitRetryPending: false,
			scrollSyncPending: false,
			attachClearPending: true,
			attachClearHeld: '',
		}
		attachScrollbarInput(tab)
		term.attachCustomKeyEventHandler(event => {
			const shortcut = terminalShortcut(helm.platform, event)
			if (!shortcut) return true
			if (event.type === 'keydown' && tab.ptyId !== null) {
				helm.pty.write(tab.ptyId, shortcut.input)
			}
			return !shortcut.suppress
		})
		// Restored tabs keep the label persisted from the previous run until the
		// reattached shell emits a fresh OSC title (normalized too — older runs
		// persisted raw "user@host:cwd" titles). A pinned name wins over both.
		tab.title = normalizeTabTitle(opts?.title ?? '')
		tab.titleRaw = (opts?.title ?? '').trim()
		renderTabLabel(tab)
		// Shell title arrives via OSC title events; empty titles fall back to "zsh".
		// Arbitration (pin / restored-title stickiness / live follow) is the pure
		// decideTabTitle — see ./tab-title.ts for the diagnosis + rules.
		term.onTitleChange(title => {
			const normalized = normalizeTabTitle(title)
			// Track the live OSC title even when it won't apply: a pinned tab's
			// tooltip shows it, and an unpin falls back to it.
			tab.oscTitle = normalized
			tab.oscRaw = title.trim() || null
			const apply = decideTabTitle({
				pinned: tab.customName !== null,
				restored: tab.restored,
				titleSettled: tab.titleSettled,
				sinceAttachMs: performance.now() - tab.attachedAt,
				incoming: normalized,
				...(helm.titleStickyMs !== null ? { stickyWindowMs: helm.titleStickyMs } : {}),
			})
			if (apply) {
				tab.title = normalized
				tab.titleRaw = title.trim()
				if (!isShellDefaultTitle(normalized)) tab.titleSettled = true
				// Persist only APPLIED titles: a suppressed shell-default title must
				// not clobber the registry's restored name either. While pinned,
				// lastTitle stays put — customName owns the restored label.
				if (tab.sessionId) helm.sessions.setTitle(tab.sessionId, normalized)
				renderTabLabel(tab)
			} else if (tab.customName !== null) {
				renderTabLabel(tab) // label unchanged (pin), tooltip follows live OSC
			}
			if (tab.parked) updateBackgroundUi()
		})
		term.onScroll(() => scheduleScrollbarSync(tab))
		term.onResize(() => scheduleScrollbarSync(tab))
		// Content growth while scrolled up moves no viewport (no onScroll fires)
		// but changes the thumb's proportion — onWriteParsed catches it.
		term.onWriteParsed(() => scheduleScrollbarSync(tab))

		tabButton.addEventListener('pointerdown', event => beginTabPointerDrag(tab, event))
		// Keep the second press owned by the completed rename gesture rather than
		// re-dispatching activation while dblclick is still being assembled.
		tabButton.addEventListener(
			'mousedown',
			event => {
				if (event.detail < 2) return
				helm.tabs.guardNativeDoubleClick()
				event.preventDefault()
				event.stopImmediatePropagation()
			},
			{ capture: true },
		)
		tabButton.addEventListener('click', () => {
			if (suppressTabClick.delete(tab)) return
			activate(tab)
		})
		// Double-clicking a tab is rename only; native AppKit zoom is disabled in main.
		tabButton.addEventListener('dblclick', event => {
			event.preventDefault()
			event.stopImmediatePropagation()
			if (event.target instanceof Node && close.contains(event.target)) return
			// Finish dispatch before replacing the label with a focused native input.
			requestAnimationFrame(() => {
				if (!disposed) startRename(tab)
			})
		})
		tabButton.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault()
				activate(tab)
			}
		})
		tabButton.addEventListener('contextmenu', event => {
			event.preventDefault()
			openTabMenu(tab, event.clientX, event.clientY)
		})
		close.addEventListener('click', event => {
			event.stopPropagation()
			closeTab(tab)
		})

		runtimeById.set(tab.visualId, tab)
		inventoryPlacement(tab, 'add')
		if (!placementHydrated) {
			if (startParked) {
				// Headless: hidden holder, no strip button — listed in the popover only.
				parked.push(tab)
				updateBackgroundUi()
			} else {
				tabs.push(tab)
				renderTabGroups()
				activate(tab)
				fitTab(tab)
			}
		} else if (!startParked) {
			// Snapshot projection owns the arrays post-hydration; selection is canonical too.
			void placement.execute({ type: 'select', id: placementId(tab) })
		}

		// Restore-before-attach: write the previous run's screen into the fresh
		// xterm BEFORE the live dtach stream lands (startup tabs, background
		// restore, and grace-undo all pass sessionId — one seam). The reattach
		// WINCH repaint then redraws the prompt/TUI in place under the restored
		// content; snapshot/live overlap needs no marker line. Awaited before
		// spawn so no live byte can beat the snapshot into the write queue.
		if (opts?.sessionId) {
			try {
				const snapshot = await helm.buffers.read(opts.sessionId)
				if (snapshot && !tab.closed) {
					tab.term.write(snapshot, () => {
						if (tab.closed) return
						// Belt-and-braces first-paint guard: force the restored frame
						// onto the screen even if the session never emits another byte.
						tab.term.refresh(0, tab.term.rows - 1)
						scheduleScrollbarSync(tab)
					})
				}
			} catch {
				// no snapshot — the reattach shows the live redraw only
			}
		}

		// Spawn with the best-known size, but treat it as provisional: layout can
		// settle during the await (activate()'s rAF fit, fonts, first paint), and
		// any term.resize in that window is LOST — onResize is attached only below.
		const spawnCols = term.cols
		const spawnRows = term.rows
		const spawned = opts?.attachedPty ?? (await helm.pty.spawn(spawnCols, spawnRows, opts?.sessionId))
		if (tab.closed) {
			helm.pty.kill(spawned.id)
			return
		}
		tab.ptyId = spawned.id
		tab.sessionId = spawned.sessionId
		// Fresh visual IDs gain a durable binding only after spawn; flush the
		// canonical placement now without replacing its local unbound ordering.
		if (placementHydrated) void placement.flushDurability()
		// The pty is attached NOW — restored-title stickiness counts from here.
		tab.attachedAt = performance.now()
		// Re-assert the parked flag under the REAL session id (a fresh spawn mints
		// one) so a parked terminal relaunches as parked. Same for a rename pin
		// committed while the spawn was in flight.
		if (tab.customName !== null && spawned.sessionId) helm.sessions.setCustomName(spawned.sessionId, tab.customName)
		term.onData(data => {
			if (!tab.transferring) helm.pty.write(spawned.id, data)
		})
		term.onResize(({ cols, rows }) => helm.pty.resize(spawned.id, cols, rows))
		// spawn → mount → fit → resize pty: re-fit now that layout settled, then
		// force the pty onto the fitted size (with a WINCH nudge for reattached
		// sessions whose remote app still believes the previous run's size).
		// A tab restored from the background mid-spawn lands here too (parked is
		// false again), replaying the fitted size the lost-resize window ate.
		if (!tab.parked) {
			fitTab(tab)
			syncPtySize(tab, spawnCols, spawnRows, opts?.sessionId !== undefined || opts?.attachedPty !== undefined)
		}
	}

	const unsubscribePtyData = helm.pty.onData((id, data) => {
		if (disposed) return
		const tab = findByPty(id)
		if (!tab) return
		tab.progressTracker.feed(data)
		// Session-backed spawns: swallow dtach's one-time attach clear so it can't
		// wipe the restored snapshot (non-dtach fallback ptys emit no such prefix).
		let output = data
		if (tab.attachClearPending && tab.sessionId !== null) {
			output = filterAttachClear(tab, data)
			if (output === '') return
		}
		tab.outputGuard.write(output, (data, onParsed) => tab.term.write(data, onParsed))
		tab.dirty = true // snapshot autosave picks this tab up on the next tick
	})

	const unsubscribePtyExit = helm.pty.onExit((id, exitCode) => {
		if (disposed) return
		const tab = findByPty(id)
		if (!tab) return
		tab.outputGuard.abort()
		tab.progressTracker.clear()
		tab.ptyId = null // pty is gone; don't kill it again on close
		tab.dirty = false // session over — its snapshot is reaped with it, don't re-save
		if (tab.parked) {
			// Exited in the background: keep the row (state "Exited"), no toast spam.
			// The exit burst is a death rattle, not activity — the state says it all.
			tab.exitCode = exitCode
			tab.placementEligible = false
			updateBackgroundUi()
		} else {
			closeTab(tab)
		}
	})

	// Debounced refit on pane size changes (~50ms): #terms tracks every source of
	// terminal-pane width change (divider drag, window resize, --left-width), and
	// rapid divider drags would otherwise refit + pty-resize every pointermove.
	// The drag-end pointerup calls fitActive() directly for the final size.
	let fitTimer: ReturnType<typeof setTimeout> | undefined
	const terminalResizeObserver = new ResizeObserver(() => {
		clearTimeout(fitTimer)
		fitTimer = setTimeout(fitActive, 50)
	})
	terminalResizeObserver.observe(termsEl)

	// ---------- appearance: live re-theme + font-size ----------

	// Theme/font changes re-apply to every open terminal. Only the ACTIVE tab can
	// refit (hidden holders measure 0x0); background tabs refit in activate()'s
	// rAF, so every terminal lands on the new metrics by the time it's visible.
	const unsubscribeAppearance = appearance.subscribe(() => {
		const theme = appearance.getTermTheme()
		const fontSize = appearance.getTermFontSize()
		for (const tab of [...tabs, ...parked]) {
			tab.term.options.theme = theme
			if (tab.term.options.fontSize !== fontSize) tab.term.options.fontSize = fontSize
		}
		fitActive()
	})

	// cmd+= / cmd+- / cmd+0 (View menu accelerators — same main→IPC pattern as
	// cmd+t): bounds + persistence live in the appearance store.
	const unsubscribeFontStep = helm.appearance.onFontStep(step => appearance.stepTermFontSize(step))

	// First-paint guard: cell metrics measured before a font finished loading
	// mis-size the grid until the next resize — refit once the font set settles.
	// (SF Mono/Menlo are local, so this usually resolves before the first fit.)
	void document.fonts.ready.then(() => {
		if (!disposed) fitActive()
	})

	// New-tab actions are gated until session restore finishes, so restored tabs
	// always come first and a fast cmd+T can't interleave with reattachment.
	let tabsReady = false
	let resolveTabsReady!: () => void
	const tabsReadyPromise = new Promise<void>(resolve => {
		resolveTabsReady = resolve
	})

	const onNewTabClick = () => {
		if (tabsReady) void createTerminal()
	}
	newTabButton.addEventListener('click', onNewTabClick)
	const unsubscribeTabNew = helm.tabs.onNew(() => {
		if (tabsReady) void createTerminal()
	})
	const unsubscribeTabClose = helm.tabs.onClose(() => {
		if (!activeTab) return
		if (activeTab.parked) killParkedTab(activeTab)
		else closeTab(activeTab)
	})
	// ⌘⇧B (Shell menu accelerator — xterm swallows renderer keys): park the
	// active tab into the background list.
	const unsubscribeTabBackground = helm.tabs.onBackground(() => {
		if (tabsReady && activeTab) parkTab(activeTab)
	})
	// Shell menu accelerators are main-process events because xterm owns terminal input.
	const unsubscribeTabPrevious = helm.tabs.onPrevious(() => {
		if (tabsReady) cycleTab(-1)
	})
	const unsubscribeTabNext = helm.tabs.onNext(() => {
		if (tabsReady) cycleTab(1)
	})

	// cmd+1..9 select tab, cmd+shift+[ / ] cycle. Capture phase so the shortcuts
	// win over xterm's own key handling when a terminal has focus.
	const onWorkspaceKeydown = (event: KeyboardEvent) => {
		if (!event.metaKey || event.ctrlKey || event.altKey) return
		if (!event.shiftKey && /^[1-9]$/.test(event.key)) {
			const target = tabs[Number(event.key) - 1]
			if (target) {
				event.preventDefault()
				activate(target)
			}
			return
		}
		if (event.shiftKey && (event.code === 'BracketLeft' || event.code === 'BracketRight')) {
			event.preventDefault()
			cycleTab(event.code === 'BracketRight' ? 1 : -1)
		}
	}
	window.addEventListener('keydown', onWorkspaceKeydown, { capture: true })

	// --ui-preview=background[-strip] (screenshot harness): park one running and
	// one exited session — real ptys, really parked — so the strip control, badge,
	// and both popover row states are capturable without a daemon or manual setup.
	// `background` opens the popover; `background-strip` leaves it closed.
	async function runUiPreview(): Promise<void> {
		const preview = helm.uiPreview
		let previewGroupId: string | null = null
		if (preview === 'running-tab' || preview === 'attention-tab') {
			if (activeTab) {
				if (preview === 'running-tab') setTabAgentRunning(activeTab, true)
				else setTabAgentAttention(activeTab, true)
			}
			return
		}
		if (preview === 'tab-drag') {
			while (tabs.length < 3) await createTerminal().catch(() => {})
			const names = ['api', 'deploy', 'logs']
			tabs.forEach((tab, index) => commitCustomName(tab, names[index] ?? `shell ${index + 1}`))
			const tab = tabs.at(-1)
			const first = tabs[0]
			if (tab && first) {
				const source = tab.tabButton.getBoundingClientRect()
				const target = first.tabButton.getBoundingClientRect()
				const drag = createTabPointerDrag(tab, -1, source.left + source.width / 2, source.top + source.height / 2)
				tabPointerDrag = drag
				drag.x = target.left + target.width * 0.25
				drag.y = target.top + target.height / 2 + 3
				startTabPointerDrag(drag)
			}
			return
		}
		// background-park: park the ACTIVE tab (after any --term-cmd output landed)
		// so a later run against the same profile/socket pool verifies parked
		// snapshot restore. background-open previews the first parked holder without
		// changing ownership; background-restore moves it back to a tab.
		if (preview === 'background-park') {
			await new Promise(resolve => setTimeout(resolve, 1500))
			if (activeTab) parkTab(activeTab)
			return
		}
		if (preview === 'background-restore') {
			const first = parked[0]
			if (first) restoreParked(first)
			return
		}
		// rename-edit: open the inline rename editor on the active tab (input
		// styling + select-all shot). rename: commit the fixed pin "deploy watch"
		// through the SAME commit path the editor uses, so a relaunch against the
		// same profile/socket pool verifies pin persistence.
		if (preview === 'rename-edit') {
			await new Promise(resolve => setTimeout(resolve, 800)) // let activate()'s rAF focus settle first
			const tab = activeTab
			if (tab) startRename(tab)
			return
		}
		if (preview === 'rename') {
			const tab = activeTab
			if (tab) commitCustomName(tab, 'deploy watch')
			return
		}
		if (
			preview !== 'background' &&
			preview !== 'background-strip' &&
			preview !== 'background-open' &&
			preview !== 'background-drag' &&
			preview !== 'background-grouped-tab-drag' &&
			preview !== 'background-group-drag'
		)
			return
		await createTerminal().catch(() => {})
		const exiting = activeTab
		if (exiting) {
			parkTab(exiting)
			// A real exit, observed through the normal pty:exit path → "Exited (0)".
			if (exiting.ptyId !== null) helm.pty.write(exiting.ptyId, 'exit\r')
		}
		await createTerminal().catch(() => {})
		const running = activeTab
		if ((preview === 'background-grouped-tab-drag' || preview === 'background-group-drag') && exiting && running) {
			const sessionIds = [exiting.sessionId, running.sessionId].filter((id): id is string => id !== null)
			const group = sessionIds.length === 2 ? await helm.sessions.groups.create('Delivery', sessionIds) : null
			if (group) {
				previewGroupId = group.id
				const groups = await helm.sessions.groups.list().catch(() => [])
				reconcilePlacementGroups(groups)
				await placement.execute({ type: 'set-membership', id: placementId(exiting), groupId: group.id })
				await placement.execute({ type: 'set-membership', id: placementId(running), groupId: group.id })
			}
			commitCustomName(exiting, 'release logs')
			commitCustomName(running, 'deploy agent')
		}
		if (running) {
			if (preview === 'background-drag') commitCustomName(running, 'background deploy')
			parkTab(running)
			setTabAgentRunning(running, true)
		}
		if (preview === 'background-grouped-tab-drag' && exiting) restoreParked(exiting)
		if (preview === 'background') openBackgroundPopover()
		else if (preview === 'background-open' && running) openParked(running)
		else if ((preview === 'background-drag' || preview === 'background-grouped-tab-drag') && running) {
			openBackgroundPopover()
			await new Promise(requestAnimationFrame)
			const row = [...bgRows.querySelectorAll<HTMLElement>('.bg-row')].find(
				candidate => candidate.dataset.tabId === tabIdentity(running),
			)
			const source = row?.querySelector<HTMLButtonElement>('.bg-open')
			if (source) {
				const sourceRect = source.getBoundingClientRect()
				const drag = createBackgroundTabPointerDrag(
					running,
					source,
					-1,
					sourceRect.left + sourceRect.width / 2,
					sourceRect.top + sourceRect.height / 2,
				)
				backgroundTabPointerDrag = drag
				const receiver = tabStripRegion.getBoundingClientRect()
				drag.x =
					preview === 'background-grouped-tab-drag'
						? receiver.left + receiver.width * 0.08
						: receiver.left + receiver.width * 0.72
				drag.y = receiver.top + receiver.height / 2
				startBackgroundTabPointerDrag(drag)
			}
		} else if (preview === 'background-group-drag') {
			openBackgroundPopover()
			await new Promise(requestAnimationFrame)
			const section = previewGroupId
				? tabGroupComposition().background.find(candidate => candidate.groupId === previewGroupId)
				: null
			const header = previewGroupId
				? backgroundGroupElement(previewGroupId)?.querySelector<HTMLButtonElement>('[data-tab-group-header]')
				: null
			if (section && header) {
				const sourceRect = header.getBoundingClientRect()
				const drag = createGroupPointerDrag(
					section,
					header,
					-1,
					sourceRect.left + sourceRect.width / 2,
					sourceRect.top + sourceRect.height / 2,
				)
				if (drag) {
					groupPointerDrag = drag
					const receiver = tabStripRegion.getBoundingClientRect()
					drag.x = receiver.left + receiver.width * 0.72
					drag.y = receiver.top + receiver.height / 2
					startGroupPointerDrag(drag)
				}
			}
		}
	}

	// Main-owned scheduled adoption is deliberately not a renderer command. It
	// hands over only an opaque attached PTY/session pair after durable registry
	// ownership; the preload immediately acknowledges mounting success.
	const unsubscribeScheduledOpen = helm.sessions.onScheduledOpen(async terminal => {
		if (disposed) return false
		if (!tabsReady) await tabsReadyPromise
		if (tabs.some(tab => tab.ptyId === terminal.ptyId || tab.sessionId === terminal.sessionId)) return false
		try {
			await createTerminal({
				sessionId: terminal.sessionId,
				title: terminal.title,
				customName: terminal.customName,
				parked: terminal.parked,
				groupId: terminal.groupId,
				agentRunning: terminal.agentRunning,
				agentAttention: terminal.agentAttention,
				attachedPty: { id: terminal.ptyId, sessionId: terminal.sessionId },
				placementEligible: true,
			})
			return true
		} catch {
			return false
		}
	})

	// Startup: reattach every dtach session that survived the previous run —
	// non-parked sessions as strip tabs (saved titles restored), parked sessions
	// headless into the background popover. Fresh single tab only when no strip
	// tab survived. Zero tabs stays a valid state after that — closing restored
	// tabs never respawns.
	let previewTimer: ReturnType<typeof setTimeout> | undefined
	const ready = (async () => {
		let restored: RestoredSession[] = []
		try {
			const loaded = await Promise.all([helm.sessions.list(), helm.sessions.groups.list()])
			restored = loaded[0]
			tabGroups = loaded[1]
		} catch {
			// persistence unavailable — fall through to a fresh tab
		}
		const stripSessions = restored.filter(s => !s.parked)
		const parkedSessions = restored.filter(s => s.parked)
		if (stripSessions.length === 0) {
			await createTerminal().catch(() => {})
		} else {
			for (const session of stripSessions) {
				// One failed reattach must not sink the remaining sessions.
				await createTerminal({
					sessionId: session.sessionId,
					title: session.title,
					customName: session.customName,
					groupId: session.groupId,
					placementEligible: session.placementEligible,
				}).catch(() => {})
			}
			const first = tabs[0]
			if (first) activate(first)
		}
		for (const session of parkedSessions) {
			await createTerminal({
				sessionId: session.sessionId,
				title: session.title,
				customName: session.customName,
				groupId: session.groupId,
				parked: true,
				placementEligible: session.placementEligible,
			}).catch(() => {})
		}
		hydratePlacement()
		if (tabs[0]) await placement.execute({ type: 'select', id: placementId(tabs[0]) })
		tabsReady = true
		resolveTabsReady()
		// --term-cmd (screenshot harness): type a command into the first tab's
		// shell. The pty input buffer holds it until the shell is ready to read.
		// (read through a closure: top-level CFA otherwise keeps activeTab narrowed
		// to its `null` initializer — the createTerminal calls above reassigned it)
		const cmdTab = ((): Tab | null => activeTab)()
		if (helm.termCmd && cmdTab && cmdTab.ptyId !== null) helm.pty.write(cmdTab.ptyId, `${helm.termCmd}\r`)
		// --term-scroll (screenshot harness): after the command's output lands
		// (~2.2s < the 3s capture settle), pin the viewport to a scroll extreme so
		// the overlay scrollbar's top-reach / mid-travel are capturable.
		if (helm.termScroll) {
			const target = helm.termScroll
			previewTimer = setTimeout(() => {
				const tab = ((): Tab | null => activeTab)()
				if (!tab) return
				const buffer = tab.term.buffer.active
				tab.term.scrollToLine(target === 'top' ? 0 : Math.floor(buffer.baseY / 2))
			}, 2200)
		}
		await runUiPreview()
	})()

	return {
		ready,
		fitActive,
		dispose() {
			if (disposed) return
			disposed = true
			// The normal renderer lifetime ends on a profile renderer reload. This
			// explicit boundary is nevertheless required for future browser mounts:
			// stop bridge feeds, active drags, pending fit work, and xterm views.
			unsubscribeTerminalTransfer()
			unsubscribePlacement()
			placement.dispose()
			unsubscribeBuffersFlush()
			unsubscribePtyData()
			unsubscribePtyExit()
			unsubscribeAppearance()
			unsubscribeFontStep()
			unsubscribeTabNew()
			unsubscribeTabClose()
			unsubscribeTabBackground()
			unsubscribeTabPrevious()
			unsubscribeTabNext()
			unsubscribeScheduledOpen()
			window.removeEventListener('focus', onWindowFocus)
			window.removeEventListener('keydown', onWorkspaceKeydown, { capture: true })
			newTabButton.removeEventListener('click', onNewTabClick)
			bgToggle.removeEventListener('click', onBackgroundToggle)
			closeBackgroundPopover()
			closeTabMenu()
			terminalResizeObserver.disconnect()
			clearInterval(snapshotAutosave)
			finishTabPointerDrag(true)
			if (pendingTabDragSettlement) settleTabPreview(pendingTabDragSettlement, null, false)
			finishBackgroundTabPointerDrag(true)
			finishGroupPointerDrag(true)
			clearTimeout(fitTimer)
			clearTimeout(previewTimer)
			for (const tab of [...tabs, ...parked]) {
				tab.outputGuard.abort()
				tab.progressTracker.clear()
				tab.term.dispose()
			}
		},
	}
}
