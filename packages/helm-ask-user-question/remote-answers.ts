import { randomUUID } from 'node:crypto'
import type { QuestionParams, QuestionnaireResult } from './tool/types.js'

/** Fork-owned protocol: JSON-only events; never expose the TUI completion callback. */
export const QUESTION_OPEN = 'helm:question:open.v1'
export const QUESTION_ANSWER = 'helm:question:answer.v1'
export const QUESTION_CLOSED = 'helm:question:closed.v1'
export const QUESTION_RECEIPT = 'helm:question:receipt.v1'

export interface QuestionBus {
	on(channel: string, listener: (value: unknown) => void): () => void
	emit(channel: string, value: unknown): void
}

type Selection = { option: number } | { options: number[] } | { text: string }
export interface RemoteQuestionAnswer {
	requestId: string
	commandId: string
	answers: Selection[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** Indices resolve against the tool's immutable input, not browser-authored labels. */
export function resolveRemoteAnswers(params: QuestionParams, value: unknown): QuestionnaireResult | null {
	if (!Array.isArray(value) || value.length !== params.questions.length) return null
	const answers: QuestionnaireResult['answers'] = []
	for (let index = 0; index < value.length; index++) {
		const selection: unknown = value[index]
		const question = params.questions[index]
		if (!isRecord(selection) || Object.keys(selection).length !== 1) return null
		const base = { questionIndex: index, question: question.question }
		if ('text' in selection) {
			if (typeof selection.text !== 'string' || !selection.text.trim() || selection.text.length > 4000) return null
			answers.push({ ...base, kind: 'custom', answer: selection.text })
		} else if ('option' in selection && !question.multiSelect) {
			const option = selection.option
			if (typeof option !== 'number' || !Number.isInteger(option) || option < 0 || option >= question.options.length)
				return null
			const selected = question.options[option]
			answers.push({
				...base,
				kind: 'option',
				answer: selected.label,
				...(selected.preview ? { preview: selected.preview } : {}),
			})
		} else if ('options' in selection && question.multiSelect) {
			const options = selection.options
			if (
				!Array.isArray(options) ||
				options.length > question.options.length ||
				new Set(options).size !== options.length
			)
				return null
			if (options.some(option => !Number.isInteger(option) || option < 0 || option >= question.options.length))
				return null
			answers.push({
				...base,
				kind: 'multi',
				answer: null,
				selected: options.map(option => question.options[option].label),
			})
		} else return null
	}
	return { answers, cancelled: false }
}

/** The one completion gate shared by the REAL local TUI and the remote responder. */
export function openRemoteQuestion(
	bus: QuestionBus,
	input: QuestionParams,
	done: (value: QuestionnaireResult) => void,
) {
	const requestId = randomUUID()
	const params = structuredClone(input)
	let closed = false
	let remove = () => {}
	function complete(result: QuestionnaireResult): boolean {
		if (closed) return false
		closed = true
		remove()
		try {
			done(result)
		} finally {
			bus.emit(QUESTION_CLOSED, { requestId })
		}
		return true
	}
	remove = bus.on(QUESTION_ANSWER, value => {
		if (!isRecord(value) || value.requestId !== requestId) return
		if (typeof value.commandId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value.commandId)) return
		const result = Object.keys(value).length === 3 ? resolveRemoteAnswers(params, value.answers) : null
		const accepted = result !== null && complete(result)
		bus.emit(QUESTION_RECEIPT, { requestId, commandId: value.commandId, status: accepted ? 'answered' : 'rejected' })
	})
	return {
		complete,
		publish() {
			if (!closed) bus.emit(QUESTION_OPEN, { requestId, questions: params.questions })
		},
		dispose() {
			if (closed) return
			closed = true
			remove()
			bus.emit(QUESTION_CLOSED, { requestId })
		},
	}
}
