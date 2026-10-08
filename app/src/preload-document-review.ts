import { contextBridge, ipcRenderer } from 'electron'
import type { ReviewApi, ReviewResult } from './document-review/types'
const token = ipcRenderer.sendSync('document-review:bootstrap') as string | null
function invoke<T>(channel: string, ...args: unknown[]): Promise<ReviewResult<T>> {
	if (!token) return Promise.resolve({ error: 'This document review is no longer available. Reopen it in Helm.' })
	return ipcRenderer
		.invoke(channel, token, ...args)
		.catch(() => ({ error: 'Helm could not confirm this operation. Do not automatically resend it.' }))
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
	discardArchive: failureId => invoke('document-review:discard-archive', failureId),
	dirty: value => ipcRenderer.send('document-review:dirty', token, value),
	onCloseRequested: listener => subscribe('document-review:close-requested', listener),
	onChanged: listener => subscribe('document-review:changed', listener),
	close: () => ipcRenderer.send('document-review:close', token),
}
contextBridge.exposeInMainWorld('documentReview', api)
