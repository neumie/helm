import {
	HISTORY_RECORD_BYTES,
	type HistoryOmissions,
	type HistoryRecord,
	emptyHistoryOmissions,
} from './history-protocol.js'
import { projectRemoteMessage } from './message-projection.js'

export interface HistoryEntry {
	id: string
	parentId: string | null
	type: string
	message?: unknown
}
export const historyBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
/** Never split the final surrogate pair when copying a bounded field prefix. */
function prefix(text: string, length: number): string {
	return text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '')
}

/** Copies only the ordinary bounded projection, never a raw entry or custom details. */
export function projectHistoryEntry(entry: HistoryEntry): {
	record: HistoryRecord | null
	omissions: HistoryOmissions
} {
	const omissions = emptyHistoryOmissions()
	if (entry.type === 'compaction' || entry.type === 'branch_summary') {
		return {
			record: { kind: 'marker', id: entry.id, marker: entry.type === 'compaction' ? 'compaction' : 'branch-summary' },
			omissions,
		}
	}
	if (entry.type !== 'message') {
		if (entry.type === 'custom' || entry.type === 'custom_message') omissions.unsupported++
		return { record: null, omissions }
	}
	const projected = projectRemoteMessage(entry.message, entry.id)
	if (!projected) return { record: null, omissions: { ...omissions, unsupported: 1 } }
	const content =
		entry.message && typeof entry.message === 'object' && 'content' in entry.message ? entry.message.content : undefined
	if (Array.isArray(content)) {
		for (let i = 0; i < Math.min(100, content.length); i++) {
			const block = content[i]
			if (!block || typeof block !== 'object') {
				omissions.unsupported++
				continue
			}
			if (block.type === 'image') omissions.images++
			else if (
				!(block.type === 'text' && typeof block.text === 'string') &&
				!(block.type === 'thinking' && typeof block.thinking === 'string') &&
				!(block.type === 'toolCall' && typeof block.name === 'string')
			)
				omissions.unsupported++
		}
	} else if (typeof content !== 'string') omissions.unsupported++
	const record: HistoryRecord = { kind: 'message', message: { ...projected, text: '', thinking: '', toolCalls: '' } }
	// Deterministic byte priority: text, thinking, then tool names. All candidates
	// already have the8192UTF16/100-block bound before any serialization occurs.
	for (const field of ['text', 'thinking', 'toolCalls'] as const) {
		const value = projected[field] ?? ''
		let low = 0
		let high = value.length
		while (low < high) {
			const mid = Math.ceil((low + high) / 2)
			record.message[field] = prefix(value, mid)
			if (historyBytes(record) <= HISTORY_RECORD_BYTES) low = mid
			else high = mid - 1
		}
		record.message[field] = prefix(value, low)
		if (record.message[field] !== value) record.message.truncated = true
	}
	omissions.clipped = record.message.truncated ? 1 : 0
	return { record, omissions }
}
