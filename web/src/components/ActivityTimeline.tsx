import { useEffect, useState } from 'react'
import { type EventEntry, api } from '../api'

const eventIcons: Record<string, string> = {
	task_discovered: '>>',
	task_queued: '[]',
	solver_started: '>>',
	solver_completed: 'OK',
	solver_failed: '!!',
	task_cancelled: '--',
	status_changed: '~~',
	pr_created: 'PR',
	comment_posted: '--',
	action_completed: 'OK',
	claude_file_read: '..',
	claude_edit: '~~',
	claude_command: '$>',
	claude_assessment: '??',
	claude_error: '!!',
	claude_tool_call: '()',
}

const eventColors: Record<string, string> = {
	task_discovered: 'var(--text-3)',
	task_queued: 'var(--text-3)',
	solver_started: 'var(--blue)',
	solver_completed: 'var(--green)',
	solver_failed: 'var(--red)',
	task_cancelled: 'var(--amber)',
	status_changed: 'var(--accent)',
	pr_created: 'var(--accent)',
	comment_posted: 'var(--text-3)',
	action_completed: 'var(--green)',
	claude_file_read: 'var(--text-4)',
	claude_edit: 'var(--amber)',
	claude_command: 'var(--blue)',
	claude_assessment: 'var(--accent)',
	claude_error: 'var(--red)',
	claude_tool_call: 'var(--text-3)',
}

export function ActivityTimeline({ taskId }: { taskId: string }) {
	const [events, setEvents] = useState<EventEntry[]>([])

	useEffect(() => {
		api.taskEvents(taskId).then(setEvents).catch(console.error)
	}, [taskId])

	if (events.length === 0) {
		return <p style={{ color: 'var(--text-4)', fontSize: 13 }}>No events recorded.</p>
	}

	// Collapse consecutive duplicate event types (e.g. repeated task_queued from restarts)
	const deduped = events.filter((event, i) => {
		if (i === 0) return true
		return event.eventType !== events[i - 1].eventType
	})

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
			{deduped.map(event => {
				const payload = event.payload ? JSON.parse(event.payload) : null
				const icon = eventIcons[event.eventType] ?? '>>'
				const color = eventColors[event.eventType] ?? 'var(--text-3)'
				const time = new Date(event.createdAt).toLocaleTimeString([], {
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit',
					hour12: false,
				})
				const label = formatEvent(event.eventType, payload)

				return (
					<div
						key={event.id}
						style={{
							display: 'flex',
							alignItems: 'flex-start',
							gap: 10,
							padding: '5px 0',
							fontSize: 12,
						}}
					>
						<span
							style={{ color: 'var(--text-4)', fontFamily: 'var(--font-mono)', width: 60, flexShrink: 0, fontSize: 11 }}
						>
							{time}
						</span>
						<span
							style={{
								color,
								fontFamily: 'var(--font-mono)',
								width: 22,
								flexShrink: 0,
								textAlign: 'center',
								fontSize: 11,
							}}
						>
							{icon}
						</span>
						<span style={{ color: 'var(--text-2)', lineHeight: 1.4 }}>{label}</span>
					</div>
				)
			})}
		</div>
	)
}

function formatEvent(type: string, payload: Record<string, unknown> | null): string {
	if (!payload) return type.replace(/_/g, ' ')

	switch (type) {
		case 'task_discovered':
			return `Discovered: ${payload.title ?? '?'}`
		case 'solver_completed':
			return `Assessment: ${payload.tier} (confidence: ${payload.confidence})`
		case 'solver_failed':
			return `Failed (${payload.phase ?? '?'}): ${payload.error ?? '?'}`
		case 'task_cancelled':
			return 'Cancelled'
		case 'status_changed':
			return `Status changed to ${payload.status}${payload.manual ? ' (manual)' : ''}`
		case 'pr_created':
			return `PR created${payload.draft ? ' (draft)' : ''}${payload.shippedByClaude ? ' by Claude' : ''}: ${payload.url ?? '?'}`
		case 'claude_file_read':
		case 'claude_edit':
		case 'claude_command':
		case 'claude_tool_call':
			return String(payload.detail ?? type)
		default:
			return type.replace(/_/g, ' ')
	}
}
