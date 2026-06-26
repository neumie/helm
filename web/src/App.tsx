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

export function App() {
	const [status, setStatus] = useState<DaemonStatus | null>(null)
	const [items, setItems] = useState<DashboardItem[]>([])
	const [config, setConfig] = useState<AppConfig>({})
	const { selection, selectItem } = useHashRoute()
	const [projectFilter, setProjectFilter] = useState<string | null>(null)
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
		} catch (err) {
			console.error('Failed to refresh:', err)
		}
	}, [])

	useInterval(refresh, 5000)

	const filteredItems = projectFilter ? items.filter(i => i.projectSlug === projectFilter) : items
	const projectSlugs = [...new Set(items.map(i => i.projectSlug))]

	const selectedItemId = selection?.kind === 'item' ? selection.id : null
	const selectedItem = selectedItemId ? (items.find(i => i.id === selectedItemId) ?? null) : null
	const { running: runningCount, waiting: waitingCount } = workAttentionCounts(items)

	useEffect(() => {
		if (runningCount > 0) {
			document.title = `🔵 (${runningCount}) Vigil`
		} else if (waitingCount > 0) {
			document.title = `🟡 [${waitingCount}] Vigil`
		} else {
			document.title = '⚫ Vigil'
		}
	}, [runningCount, waitingCount])

	const handleItemAction = async (id: string, action: DashboardActionId) => {
		await api.itemAction(id, action)
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

	const selectExistingItem = (id: string | null) => {
		setCreateDraft(null)
		selectItem(id)
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
			<Header
				status={status}
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
					onSelectItem={selectExistingItem}
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
					) : (
						<EmptyState itemCount={items.length} activeCount={runningCount} />
					)}
				</main>
			</div>
		</div>
	)
}
