import type {
	RemoteCatalogPage,
	RemoteDetail,
	RemoteDirectory,
	RemoteSnapshot,
	RemoteSummary,
	RemoteTerminalMetadata,
	RemoteView,
} from '../../../../src/remote/protocol.js'
import { sameRemoteTarget } from '../../../../src/remote/protocol.js'

type RemoteMessage = RemoteSnapshot['messages'][number]
type RemoteQuestion = NonNullable<RemoteSnapshot['question']>

function sameCapabilities(
	a: { prompt: boolean; interrupt: boolean; answer: boolean },
	b: { prompt: boolean; interrupt: boolean; answer: boolean },
) {
	return a.prompt === b.prompt && a.interrupt === b.interrupt && a.answer === b.answer
}

function sameTerminal(a: RemoteTerminalMetadata | undefined, b: RemoteTerminalMetadata | undefined) {
	return (
		a === b ||
		(!!a &&
			!!b &&
			a.source === b.source &&
			a.project === b.project &&
			a.worktree === b.worktree &&
			a.branch === b.branch &&
			a.name === b.name &&
			a.group === b.group)
	)
}

export function sameRemoteMessage(a: RemoteMessage, b: RemoteMessage) {
	return (
		a === b ||
		(a.id === b.id &&
			a.role === b.role &&
			a.text === b.text &&
			a.thinking === b.thinking &&
			a.toolCalls === b.toolCalls &&
			a.truncated === b.truncated)
	)
}

function sameMessageList(a: RemoteMessage[], b: RemoteMessage[]) {
	return (
		a === b ||
		(a.length === b.length &&
			a.every((message, index) => {
				const other = b[index]
				return !!other && sameRemoteMessage(message, other)
			}))
	)
}

export function reuseRemoteMessages(previous: RemoteMessage[] | undefined, next: RemoteMessage[] | undefined) {
	if (!next || !previous) return next
	if (sameMessageList(previous, next)) return previous
	const previousById = new Map(previous.map(message => [message.id, message]))
	return next.map(message => {
		const prior = previousById.get(message.id)
		return prior && sameRemoteMessage(prior, message) ? prior : message
	})
}

export function sameRemoteQuestion(a: RemoteQuestion | null | undefined, b: RemoteQuestion | null | undefined) {
	if (a === b) return true
	if (!a || !b || a.requestId !== b.requestId || a.questions.length !== b.questions.length) return false
	return a.questions.every((question, index) => {
		const other = b.questions[index]
		return (
			!!other &&
			question.question === other.question &&
			question.header === other.header &&
			question.multiSelect === other.multiSelect &&
			question.options.length === other.options.length &&
			question.options.every((option, optionIndex) => {
				const otherOption = other.options[optionIndex]
				return (
					!!otherOption &&
					option.label === otherOption.label &&
					option.description === otherOption.description &&
					option.preview === otherOption.preview
				)
			})
		)
	})
}

type RemoteSessionFields = Pick<
	RemoteSnapshot,
	| 'target'
	| 'revision'
	| 'label'
	| 'workspace'
	| 'terminal'
	| 'model'
	| 'activity'
	| 'capabilities'
	| 'historyTruncated'
> &
	Partial<Pick<RemoteView, 'connected'>>

function sameRemoteSessionFields(a: RemoteSessionFields, b: RemoteSessionFields) {
	return (
		sameRemoteTarget(a.target, b.target) &&
		a.revision === b.revision &&
		a.label === b.label &&
		a.workspace === b.workspace &&
		sameTerminal(a.terminal, b.terminal) &&
		a.model === b.model &&
		a.activity === b.activity &&
		sameCapabilities(a.capabilities, b.capabilities) &&
		a.historyTruncated === b.historyTruncated &&
		a.connected === b.connected
	)
}

function sameRemoteSummary(a: RemoteSummary, b: RemoteSummary) {
	return sameRemoteSessionFields(a, b)
}

export function sameRemoteDirectory(a: RemoteDirectory, b: RemoteDirectory) {
	return (
		a === b ||
		(a.hostEpoch === b.hostEpoch &&
			a.overlayStamp === b.overlayStamp &&
			a.sessions.length === b.sessions.length &&
			a.sessions.every((session, index) => {
				const other = b.sessions[index]
				return !!other && sameRemoteSummary(session, other)
			}))
	)
}

function sameRemoteSnapshot(a: RemoteView, b: RemoteView) {
	return (
		sameRemoteSessionFields(a, b) &&
		sameRemoteQuestion(a.question, b.question) &&
		sameMessageList(a.messages, b.messages)
	)
}

export function sameRemoteDetail(a: RemoteDetail, b: RemoteDetail) {
	return a === b || (a.hostEpoch === b.hostEpoch && a.resync === b.resync && sameRemoteSnapshot(a.snapshot, b.snapshot))
}

export function sameRemoteCatalogPage(a: RemoteCatalogPage, b: RemoteCatalogPage) {
	return (
		a === b ||
		(a.hostEpoch === b.hostEpoch &&
			a.state === b.state &&
			a.pageCursor === b.pageCursor &&
			a.previousCursor === b.previousCursor &&
			a.nextCursor === b.nextCursor &&
			a.overlayStamp === b.overlayStamp &&
			a.reason === b.reason &&
			a.omissions.malformed === b.omissions.malformed &&
			a.omissions.unsupported === b.omissions.unsupported &&
			a.rows.length === b.rows.length &&
			a.rows.every((row, index) => {
				const other = b.rows[index]
				return (
					!!other &&
					row.id === other.id &&
					row.label === other.label &&
					row.createdAt === other.createdAt &&
					row.modifiedAt === other.modifiedAt &&
					row.messageCount === other.messageCount &&
					row.hasParent === other.hasParent &&
					row.liveness === other.liveness &&
					row.readOnly === other.readOnly
				)
			}))
	)
}
