import type { HelmResult, RunContextDraft, RunContextLoad, RunContextReset, RunContextSave } from './shared-helm'

type RequestMethod = 'GET' | 'POST' | 'PUT'

export interface RunContextBridgeDependencies {
	acceptsProfileToken(token: unknown): boolean
	request<T>(method: RequestMethod, path: string, body?: unknown): Promise<HelmResult<T>>
	kick(): void
}

/**
 * Narrow token policy owned by HelmBridge. The window layer only authenticates
 * its sender and Item binding; it never decides whether a profile token is valid.
 */
export class RunContextBridgeOperations {
	constructor(private readonly deps: RunContextBridgeDependencies) {}

	async load(itemId: string, profileToken: unknown): Promise<HelmResult<RunContextLoad>> {
		const before = this.stale<RunContextLoad>(profileToken)
		if (before) return before
		const result = await this.deps.request<RunContextLoad>('GET', `/items/${encodeURIComponent(itemId)}/run-context`)
		return this.stale<RunContextLoad>(profileToken) ?? result
	}

	async save(
		itemId: string,
		revision: number,
		document: RunContextDraft,
		profileToken: unknown,
	): Promise<HelmResult<RunContextSave>> {
		const before = this.stale<RunContextSave>(profileToken)
		if (before) return before
		const result = await this.deps.request<RunContextSave>('PUT', `/items/${encodeURIComponent(itemId)}/run-context`, {
			revision,
			document,
		})
		const after = this.stale<RunContextSave>(profileToken)
		if (after) return after
		if (result.error === undefined) this.deps.kick()
		return result
	}

	async reset(itemId: string, revision: number, profileToken: unknown): Promise<HelmResult<RunContextReset>> {
		const before = this.stale<RunContextReset>(profileToken)
		if (before) return before
		const result = await this.deps.request<RunContextReset>(
			'POST',
			`/items/${encodeURIComponent(itemId)}/run-context/reset`,
			{
				revision,
			},
		)
		const after = this.stale<RunContextReset>(profileToken)
		if (after) return after
		if (result.error === undefined) this.deps.kick()
		return result
	}

	private stale<T>(token: unknown): HelmResult<T> | null {
		return this.deps.acceptsProfileToken(token)
			? null
			: { error: 'Profile changed — retry in the active profile.', status: 409 }
	}
}

export default { RunContextBridgeOperations }
