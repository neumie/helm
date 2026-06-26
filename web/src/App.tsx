import { useCallback, useEffect, useState } from 'react'
import {
	type AppConfig,
	type DaemonStatus,
	type DashboardActionId,
	type DashboardItem,
	type PlanInfo,
	api,
} from './api'
import { EmptyState } from './components/EmptyState'
import { Header } from './components/Header'
import { ItemCreateForm } from './components/ItemCreateForm'
import { ItemDetail } from './components/ItemDetail'
import { TaskList, workAttentionCounts } from './components/TaskList'
import { useHashRoute, useInterval } from './hooks'

const DESTRUCTIVE: DashboardActionId[] = ['reject', 'cancel']

export function App() {
	const [status, setStatus] = useState<DaemonStatus | null>(null)
	const [items, setItems] = useState<DashboardItem[]>([])
	const [config, setConfig] = useState<AppConfig>({})
	const [loaded, setLoaded] = useState(false)
	const [connected, setConnected] = useState(true)
	const { selection, selectItem } = useHashRoute()
	const [projectFilter, setProjectFilter] = useState<string | null>(() => localStorage.getItem('vigil.project') || null)
	const [createDraft, setCreateDraft] = useState<{ forkFrom?: DashboardItem } | null>(null)

	const refresh = useCallback(async () => {
		try {
			const [s, i, c] = await Promise.all([api.status(), api.items(), api.config()])
			setStatus(s)
			setItems(i)
			const projectColors: Record<string, string> = {}
			for (const p of c.projects ?? []) {
				if (p.color) projectColors[p.slug] = p.color
			}
			setConfig({ ...c, projectColors })
			setConnected(true)
		} catch (err) {
			console.error('Failed to refresh:', err)
			setConnected(false)
		} finally {
			setLoaded(true)
		}
	}, [])

	useInterval(refresh, 5000)

	useEffect(() => {
		if (projectFilter) localStorage.setItem('vigil.project', projectFilter)
		else localStorage.removeItem('vigil.project')
	}, [projectFilter])

	const filteredItems = projectFilter ? items.filter(i => i.projectSlug === projectFilter) : items
	const projectSlugs = [...new Set(items.map(i => i.projectSlug))]

	const selectedItemId = selection?.kind === 'item' ? selection.id : null
	const selectedItem = selectedItemId ? (items.find(i => i.id === selectedItemId) ?? null) : null
	const selectionMissing = selectedItemId !== null && selectedItem === null && loaded && !createDraft
	const { running: runningCount, needsYou: needsCount } = workAttentionCounts(items)

	useEffect(() => {
		// Attention-first: a PR waiting on you (needs) outranks a busy daemon.
		if (needsCount > 0) document.title = `(${needsCount}) needs you · Vigil`
		else if (runningCount > 0) document.title = `(${runningCount}) running · Vigil`
		else document.title = 'Vigil'
	}, [needsCount, runningCount])

	const applyUpdated = (updated: DashboardItem) => setItems(prev => prev.map(i => (i.id === updated.id ? updated : i)))

	const handleItemAction = async (id: string, action: DashboardActionId) => {
		if (DESTRUCTIVE.includes(action) && !window.confirm(`${action[0].toUpperCase()}${action.slice(1)} this item?`)) {
			return
		}
		try {
			const updated = await api.itemAction(id, action)
			if (updated) applyUpdated(updated) // instant feedback; poll reconciles
		} catch (err) {
			console.error('Action failed:', err)
		}
		refresh()
	}

	const handlePlanItem = async (id: string): Promise<PlanInfo> => {
		const info = await api.planItem(id)
		await refresh()
		return info
	}

	const handleCreatedItem = async (created: DashboardItem | DashboardItem[]) => {
		const first = Array.isArray(created) ? created[0] : created
		setCreateDraft(null)
		await refresh()
		if (first) selectItem(first.id)
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
			{!connected && (
				<div
					style={{
						background: 'var(--red-dim)',
						color: 'var(--red)',
						padding: '6px 16px',
						fontSize: 12,
						fontWeight: 600,
						textAlign: 'center',
						borderBottom: '1px solid var(--red)',
					}}
				>
					⚠ Disconnected — can't reach the Vigil daemon. Showing last-known state.
				</div>
			)}
			<Header
				status={status}
				connected={connected}
				needsCount={needsCount}
				onNewItem={() => {
					setCreateDraft({})
					selectItem(null)
				}}
				onPoll={() => api.triggerPoll().then(refresh)}
				onTogglePause={() => {
					const action = status?.queue.paused ? api.resumeQueue : api.pauseQueue
					action().then(refresh)
				}}
			/>
			<div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
				<TaskList
					items={filteredItems}
					status={status}
					selectedItemId={selectedItemId}
					onSelectItem={id => {
						setCreateDraft(null)
						selectItem(id)
					}}
					onItemAction={handleItemAction}
					projects={projectSlugs}
					selectedProject={projectFilter}
					onProjectChange={setProjectFilter}
					projectColors={config.projectColors ?? {}}
				/>
				<main style={{ flex: 1, overflow: 'auto', padding: '32px 40px' }}>
					{createDraft ? (
						<ItemCreateForm
							projects={config.projects ?? []}
							spawnerAdapters={config.spawnerAdapters ?? []}
							forkFrom={createDraft.forkFrom ?? null}
							onCreated={handleCreatedItem}
							onCancel={() => setCreateDraft(null)}
						/>
					) : selectedItem ? (
						<ItemDetail
							item={selectedItem}
							onAction={handleItemAction}
							onPlan={handlePlanItem}
							onFork={item => {
								setCreateDraft({ forkFrom: item })
								selectItem(null)
							}}
						/>
					) : selectionMissing ? (
						<div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
							<p style={{ color: 'var(--text-4)', fontSize: 13 }}>
								That item is no longer in view — it moved or was archived.
							</p>
						</div>
					) : !loaded ? (
						<div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
							<p style={{ color: 'var(--text-4)', fontSize: 13 }}>Loading…</p>
						</div>
					) : (
						<EmptyState itemCount={items.length} activeCount={runningCount} />
					)}
				</main>
			</div>
		</div>
	)
}
