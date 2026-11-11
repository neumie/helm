import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { defaultReviewRoot } from '../../../src/document-review/client'
import { ReviewControlServer } from '../../../src/document-review/control-server'
import type { CallerBinding, ReviewControlBackend } from '../../../src/document-review/control-server'
import { gitRootRefusal, refuse, restartingRefusal, retryLaterRefusal } from '../../../src/document-review/refusal'
import { ReviewOwnerStore } from './owner-store'
import { wireReceipt } from './sessions'
import type { DocumentReviewWindows } from './window'

const run = promisify(execFile)
export interface NativeReviewControlDependencies {
	windows: DocumentReviewWindows
	profileId(): string
	profileToken(): string
	allowsToken(token: string): boolean
}
/** Main-process composition. Incoming CLI paths never reach the renderer. */
export function createReviewControl(
	deps: NativeReviewControlDependencies,
	root = defaultReviewRoot(),
): ReviewControlServer {
	// Callers are kept next to their connection files, so a restart brings them back (S13).
	deps.windows.keepCallers(new ReviewOwnerStore(root))
	const sessions = (binding: CallerBinding) => deps.windows.callerSessions(binding.profileId)
	/** A state change is answered only once it is on disk; a failed write is retried by the caller, never lost. */
	const kept = async (binding: CallerBinding) => {
		try {
			await sessions(binding).flush(binding.id)
		} catch {
			throw retryLaterRefusal()
		}
	}
	const current = (binding: CallerBinding) => {
		if (!deps.allowsToken(binding.profileToken) || deps.profileId() !== binding.profileId) return false
		try {
			sessions(binding).get(binding.id, binding.owner)
			return true
		} catch {
			return false
		}
	}
	const backend: ReviewControlBackend = {
		status: () => ({ available: deps.allowsToken(deps.profileToken()) }),
		current,
		restore: record => deps.windows.restoreCaller(record),
		view: (files, signal) => deps.windows.viewFiles(files, signal),
		connect: async command => {
			const profileId = deps.profileId()
			const profileToken = deps.profileToken()
			const stillCurrent = () => deps.profileId() === profileId && deps.allowsToken(profileToken)
			if (!stillCurrent())
				throw refuse('No Helm profile is active for review (Helm is switching profiles or closing). Try again shortly.')
			const requested = resolve(command.workspace)
			const stat = await lstat(requested).catch(() => null)
			if (!stat) throw refuse(`Workspace folder ${basename(requested)} does not exist.`)
			if (!stat.isSymbolicLink() && !stat.isDirectory())
				throw refuse(`Workspace ${basename(requested)} is not a folder.`)
			if (stat.isSymbolicLink() || (await realpath(requested)) !== requested)
				throw refuse(
					'The workspace path goes through a symlink. Pass its real path (for example /private/tmp, not /tmp).',
				)
			const environment = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
			for (const key of Object.keys(environment))
				if (key.startsWith('GIT_') && key !== 'GIT_OPTIONAL_LOCKS') Reflect.deleteProperty(environment, key)
			const result = await run('git', ['-C', requested, 'rev-parse', '--show-toplevel'], {
				env: environment,
				timeout: 5000,
				maxBuffer: 8192,
			}).catch(error => {
				throw gitRootRefusal(error, `Workspace ${basename(requested)}`)
			})
			const workspace = await realpath(result.stdout.trim())
			if (!stillCurrent())
				throw refuse('The active Helm profile changed while connecting. Nothing was opened; connect again.')
			// The session hint (S12) is kept in host memory for display-only progress; only Claude Code and Codex have one.
			const hint =
				command.session &&
				command.features?.includes('session-hint') &&
				(command.provider === 'claude' || command.provider === 'codex')
					? { provider: command.provider, session: command.session }
					: undefined
			const connection = deps.windows.connectCaller(command.provider, workspace, command.label, command.transport, hint)
			return { id: connection.id, owner: connection.owner, workspace, profileId, profileToken }
		},
		command: async (binding, command, signal) => {
			if (!current(binding) || signal.aborted)
				throw refuse('This review connection is no longer current. Nothing was done; open the document again.')
			const caller = sessions(binding)
			// A quit has started: nothing changes any more; the caller asks again once Helm is back.
			if (deps.windows.isSuspended() && !['status', 'list', 'receipt'].includes(command.action))
				throw restartingRefusal()
			caller.touch(binding.id, binding.owner)
			switch (command.action) {
				case 'open': {
					const file = resolve(command.file)
					// canonicality is rechecked by the document grant, including parents and actual bytes.
					const parent = await realpath(dirname(file)).catch(() => null)
					if (parent === null) throw refuse(`The folder of ${basename(file)} does not exist.`)
					if (parent !== dirname(file))
						throw refuse(
							`The path to ${basename(file)} goes through a symlink. Pass its real path (for example /private/tmp, not /tmp).`,
						)
					if (signal.aborted || !current(binding))
						throw refuse('The active Helm profile changed or the connection ended. Nothing was opened.')
					return deps.windows.openForCaller(file, binding.profileToken, binding.profileId, binding.id, binding.owner)
				}
				case 'status': {
					const snapshot = caller.list(binding.workspace).find(value => value.id === binding.id)
					if (!snapshot) throw new Error('Connection unavailable.')
					return {
						...snapshot,
						messages: [],
						historyTruncated: snapshot.historyTruncated || snapshot.messages.length > 0,
					}
				}
				case 'list':
					return caller.list(binding.workspace).map(snapshot => ({
						...snapshot,
						messages: [],
						historyTruncated: snapshot.historyTruncated || snapshot.messages.length > 0,
					}))
				case 'next':
					if (command.documentId)
						return deps.windows.nextForCallerDocument(
							binding.profileId,
							binding.id,
							binding.owner,
							command.documentId,
							command.timeoutMs,
							signal,
							command.listener,
						)
					await deps.windows.reopenCallerDocuments(binding.profileId, binding.id, binding.owner, signal)
					return caller.next(binding.id, binding.owner, command.timeoutMs, signal, undefined, command.listener)
				case 'ack':
					caller.confirm(binding.id, binding.owner, command.requestId)
					await kept(binding)
					return true
				case 'reply':
					caller.report(binding.id, binding.owner, command.requestId, command.sequence, command.state, command.text)
					await kept(binding)
					return true
				case 'receipt':
					return wireReceipt(caller.receipt(command.requestId, binding.id))
				case 'disconnect':
					caller.disconnect(binding.id, binding.owner)
					await kept(binding).catch(() => {})
					return true
			}
		},
		disconnect: binding => {
			try {
				sessions(binding).disconnect(binding.id, binding.owner)
			} catch {
				/* already fenced */
			}
		},
	}
	return new ReviewControlServer(root, backend)
}
