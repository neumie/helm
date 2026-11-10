// The data view's parser worker (docs/plans/helm-open/spec.md: parsers that touch untrusted bytes run in dedicated
// workers). Loaded from helm-viewer://app/assets/data-worker.js, so it takes the viewer CSP from its own response.
import { copyJson, flatten, nodeAt, parseData, search, topLevel } from './data-model'
import type { DataRequest, DataResponse } from './data-protocol'

let root: unknown = null
const scope = self as unknown as {
	onmessage: ((event: MessageEvent<DataRequest>) => void) | null
	postMessage(message: DataResponse): void
}
scope.onmessage = event => {
	const request = event.data
	try {
		if (request.type === 'open') {
			const parsed = parseData(request.text, request.language)
			root = parsed.error ? null : parsed.root
			const top = topLevel(root)
			scope.postMessage({ id: request.id, type: 'opened', error: parsed.error, kind: top.kind, count: top.count })
		} else if (request.type === 'rows') {
			const result = flatten(root, new Set(request.expanded))
			scope.postMessage({ id: request.id, type: 'rows', ...result })
		} else if (request.type === 'search') {
			scope.postMessage({ id: request.id, type: 'search', ...search(root, request.query) })
		} else {
			const node = nodeAt(root, request.pointer)
			scope.postMessage({ id: request.id, type: 'copy', text: node ? copyJson(node.value) : null })
		}
	} catch (error) {
		const message = error instanceof Error ? error.message.split('\n')[0] : 'failed'
		scope.postMessage({ id: request.id, type: 'failed', error: message ?? 'failed' })
	}
}
