import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { defaultReviewRoot } from '../../../src/document-review/client'
import { ReviewControlServer } from '../../../src/document-review/control-server'
import type { CallerBinding, ReviewControlBackend } from '../../../src/document-review/control-server'
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
	const sessions = (binding: CallerBinding) => deps.windows.callerSessions(binding.profileId)
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
		connect: async command => {
			const profileId = deps.profileId()
			const profileToken = deps.profileToken()
			const stillCurrent = () => deps.profileId() === profileId && deps.allowsToken(profileToken)
			if (!stillCurrent()) throw new Error('Profile admission is closed.')
			const requested = resolve(command.workspace)
			const stat = await lstat(requested)
			if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(requested)) !== requested)
				throw new Error('Choose a canonical repository directory.')
			const environment = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
			for (const key of Object.keys(environment))
				if (key.startsWith('GIT_') && key !== 'GIT_OPTIONAL_LOCKS') Reflect.deleteProperty(environment, key)
			const result = await run('git', ['-C', requested, 'rev-parse', '--show-toplevel'], {
				env: environment,
				timeout: 5000,
				maxBuffer: 8192,
			})
			const workspace = await realpath(result.stdout.trim())
			if (!stillCurrent()) throw new Error('Profile changed while connecting.')
			const connection = deps.windows.connectCaller(command.provider, workspace, command.label, command.transport)
			return { id: connection.id, owner: connection.owner, workspace, profileId, profileToken }
		},
		command: async (binding, command, signal) => {
			if (!current(binding) || signal.aborted) throw new Error('Connection is not current.')
			const caller = sessions(binding)
			switch (command.action) {
				case 'open': {
					const file = resolve(command.file)
					// canonicality is rechecked by the document grant, including parents and actual bytes.
					if ((await realpath(dirname(file))) !== dirname(file) || signal.aborted || !current(binding))
						throw new Error('Document admission changed.')
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
					return caller.next(binding.id, binding.owner, command.timeoutMs, signal)
				case 'ack':
					caller.confirm(binding.id, binding.owner, command.requestId)
					return true
				case 'reply':
					caller.report(binding.id, binding.owner, command.requestId, command.sequence, command.state, command.text)
					return true
				case 'receipt':
					return caller.receipt(command.requestId, binding.id)
				case 'disconnect':
					caller.disconnect(binding.id, binding.owner)
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
