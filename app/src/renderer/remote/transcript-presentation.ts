type HistoryRecord = import('../../../../src/remote/history-protocol.js', {
	with: { 'resolution-mode': 'import' },
}).HistoryRecord
import { normalizeThinkingText } from './thinking-text.js'

type TranscriptMessage = Extract<HistoryRecord, { kind: 'message' }>['message']

export function isLegacyWholeToolActivity(message: TranscriptMessage): boolean {
	if (message.role !== 'assistant' || message.toolCalls !== undefined) return false
	if (message.text.trim() && !message.text.startsWith('\nTool: ')) return false
	return message.text.split('\n').every(line => !line.trim() || /^Tool: [^\n]{1,100}$/.test(line))
}

export function isActivityOnly(message: TranscriptMessage): boolean {
	return (
		message.role === 'toolResult' ||
		(message.role === 'assistant' &&
			(message.toolCalls !== undefined ? !message.text.trim() : isLegacyWholeToolActivity(message)))
	)
}

export function hasMeaningfulThinking(message: TranscriptMessage): boolean {
	return message.role === 'assistant' && !!message.thinking && !!normalizeThinkingText(message.thinking).trim()
}

export function isMessageVisible(message: TranscriptMessage, showActivity: boolean): boolean {
	if (
		message.role === 'assistant' &&
		message.thinking &&
		!hasMeaningfulThinking(message) &&
		!message.text.trim() &&
		!message.toolCalls
	)
		return false
	return showActivity || hasMeaningfulThinking(message) || !isActivityOnly(message)
}

export function classifyTranscriptRecord(
	record: HistoryRecord,
	showActivity: boolean,
): { visibility: 'visible' | 'known-hidden'; speaker: TranscriptMessage['role'] | null; kind: 'message' | 'marker' } {
	if (record.kind === 'marker') return { visibility: 'visible', speaker: null, kind: 'marker' }
	return {
		visibility: isMessageVisible(record.message, showActivity) ? 'visible' : 'known-hidden',
		speaker: record.message.role === 'toolResult' ? null : record.message.role,
		kind: 'message',
	}
}
