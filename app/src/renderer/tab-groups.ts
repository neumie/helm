import type { TabGroup, TabGroupActionIntent, TabGroupSurface } from '../shared'

/** The renderer-only terminal state needed to project persisted groups. */
export interface TabGroupRendererTab {
	/** Stable renderer identity (normally the session id once one exists). */
	id: string
	/** Null and stale/unknown group ids both render in the ordinary terminal flow. */
	groupId: string | null
	/** Background ownership remains independent of group membership. */
	parked: boolean
	/** Already-arbitrated terminal label (manual pin or current title). */
	name: string
	/** Exact OSC-derived state; this helper never infers activity. */
	agentRunning: boolean
	agentAttention: boolean
}

export interface TabGroupMember extends TabGroupRendererTab {
	active: boolean
}

/**
 * A collapsed group exposes one projection rather than moving or cloning its
 * terminal tab. Its source member is always present in `members`.
 */
export interface CollapsedTabGroupProxy extends TabGroupMember {
	proxyForId: string
}

export type TabGroupAction = 'open' | 'restore' | 'background' | 'close'

/**
 * Stable, adapter-ready target for a bulk group operation. `memberIds` is an
 * ordered snapshot so future PTY/DOM wiring can perform a group effect without
 * recalculating against a changed visible/collapsed projection.
 */
export interface TabGroupActionTarget {
	action: TabGroupAction
	groupId: string
	memberIds: readonly string[]
	intent: TabGroupActionIntent
}

export interface TabGroupSection {
	/** Named groups have a persisted id; ungrouped terminals use the non-persisted bucket. */
	kind: 'group' | 'ungrouped'
	id: string
	groupId: string | null
	name: string
	surface: TabGroupSurface
	collapsed: boolean
	/** All members on this surface, in canonical renderer order. */
	members: readonly TabGroupMember[]
	/** One proxy when collapsed, otherwise the real ordered members. */
	visibleMembers: readonly TabGroupMember[]
	proxy: CollapsedTabGroupProxy | null
	/** Named group commands appropriate to this surface; ungrouped terminals have none. */
	actionTargets: readonly TabGroupActionTarget[]
}

export interface TabGroupComposition {
	strip: readonly TabGroupSection[]
	background: readonly TabGroupSection[]
}

export interface TabGroupCompositionInput {
	tabs: readonly TabGroupRendererTab[]
	groups: readonly TabGroup[]
	activeTabId: string | null
}

/** Stable disclosure target for one group's independently-collapsible surface. */
export function tabGroupMembersId(groupId: string | null, surface: TabGroupSurface): string {
	return `tab-group-members-${surface}-${groupId ?? 'ungrouped'}`
}

/**
 * A drag only measures and reorders peers from the dragged tab's own group.
 * Tabs without a group are one peer set too, identified by their shared null id.
 */
export function tabsWithGroupId<T extends { groupId: string | null }>(tabs: readonly T[], groupId: string | null): T[] {
	return tabs.filter(tab => tab.groupId === groupId)
}

/**
 * Reinsert an already-reordered group peer sequence into a flat tab order.
 * Non-peers retain both their positions relative to the flat order and their
 * relative order, so dragging one group can never move another group.
 */
export function mergeGroupPeers<T extends { groupId: string | null }>(
	tabs: readonly T[],
	groupId: string | null,
	reorderedPeers: readonly T[],
): T[] {
	const peers = tabsWithGroupId(tabs, groupId)
	if (
		peers.length !== reorderedPeers.length ||
		new Set(peers).size !== peers.length ||
		new Set(reorderedPeers).size !== reorderedPeers.length ||
		peers.some(peer => !reorderedPeers.includes(peer))
	) {
		return [...tabs]
	}
	let peerIndex = 0
	return tabs.map(tab => (tab.groupId === groupId ? (reorderedPeers[peerIndex++] ?? tab) : tab))
}

/** A stale collapse write (false or rejected) reloads only if it is still current. */
export function shouldReloadCollapsedGroup(requestVersion: number, currentVersion: number, accepted: boolean): boolean {
	return requestVersion === currentVersion && !accepted
}

const UNGROUPED_ID = 'ungrouped'
const UNGROUPED_NAME = 'Terminals'

/** Only user-created groups own a visible disclosure heading. */
export function tabGroupHeading(section: Pick<TabGroupSection, 'kind' | 'name'>): string | null {
	return section.kind === 'group' ? section.name : null
}

function membersFor(
	tabs: readonly TabGroupRendererTab[],
	groups: ReadonlyMap<string, TabGroup>,
	surface: TabGroupSurface,
	activeTabId: string | null,
): Map<string | null, TabGroupMember[]> {
	const buckets = new Map<string | null, TabGroupMember[]>()
	const seenIds = new Set<string>()
	for (const tab of tabs) {
		// A tab must have a single visual identity. Retaining the first malformed
		// duplicate makes the projection deterministic without inventing a copy.
		if (seenIds.has(tab.id)) continue
		seenIds.add(tab.id)
		if ((surface === 'background') !== tab.parked) continue
		const groupId = tab.groupId !== null && groups.has(tab.groupId) ? tab.groupId : null
		const members = buckets.get(groupId) ?? []
		members.push({ ...tab, active: tab.id === activeTabId })
		buckets.set(groupId, members)
	}
	return buckets
}

/**
 * Active wins for a collapsed proxy. Otherwise attention has priority over
 * running, then the first member in canonical order, preserving activity
 * discoverability without synthesizing group state.
 */
export function collapsedGroupProxy(members: readonly TabGroupMember[]): CollapsedTabGroupProxy | null {
	const representative =
		members.find(member => member.active) ??
		members.find(member => member.agentAttention) ??
		members.find(member => member.agentRunning) ??
		members[0]
	return representative ? { ...representative, proxyForId: representative.id } : null
}

/** Returns the deterministic bulk commands available for a named group section. */
export function tabGroupActionTargets(
	section: Pick<TabGroupSection, 'groupId' | 'surface' | 'members'>,
): TabGroupActionTarget[] {
	if (section.groupId === null) return []
	const memberIds = section.members.map(member => member.id)
	const target = (action: TabGroupAction, intent: TabGroupActionIntent): TabGroupActionTarget => ({
		action,
		groupId: section.groupId as string,
		memberIds,
		intent,
	})
	if (section.surface === 'strip') {
		return [target('background', { type: 'move-all-background', groupId: section.groupId })]
	}
	return [
		target('open', { type: 'open-all', groupId: section.groupId }),
		target('restore', { type: 'restore-all', groupId: section.groupId }),
		target('close', { type: 'close-all', groupId: section.groupId }),
	]
}

function composeSurface(
	tabs: readonly TabGroupRendererTab[],
	groups: ReadonlyMap<string, TabGroup>,
	surface: TabGroupSurface,
	activeTabId: string | null,
): TabGroupSection[] {
	const buckets = membersFor(tabs, groups, surface, activeTabId)
	return [...buckets.entries()].map(([groupId, members]) => {
		const group = groupId === null ? null : (groups.get(groupId) ?? null)
		const collapsed = group !== null && (surface === 'strip' ? group.collapsedStrip : group.collapsedBackground)
		const proxy = collapsed ? collapsedGroupProxy(members) : null
		const section: TabGroupSection = {
			kind: group === null ? 'ungrouped' : 'group',
			id: group?.id ?? UNGROUPED_ID,
			groupId: group?.id ?? null,
			name: group?.name ?? UNGROUPED_NAME,
			surface,
			collapsed,
			members,
			visibleMembers: proxy ? [proxy] : members,
			proxy,
			actionTargets: [],
		}
		section.actionTargets = tabGroupActionTargets(section)
		return section
	})
}

/**
 * Projects flat renderer tabs and persisted group metadata into independent
 * strip/background sections. Sections appear in first-member order on each
 * surface; stale membership falls back to the ordinary ungrouped flow and empty groups disappear.
 */
export function composeTabGroups({ tabs, groups, activeTabId }: TabGroupCompositionInput): TabGroupComposition {
	const groupsById = new Map<string, TabGroup>()
	for (const group of groups) {
		// Registry output is unique; retaining the first malformed duplicate keeps
		// section naming/collapse deterministic if a caller violates that contract.
		if (!groupsById.has(group.id)) groupsById.set(group.id, group)
	}
	return {
		strip: composeSurface(tabs, groupsById, 'strip', activeTabId),
		background: composeSurface(tabs, groupsById, 'background', activeTabId),
	}
}

export default { collapsedGroupProxy, composeTabGroups, tabGroupActionTargets, tabGroupHeading }
