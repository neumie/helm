import { useCallback, useEffect, useState } from 'react'
import { type AppConfig, type DaemonStatus, type TaskRecord, api } from './api'
import { EmptyState } from './components/EmptyState'
import { Header } from './components/Header'
import { TaskDetail } from './components/TaskDetail'
import { TaskList } from './components/TaskList'
import { useHashRoute, useInterval } from './hooks'

export function App() {
	const [status, setStatus] = useState<DaemonStatus | null>(null)
	const [tasks, setTasks] = useState<TaskRecord[]>([])
	const [config, setConfig] = useState<AppConfig>({})
	const { selectedTaskId, selectTask } = useHashRoute()
	const [projectFilter, setProjectFilter] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		try {
			const [s, t, c] = await Promise.all([api.status(), api.tasks(), api.config() as Promise<any>])
			setStatus(s)
			setTasks(t)
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

	const filteredTasks = projectFilter ? tasks.filter(t => t.projectSlug === projectFilter) : tasks

	const projectSlugs = [...new Set(tasks.map(t => t.projectSlug))]

	const selectedTask = selectedTaskId ? (tasks.find(t => t.id === selectedTaskId) ?? null) : null
	const activeCount = tasks.filter(t => t.status === 'processing').length
	const queuedCount = tasks.filter(t => t.status === 'queued').length

	useEffect(() => {
		if (activeCount > 0) {
			document.title = `🔵 (${activeCount}) Vigil`
		} else if (queuedCount > 0) {
			document.title = `🟡 [${queuedCount}] Vigil`
		} else {
			document.title = '⚫ Vigil'
		}
	}, [activeCount, queuedCount])

	const handleRetry = async (id: string) => {
		await api.retry(id)
		refresh()
	}

	const handleCancel = async (id: string) => {
		await api.cancel(id)
		refresh()
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
			<Header
				status={status}
				onPoll={() => api.triggerPoll().then(refresh)}
				onRefresh={refresh}
				onTogglePause={() => {
					const action = status?.queue.paused ? api.resumeQueue : api.pauseQueue
					action().then(refresh)
				}}
			/>
			<div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
				<TaskList
					tasks={filteredTasks}
					status={status}
					selectedId={selectedTaskId}
					onSelect={selectTask}
					projects={projectSlugs}
					selectedProject={projectFilter}
					onProjectChange={setProjectFilter}
					projectColors={config.projectColors ?? {}}
				/>
				<main style={{ flex: 1, overflow: 'auto', padding: '32px 40px' }}>
					{selectedTask ? (
						<TaskDetail
							task={selectedTask}
							taskBaseUrl={config.taskBaseUrl}
							chatEnabled={status?.chatEnabled ?? false}
							onStart={async () => {
								await api.start(selectedTask.id)
								refresh()
							}}
							onRetry={() => handleRetry(selectedTask.id)}
							onCancel={() => handleCancel(selectedTask.id)}
							onSetStatus={async status => {
								await api.setStatus(selectedTask.id, status)
								refresh()
							}}
							onDelete={async () => {
								await api.deleteTask(selectedTask.id)
								selectTask(null)
								refresh()
							}}
						/>
					) : (
						<EmptyState taskCount={tasks.length} activeCount={tasks.filter(t => t.status === 'processing').length} />
					)}
				</main>
			</div>
		</div>
	)
}
