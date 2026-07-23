import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { profileRuntimeRoot } from '../profiles/runtime.js'
import { itemExecutionMode } from './execution.js'
import type { ItemRecord } from './schema.js'
import type { ItemEvent, ItemStore } from './store.js'

const execFileAsync = promisify(execFile)

export type RunObservationSource = 'none' | 'solve' | 'loop'
export type RunObservationState = 'idle' | 'running' | 'review' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export type RunObservationTone = 'gray' | 'blue' | 'green' | 'amber' | 'red'

export interface RunObservationEvent {
	type: string
	label: string
	tone: RunObservationTone
	createdAt: string | null
}

export interface RunObservationLog {
	path: string | null
	available: boolean
	content: string
	truncated: boolean
}

export interface RunObservationPr {
	url: string | null
	state: string | null
	merged: boolean | null
}

export interface RunObservationAlmanac {
	runId: string | null
	statusPath: string | null
	status: string | null
	round: string | null
	summary: string | null
	failureReason: string | null
}

export interface RunObservation {
	source: RunObservationSource
	state: RunObservationState
	stateLabel: string
	summary: string | null
	events: RunObservationEvent[]
	log: RunObservationLog
	pr: RunObservationPr
	almanac: RunObservationAlmanac
}

export interface PrStatus {
	url?: string | null
	state: string | null
	merged?: boolean | null
}

export interface RunObservationOptions {
	store?: Pick<ItemStore, 'getEvents'>
	logRoot?: string
	maxLogBytes?: number
	readPrStatus?: (url: string) => PrStatus | Promise<PrStatus>
}

const STATE_LABEL: Record<RunObservationState, string> = {
	idle: 'Idle',
	running: 'Running',
	review: 'Review',
	completed: 'Completed',
	failed: 'Failed',
	cancelled: 'Cancelled',
	unknown: 'Unknown',
}

function sourceForItem(item: ItemRecord): RunObservationSource {
	return itemExecutionMode(item) === 'loop' ? 'loop' : 'solve'
}

function stateFromItem(item: ItemRecord): RunObservationState {
	switch (item.status) {
		case 'running':
			return 'running'
		case 'review':
			return 'review'
		case 'done':
			return 'completed'
		case 'failed':
			return 'failed'
		case 'cancelled':
			return 'cancelled'
		case 'inbox':
		case 'ready':
		case 'active':
			return 'idle'
	}
}

function stateFromAlmanacStatus(status: string | null, fallback: RunObservationState): RunObservationState {
	switch (status) {
		case 'running':
			return 'running'
		case 'done':
			return 'completed'
		case 'failed':
			return 'failed'
		case 'aborted':
			return 'cancelled'
		case null:
		case '':
			return fallback
		default:
			return 'unknown'
	}
}

function eventTone(type: string): RunObservationTone {
	if (type.includes('failed')) return 'red'
	if (type.includes('cancelled') || type.includes('rejected')) return 'amber'
	if (
		type.includes('completed') ||
		type === 'action_completed' ||
		type.includes('merged') ||
		type.includes('succeeded')
	)
		return 'green'
	if (
		type.includes('started') ||
		type.includes('approved') ||
		type.includes('retried') ||
		type.includes('reopened') ||
		type.includes('reconciled') ||
		type.startsWith('solve_')
	)
		return 'blue'
	return 'gray'
}

function formatPrLabel(url: string): string {
	const match = url.match(/\/pull\/(\d+)/)
	return match ? `PR #${match[1]}` : 'PR'
}

function parsePayload(event: ItemEvent): Record<string, unknown> | null {
	if (!event.payload) return null
	try {
		const parsed = JSON.parse(event.payload)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
	} catch {
		return null
	}
}

function eventLabel(event: ItemEvent): string {
	const payload = parsePayload(event)
	switch (event.eventType) {
		case 'item_started':
			return 'Item started'
		case 'item_approved':
			return 'Intent approved'
		case 'item_rejected':
			return 'Intent rejected'
		case 'item_retried':
			return 'Run queued again'
		case 'item_reopened':
			return 'Moved to review without rerunning'
		case 'item_reconciled':
			return 'Shippable work reconciled for review'
		case 'item_merged':
			return 'Pull request merged'
		case 'deploy_succeeded':
			return `Deployment succeeded${payload?.environment ? `: ${payload.environment}` : ''}`
		case 'deploy_merged':
			return 'Merge observed'
		case 'item_status_set':
			return `Status set${payload?.status ? `: ${payload.status}` : ''}`
		case 'item_recovered':
			return 'Recovered stale processing Item'
		case 'solve_completed':
			return `Solve completed${payload?.summary ? `: ${payload.summary}` : ''}`
		case 'loop_completed':
			return `Loop completed${payload?.summary ? `: ${payload.summary}` : ''}`
		case 'almanac_run_started':
			return `Almanac run started${payload?.runId ? `: ${payload.runId}` : ''}`
		case 'item_failed':
			return `Failed${payload?.phase ? ` (${payload.phase})` : ''}${payload?.error ? `: ${payload.error}` : ''}`
		case 'item_cancelled':
			return 'Cancelled'
		case 'pr_created':
			return `PR created${typeof payload?.url === 'string' ? `: ${formatPrLabel(payload.url)}` : ''}`
		case 'comment_posted':
			return 'Provider comment posted'
		case 'dispatch_skipped':
			return `Dispatch skipped${payload?.reason ? `: ${payload.reason}` : ''}`
		case 'action_completed':
			return 'Action completed'
		default:
			if (event.eventType.startsWith('solve_') && payload?.detail) return String(payload.detail)
			return event.eventType.replace(/_/g, ' ')
	}
}

function readEvents(item: ItemRecord, store: RunObservationOptions['store']): RunObservationEvent[] {
	if (!store) return []
	try {
		return store.getEvents(item.id).map(event => ({
			type: event.eventType,
			label: eventLabel(event),
			tone: eventTone(event.eventType),
			createdAt: event.createdAt,
		}))
	} catch {
		return []
	}
}

function readLog(item: ItemRecord, opts: RunObservationOptions): RunObservationLog {
	const logRoot = opts.logRoot ?? resolve(profileRuntimeRoot(item.profileId), 'logs')
	const logPath = join(logRoot, `${item.id}.log`)
	const maxBytes = opts.maxLogBytes ?? 20_000
	try {
		const size = statSync(logPath).size
		const content = readFileSync(logPath)
		const truncated = size > maxBytes
		const slice = truncated ? content.subarray(size - maxBytes) : content
		return {
			path: logPath,
			available: true,
			content: slice.toString('utf-8'),
			truncated,
		}
	} catch {
		return {
			path: logPath,
			available: false,
			content: '',
			truncated: false,
		}
	}
}

async function defaultReadPrStatus(url: string): Promise<PrStatus> {
	try {
		const { stdout: raw } = await execFileAsync('gh', ['pr', 'view', url, '--json', 'state,merged,url'], {
			timeout: 10_000,
		})
		const parsed = JSON.parse(raw) as { state?: unknown; merged?: unknown; url?: unknown }
		return {
			url: typeof parsed.url === 'string' ? parsed.url : url,
			state: typeof parsed.state === 'string' ? parsed.state : 'unknown',
			merged: typeof parsed.merged === 'boolean' ? parsed.merged : null,
		}
	} catch {
		return { url, state: 'unknown', merged: null }
	}
}

async function readPr(item: ItemRecord, opts: RunObservationOptions): Promise<RunObservationPr> {
	if (!item.prUrl) return { url: null, state: null, merged: null }
	try {
		const status = await (opts.readPrStatus ?? defaultReadPrStatus)(item.prUrl)
		return {
			url: status.url ?? item.prUrl,
			state: status.state ?? 'unknown',
			merged: status.merged ?? null,
		}
	} catch {
		return { url: item.prUrl, state: 'unknown', merged: null }
	}
}

function readTsvRecord(path: string): Record<string, string> | null {
	if (!existsSync(path)) return null
	const fields: Record<string, string> = {}
	try {
		const lines = readFileSync(path, 'utf-8').split(/\r?\n/)
		for (const line of lines) {
			if (!line) continue
			const [key, ...rest] = line.split('\t')
			if (!key) continue
			fields[key] = rest.join('\t')
		}
		return fields
	} catch {
		return null
	}
}

function readAlmanac(item: ItemRecord): RunObservationAlmanac {
	if (itemExecutionMode(item) !== 'loop') {
		return { runId: null, statusPath: null, status: null, round: null, summary: null, failureReason: null }
	}
	if (!item.almanacRunId || !item.worktreePath) {
		return {
			runId: item.almanacRunId,
			statusPath: null,
			status: null,
			round: null,
			summary: null,
			failureReason: null,
		}
	}
	const statusPath = join(item.worktreePath, '.almanac', 'runs', item.almanacRunId, 'status.tsv')
	const record = readTsvRecord(statusPath)
	const failureReason = record?.failure_reason ?? null
	return {
		runId: item.almanacRunId,
		statusPath,
		status: record?.status ?? null,
		round: record?.round ?? null,
		summary: record?.summary ?? failureReason,
		failureReason,
	}
}

export async function observeItemRun(item: ItemRecord, opts: RunObservationOptions = {}): Promise<RunObservation> {
	const source = sourceForItem(item)
	const events = readEvents(item, opts.store)
	const log = readLog(item, opts)
	const pr = await readPr(item, opts)
	const almanac = readAlmanac(item)
	const fallbackState = stateFromItem(item)
	const missingAlmanacRecord = source === 'loop' && !!almanac.runId && !!almanac.statusPath && !almanac.status
	const state = missingAlmanacRecord
		? 'unknown'
		: source === 'loop'
			? stateFromAlmanacStatus(almanac.status, fallbackState)
			: fallbackState
	const summary = almanac.summary || item.resultSummary || item.errorMessage

	return {
		source,
		state,
		stateLabel: STATE_LABEL[state],
		summary,
		events,
		log,
		pr,
		almanac,
	}
}

export function emptyRunObservation(item: ItemRecord): RunObservation {
	const source = sourceForItem(item)
	const state = stateFromItem(item)
	return {
		source,
		state,
		stateLabel: STATE_LABEL[state],
		summary: item.resultSummary || item.errorMessage,
		events: [],
		log: {
			path: null,
			available: false,
			content: '',
			truncated: false,
		},
		pr: {
			url: item.prUrl,
			state: null,
			merged: null,
		},
		almanac: {
			runId: item.almanacRunId,
			statusPath: null,
			status: null,
			round: null,
			summary: null,
			failureReason: null,
		},
	}
}
