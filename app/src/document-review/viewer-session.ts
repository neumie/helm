// One review/viewer window's own in-memory Electron session (docs/plans/helm-open/spec.md, Renderer isolation):
// the helm-viewer: handler with that window's file tokens, a network block, and permission handlers that deny
// everything. Electron is injected (main.ts passes `session`), so the window tests' fake Electron needs none of it.
import { randomUUID } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from 'electron'
import { VIEWER_SCHEME, type ViewerFileTokens, handleViewerRequest, viewerRequestAllowed } from './viewer-protocol'

export interface ViewerSessionHandle {
	session: Session
	dispose(): void
}
export type ViewerSessionFactory = (tokens: ViewerFileTokens) => ViewerSessionHandle

const ASSET_BYTES = 32 * 1024 * 1024

/** Reads a bundled file under `dist/viewer` without following links; null when it is missing or odd. */
async function readViewerAsset(root: string, path: string): Promise<Uint8Array | null> {
	const file = join(root, path)
	if (!file.startsWith(`${root}/`)) return null
	const stat = await lstat(file).catch(() => null)
	if (!stat?.isFile() || stat.size > ASSET_BYTES) return null
	const handle = await open(file, 'r').catch(() => null)
	if (!handle) return null
	try {
		return await handle.readFile()
	} finally {
		await handle.close()
	}
}

/** The factory main.ts hands to `DocumentReviewWindows`; `fromPartition` is Electron's `session.fromPartition`. */
export function createViewerSessionFactory(
	fromPartition: (partition: string, options: { cache: boolean }) => Session,
	distDir: string,
): ViewerSessionFactory {
	const root = join(distDir, 'viewer')
	return tokens => {
		// Never `persist:`: the partition lives in memory and dies with the process. Electron cannot destroy a
		// session, so each closed window leaves one empty session behind; dispose clears what it held.
		const ses = fromPartition(`helm-open-${randomUUID()}`, { cache: false })
		ses.protocol.handle(VIEWER_SCHEME, request =>
			handleViewerRequest(request, { tokens, readAsset: path => readViewerAsset(root, path) }),
		)
		ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !viewerRequestAllowed(details.url) }))
		ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
		ses.setPermissionCheckHandler(() => false)
		ses.setDevicePermissionHandler(() => false)
		ses.setDisplayMediaRequestHandler((_request, callback) => callback({}))
		const download = (event: Electron.Event) => event.preventDefault()
		ses.on('will-download', download)
		let disposed = false
		return {
			session: ses,
			dispose() {
				if (disposed) return
				disposed = true
				void tokens.revokeAll()
				try {
					ses.protocol.unhandle(VIEWER_SCHEME)
				} catch {}
				ses.webRequest.onBeforeRequest(null)
				ses.off('will-download', download)
				void ses.clearStorageData().catch(() => {})
			},
		}
	}
}
