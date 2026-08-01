import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { RunContextEditorApi } from './shared'
import type { HelmResult, RunContextDraft, RunContextLoad, RunContextReset, RunContextSave } from './shared-helm'
import { type ShortcutChord, isShortcutCode } from './shortcuts'

// This dedicated preload reads only its captured profile token and Save aliases;
// the bootstrap channel cannot expose any other app configuration.
const bootstrap: unknown = ipcRenderer.sendSync('run-context:bootstrap')
if (
	!bootstrap ||
	typeof bootstrap !== 'object' ||
	typeof (bootstrap as { profileToken?: unknown }).profileToken !== 'string' ||
	(bootstrap as { profileToken: string }).profileToken.length === 0 ||
	!Array.isArray((bootstrap as { saveBindings?: unknown }).saveBindings) ||
	!(bootstrap as { saveBindings: unknown[] }).saveBindings.every(
		binding =>
			binding !== null &&
			typeof binding === 'object' &&
			isShortcutCode((binding as { code?: unknown }).code) &&
			((binding as { shift?: unknown }).shift === undefined ||
				typeof (binding as { shift?: unknown }).shift === 'boolean') &&
			((binding as { alt?: unknown }).alt === undefined || typeof (binding as { alt?: unknown }).alt === 'boolean'),
	)
)
	throw new Error('Run Context editor bootstrap is unavailable')
const captured = bootstrap as { profileToken: string; saveBindings: ShortcutChord[] }
const sessionProfileToken = captured.profileToken
let initialSaveBindings = captured.saveBindings.map(binding => ({ ...binding }))

const api: RunContextEditorApi = {
	platform: process.platform,
	saveBindings: initialSaveBindings.map(binding => ({ ...binding })),
	onSaveBindingsChanged: listener => {
		const handler = (_event: IpcRendererEvent, bindings: ShortcutChord[], profileToken: string) => {
			if (profileToken === sessionProfileToken) {
				initialSaveBindings = bindings.map(binding => ({ ...binding }))
				listener(initialSaveBindings.map(binding => ({ ...binding })))
			}
		}
		ipcRenderer.on('run-context:save-bindings', handler)
		return () => ipcRenderer.removeListener('run-context:save-bindings', handler)
	},
	load: () => ipcRenderer.invoke('run-context:load', sessionProfileToken) as Promise<HelmResult<RunContextLoad>>,
	save: (revision: number, document: RunContextDraft) =>
		ipcRenderer.invoke('run-context:save', revision, document, sessionProfileToken) as Promise<
			HelmResult<RunContextSave>
		>,
	reset: (revision: number) =>
		ipcRenderer.invoke('run-context:reset', revision, sessionProfileToken) as Promise<HelmResult<RunContextReset>>,
	setDirty: (dirty: boolean) => ipcRenderer.send('run-context:dirty', dirty),
	close: (discard: boolean) => ipcRenderer.send('run-context:close', discard),
	cancelClose: () => ipcRenderer.send('run-context:cancel-close'),
	onCloseRequested: listener => {
		const handler = (_event: IpcRendererEvent) => listener()
		ipcRenderer.on('run-context:close-requested', handler)
		return () => ipcRenderer.removeListener('run-context:close-requested', handler)
	},
}

contextBridge.exposeInMainWorld('runContextEditor', api)
