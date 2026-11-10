import { contextBridge, ipcRenderer } from 'electron'
import type { ReviewApi, ReviewResult } from './document-review/types'
const token = ipcRenderer.sendSync('document-review:bootstrap') as string | null
function invoke<T>(channel: string, ...args: unknown[]): Promise<ReviewResult<T>> {
	if (!token) return Promise.resolve({ error: 'This document review is no longer available. Reopen it in Helm.' })
	return (
		ipcRenderer
			.invoke(channel, token, ...args)
			// A lost IPC reply may follow an effect: mark it uncertain so the window never treats it as a refusal.
			.catch(() => ({
				error: 'Helm could not confirm this operation. Do not automatically resend it.',
				uncertain: true as const,
			}))
	)
}
function subscribe(channel: string, listener: () => void): () => void {
	const handler = () => listener()
	ipcRenderer.on(channel, handler)
	return () => ipcRenderer.removeListener(channel, handler)
}
const api: ReviewApi = {
	load: () => invoke('document-review:load'),
	send: request => invoke('document-review:send', request),
	interrupt: (id, owner) => invoke('document-review:interrupt', id, owner),
	acknowledge: (id, owner) => invoke('document-review:acknowledge', id, owner),
	selectSession: id => invoke('document-review:select', id),
	save: draft => invoke('document-review:save', draft),
	receipt: id => invoke('document-review:receipt', id),
	retryDocument: () => invoke('document-review:retry'),
	copyImage: png => invoke('document-review:copy-image', png),
	clearEmptyPreferences: () => invoke('document-review:clear-empty-preferences'),
	discardArchive: failureId => invoke('document-review:discard-archive', failureId),
	dirty: value => ipcRenderer.send('document-review:dirty', token, value),
	onCloseRequested: listener => subscribe('document-review:close-requested', listener),
	onChanged: listener => subscribe('document-review:changed', listener),
	onZoom: listener => {
		const handler = (_event: unknown, step: unknown) => {
			if (step === -1 || step === 0 || step === 1) listener(step)
		}
		ipcRenderer.on('document-review:zoom', handler)
		return () => ipcRenderer.removeListener('document-review:zoom', handler)
	},
	close: () => ipcRenderer.send('document-review:close', token),
}
contextBridge.exposeInMainWorld('documentReview', api)
