// HelmBridge — the ONE place the app talks HTTP to the helm daemon.
//
// The renderer is a file:// document, so it cannot fetch :7474 directly (CORS,
// private-network access). Instead the main process runs a single poller and
// proxies commands:
//
//   - Poll loop (2.5s): GET /api/status + GET /api/items (+ GET /api/config
//     once, refreshed after a config save). The merged HelmSnapshot is pushed
//     to every window over 'daemon:snapshot' — full snapshot, only when the
//     JSON actually changed (no delta protocol).
//   - Commands: invoke channels that proxy one HTTP call each and return the
//     daemon's `{ data } | { error }` envelope verbatim.
//
// The bridge holds no business logic: status/action rules stay server-owned.
// It does apply narrow wire-compatibility normalization for mixed-version
// app/daemon rollouts before values reach the renderer.

import type * as Electron from 'electron'

// Tests exercise the polling core under Node; Electron is needed only when the
// desktop IPC surface/publisher is actually used.
const electron = (() => {
	try {
		return require('electron') as typeof Electron
	} catch {
		return null
	}
})()
const BrowserWindow = (electron?.BrowserWindow ?? { getAllWindows: () => [] }) as typeof Electron.BrowserWindow
const ipcMain = electron?.ipcMain as typeof Electron.ipcMain
import {
	normalizeDashboardItemResult,
	normalizeDashboardItems,
	normalizeProfileActivationResult,
	normalizeProfileMutationResult,
	normalizeProfilesDocumentResult,
} from './normalize-helm'
import type { ProfileSwitchFence } from './profile-switch'
import { EXPECTED_DAEMON_BUILD_ID, EXPECTED_DAEMON_PROTOCOL_VERSION } from './protocol-version'
import { RunContextBridgeOperations } from './run-context-bridge'
import type {
	AiPass,
	AppConfig,
	DaemonRestartResult,
	DaemonStatus,
	DashboardActionId,
	DashboardItem,
	HelmResult,
	HelmSnapshot,
	ItemStatus,
	ProfileActivationResult,
	ProfileKnowledgeBinding,
	ProfileMutationResult,
	ProfilesDocument,
	ProfilesState,
	RunContextDraft,
	RunContextLoad,
	RunContextReset,
	RunContextSave,
	ScheduledRun,
	ScheduledSchedule,
	ScheduledScheduleEditor,
} from './shared-helm'

const POLL_MS = 2500
const REQUEST_TIMEOUT_MS = 10_000
// Model-backed helper passes can legitimately consume their full 30s helper
// budget; workspace commands also include provider IO + git/Okena setup. They
// must outlive the short budget used by polling and ordinary lifecycle writes,
// or the app reports failure while the daemon continues and succeeds.
const HELPER_REQUEST_TIMEOUT_MS = 60_000
const WORKSPACE_REQUEST_TIMEOUT_MS = 120_000

const ITEM_ACTIONS: ReadonlySet<string> = new Set(['approve', 'reject', 'start', 'cancel', 'retry', 'reopen'])
const AI_PASSES: ReadonlySet<string> = new Set(['display-name', 'branch-name', 'assess'])

interface ProfileFenceRecord {
	epoch: number
	targetId: string
	resolveReady(): void
	ready: Promise<void>
	readyResolved: boolean
	invalidated: boolean
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export type HelmBridgeRequest = <T>(
	method: 'GET' | 'POST' | 'PUT',
	path: string,
	body?: unknown,
	timeoutMs?: number,
	headers?: Record<string, string>,
) => Promise<HelmResult<T>>

/** Main-process-only resident lease transport; it is intentionally not registered as IPC. */
export type ResidentLeaseOperation = 'issue' | 'heartbeat' | 'tick' | 'revoke'

export function profileIdFromProfileToken(token: unknown): string | null {
	if (typeof token !== 'string') return null
	const separator = token.lastIndexOf(':')
	if (separator <= 0 || !/^\d+$/.test(token.slice(separator + 1))) return null
	return token.slice(0, separator)
}

/** Bind renderer-supplied schedule tenancy to the preload-captured profile token. */
export function scheduledProfileTokenMatches(profileId: unknown, token: unknown): profileId is string {
	return (
		typeof profileId === 'string' && profileId !== '' && typeof token === 'string' && token.startsWith(`${profileId}:`)
	)
}

export interface HelmBridgeOptions {
	/** Test seam; production uses the daemon HTTP client below. */
	request?: HelmBridgeRequest
	/** Test seam; production broadcasts to every Electron window. */
	windows?: () => Iterable<{
		webContents: { isDestroyed(): boolean; send(channel: string, snapshot: HelmSnapshot): void }
	}>
	setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
	/** Main-only local-control capability provider for privileged renderer requests. */
	localControlToken?: () => Promise<string>
	/** Compatibility alias for older constructors. */
	scheduledControlToken?: () => Promise<string>
}

export class HelmBridge {
	private readonly baseUrl: string
	private snapshot: HelmSnapshot = { reachable: false, status: null, items: null, config: null }
	/** Serialized snapshot with volatile fields dropped; push only when this changes. */
	private lastComparable = ''
	private timer: NodeJS.Timeout | null = null
	private ticking = false
	private daemonRestartAttempt: string | null = null
	/** Epoch-owned: stale polls/cancels may never resolve a newer profile fence. */
	private profileFence: ProfileFenceRecord | null = null
	private profileSwitchTimer: ReturnType<typeof setTimeout> | null = null
	private nextProfileFenceEpoch = 0
	private stopped = false
	private readonly runContext: RunContextBridgeOperations
	private readonly options: HelmBridgeOptions

	constructor(
		daemonUrl: string,
		private readonly acceptsProfileToken: (token: unknown) => boolean = () => true,
		options: HelmBridgeOptions = {},
	) {
		this.options = options
		this.baseUrl = daemonUrl.replace(/\/$/, '')
		this.runContext = new RunContextBridgeOperations({
			acceptsProfileToken: token => this.acceptsProfileToken(token),
			request: (method, path, body) => this.request(method, path, body),
			kick: () => this.kick(),
		})
	}

	start(): void {
		if (this.timer) return
		this.stopped = false
		void this.tick()
		this.timer = setInterval(() => void this.tick(), POLL_MS)
	}

	stop(): void {
		this.stopped = true
		if (this.timer) clearInterval(this.timer)
		if (this.profileSwitchTimer) this.clearProfileTimer(this.profileSwitchTimer)
		this.timer = null
		this.profileSwitchTimer = null
		this.profileFence = null
	}

	getSnapshot(): HelmSnapshot {
		return this.snapshot
	}

	// --- polling ---------------------------------------------------------------

	private isCurrentFence(fence: ProfileFenceRecord | null): boolean {
		return !this.stopped && fence === this.profileFence && !fence?.invalidated
	}

	private setProfileTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
		return (this.options.setTimer ?? setTimeout)(callback, ms)
	}

	private clearProfileTimer(timer: ReturnType<typeof setTimeout>): void {
		;(this.options.clearTimer ?? clearTimeout)(timer)
	}

	private async tick(): Promise<void> {
		if (this.stopped || this.ticking) return // a slow daemon must not stack overlapping polls
		this.ticking = true
		const fence = this.profileFence
		try {
			const [status, items] = await Promise.all([
				this.request<DaemonStatus>('GET', '/status'),
				this.request<DashboardItem[]>('GET', '/items'),
			])
			const statusProfileId = status.data?.profile?.id
			const sameProfileSnapshot =
				statusProfileId !== undefined &&
				items.error === undefined &&
				items.data !== undefined &&
				items.data.every(item => item.profileId === statusProfileId)
			const reachable = status.error === undefined && sameProfileSnapshot
			// A poll begun before a new fence is installed is stale. It may not
			// publish old rows or kick work for the new epoch.
			if (!this.isCurrentFence(fence)) return
			if (status.error === undefined && !sameProfileSnapshot && fence) this.kick(fence)

			// A fence owns every completion it started. A replaced epoch must not
			// blank, publish, resolve, or schedule work for its successor.
			if (fence && this.profileFence === fence) {
				const profiles = reachable ? await this.listProfiles() : { error: 'incoherent' }
				if (!this.isCurrentFence(fence)) return
				const coherentState =
					profiles.data &&
					profiles.data.activeProfileId === statusProfileId &&
					(status.data?.profileGeneration === undefined || status.data.profileGeneration === profiles.data.generation)
						? profiles.data
						: null
				if (!coherentState || coherentState.activeProfileId !== fence.targetId) {
					this.snapshot = { ...this.snapshot, reachable: false, status: null, items: null }
					this.publish()
					return
				}
				if (this.profileSwitchTimer) this.clearProfileTimer(this.profileSwitchTimer)
				this.profileSwitchTimer = null
			}
			if (status.data && (await this.restartForProtocolMismatch(status.data))) return
			if (!this.isCurrentFence(fence)) return
			let config = this.snapshot.config
			if (reachable && config === null) {
				config = (await this.request<AppConfig>('GET', '/config')).data ?? null
				if (!this.isCurrentFence(fence)) return
			}
			// No await is permitted between this epoch check, publication, and
			// readiness. Coordinators may complete the fence as soon as `ready`
			// resolves, so the target renderer must already own this snapshot.
			if (!this.isCurrentFence(fence)) return
			this.snapshot = {
				reachable,
				status: status.data ?? this.snapshot.status,
				items: items.data ? normalizeDashboardItems(items.data) : this.snapshot.items,
				config,
			}
			if (!this.isCurrentFence(fence)) return
			this.publish()
			if (!this.isCurrentFence(fence)) return
			if (fence && !fence.readyResolved) {
				fence.readyResolved = true
				fence.resolveReady()
			}
		} finally {
			this.ticking = false
			// Only the captured fence can schedule its own recovery. A stale tick
			// must never borrow a successor's epoch or timer slot.
			if (
				!this.stopped &&
				fence !== null &&
				this.profileFence === fence &&
				!fence.invalidated &&
				!fence.readyResolved &&
				this.profileSwitchTimer === null
			) {
				const epoch = fence.epoch
				this.profileSwitchTimer = this.setProfileTimer(() => {
					if (this.profileFence === fence && fence.epoch === epoch) {
						this.profileSwitchTimer = null
						this.kick(fence)
					}
				}, 150)
				this.profileSwitchTimer.unref?.()
			}
		}
	}

	/**
	 * A newly built app can launch while launchd still owns an older daemon
	 * process. Restart once the queue is idle; the guarded endpoint refuses dev
	 * processes and active runs, so this never drops run tracking.
	 */
	private async restartForProtocolMismatch(status: DaemonStatus): Promise<boolean> {
		const actualProtocol = (status as Partial<DaemonStatus>).protocolVersion
		const actualBuild = (status as Partial<DaemonStatus>).buildId
		if (actualProtocol === EXPECTED_DAEMON_PROTOCOL_VERSION && actualBuild === EXPECTED_DAEMON_BUILD_ID) {
			this.daemonRestartAttempt = null
			return false
		}
		if (status.queue.active > 0) return false
		const key = `${actualProtocol ?? 'missing'}/${actualBuild ?? 'missing'}`
		if (this.daemonRestartAttempt === key) return false
		this.daemonRestartAttempt = key
		const result = await this.request<DaemonRestartResult>('POST', '/daemon/restart')
		if (result.data?.applied) {
			process.stderr.write(
				`[helm] Restarting daemon ${key} → ${EXPECTED_DAEMON_PROTOCOL_VERSION}/${EXPECTED_DAEMON_BUILD_ID}\n`,
			)
			return true
		}
		process.stderr.write(
			`[helm] Daemon ${key} does not match app ${EXPECTED_DAEMON_PROTOCOL_VERSION}/${EXPECTED_DAEMON_BUILD_ID}: ${result.error ?? result.data?.message ?? 'restart unavailable'}\n`,
		)
		return false
	}

	/** Immediate re-poll after a mutating command so the UI catches up before the next interval. */
	private kick(fence?: ProfileFenceRecord): void {
		if (this.stopped || (fence !== undefined && this.profileFence !== fence)) return
		void this.tick()
	}

	private async refreshConfig(): Promise<void> {
		const config = await this.request<AppConfig>('GET', '/config')
		if (config.data !== undefined) {
			this.snapshot = { ...this.snapshot, config: config.data }
			this.publish()
		}
	}

	private publish(): void {
		// `status.uptime` advances every poll; diffing on it would push every tick.
		const { status, ...rest } = this.snapshot
		const comparable = JSON.stringify({ ...rest, status: status ? { ...status, uptime: 0 } : null })
		if (comparable === this.lastComparable) return
		this.lastComparable = comparable
		for (const win of (this.options.windows ?? (() => BrowserWindow.getAllWindows()))()) {
			if (!win.webContents.isDestroyed()) win.webContents.send('daemon:snapshot', this.snapshot)
		}
	}

	// --- HTTP proxy ------------------------------------------------------------

	private async request<T>(
		method: 'GET' | 'POST' | 'PUT',
		path: string,
		body?: unknown,
		timeoutMs = REQUEST_TIMEOUT_MS,
		headers?: Record<string, string>,
	): Promise<HelmResult<T>> {
		if (this.options.request) return this.options.request<T>(method, path, body, timeoutMs, headers)
		try {
			const res = await fetch(`${this.baseUrl}/api${path}`, {
				method,
				headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			})
			const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string }
			// Daemon envelope passed through verbatim; a non-ok status without an
			// `error` body still needs a message for the UI.
			if (!res.ok) return { error: json.error ?? `API error: ${res.status}`, status: res.status }
			return { data: json.data as T }
		} catch (err) {
			return { error: errorMessage(err) }
		}
	}

	private async controlRequest<T>(
		method: 'GET' | 'POST' | 'PUT',
		path: string,
		body?: unknown,
	): Promise<HelmResult<T>> {
		const tokenProvider = this.options.localControlToken ?? this.options.scheduledControlToken
		if (!tokenProvider) return { error: 'Local control is unavailable.', status: 503 }
		try {
			const controlToken = await tokenProvider()
			return this.request<T>(method, path, body, REQUEST_TIMEOUT_MS, {
				Authorization: `Bearer ${controlToken}`,
			})
		} catch {
			return { error: 'Local control is unavailable.', status: 503 }
		}
	}

	/**
	 * Narrow main-only transport for the Electron resident-admission controller.
	 * It deliberately has no IPC registration: local-control auth and resident
	 * capabilities must never reach a renderer, log, or daemon snapshot.
	 */
	async scheduledResidentLease<T>(
		operation: ResidentLeaseOperation,
		capability: string,
		timeoutMs: number,
	): Promise<HelmResult<T>> {
		const paths: Record<ResidentLeaseOperation, string> = {
			issue: '/scheduled-runs/lease',
			heartbeat: '/scheduled-runs/lease/heartbeat',
			tick: '/scheduled-runs/lease/tick',
			revoke: '/scheduled-runs/lease/revoke',
		}
		return operation === 'issue'
			? this.request<T>('POST', paths.issue, undefined, timeoutMs, { Authorization: `Bearer ${capability}` })
			: this.request<T>('POST', paths[operation], { capability }, timeoutMs)
	}

	/**
	 * Privileged scheduled-attention transport for Electron main only. The
	 * caller owns the local-control token; this method is deliberately not IPC
	 * registered, so descriptors/capabilities can never reach a renderer.
	 */
	async scheduledAttention<T>(path: string, body: unknown, controlToken: string): Promise<HelmResult<T>> {
		return this.request<T>('POST', path, body, WORKSPACE_REQUEST_TIMEOUT_MS, {
			Authorization: `Bearer ${controlToken}`,
		})
	}

	/** Control-authenticated scheduled attention reads stay in Electron main. */
	async scheduledAttentionRead<T>(path: string, controlToken: string): Promise<HelmResult<T>> {
		return this.request<T>('GET', path, undefined, REQUEST_TIMEOUT_MS, { Authorization: `Bearer ${controlToken}` })
	}

	/** Run Context token policy lives in the bridge-owned operations helper. */
	async loadRunContext(itemId: string, profileToken: unknown): Promise<HelmResult<RunContextLoad>> {
		return this.runContext.load(itemId, profileToken)
	}

	async saveRunContext(
		itemId: string,
		revision: number,
		document: RunContextDraft,
		profileToken: unknown,
	): Promise<HelmResult<RunContextSave>> {
		return this.runContext.save(itemId, revision, document, profileToken)
	}

	async resetRunContext(itemId: string, revision: number, profileToken: unknown): Promise<HelmResult<RunContextReset>> {
		return this.runContext.reset(itemId, revision, profileToken)
	}

	/**
	 * Start an epoch-owned renderer fence. The returned capability is deliberately
	 * narrow: only its owning coordinator may cancel precommit polling or adopt a
	 * coherently observed third profile.
	 */
	beginProfileSwitch(profileId: string): ProfileSwitchFence {
		this.profileFence?.resolveReady()
		if (this.profileSwitchTimer) this.clearProfileTimer(this.profileSwitchTimer)
		this.profileSwitchTimer = null
		const makeReady = (): Pick<ProfileFenceRecord, 'ready' | 'resolveReady' | 'readyResolved'> => {
			let resolveReady!: () => void
			const ready = new Promise<void>(resolve => {
				resolveReady = resolve
			})
			return { ready, resolveReady: () => resolveReady(), readyResolved: false }
		}
		const record: ProfileFenceRecord = {
			epoch: ++this.nextProfileFenceEpoch,
			targetId: profileId,
			...makeReady(),
			invalidated: false,
		}
		this.profileFence = record
		this.snapshot = { ...this.snapshot, reachable: false, status: null, items: null }
		this.publish()
		this.kick(record)
		return {
			epoch: record.epoch,
			get ready() {
				return record.ready
			},
			cancelIfCurrent: () => {
				if (this.profileFence !== record) return
				this.profileFence = null
				if (this.profileSwitchTimer) this.clearProfileTimer(this.profileSwitchTimer)
				this.profileSwitchTimer = null
				this.kick()
			},
			adoptObservedProfile: observedId => {
				if (this.profileFence !== record || record.invalidated || record.targetId === observedId) return
				// B's coherent snapshot cannot satisfy C. Replace the promise before
				// coordinating C's reload so its renderer waits for C's own snapshot.
				record.targetId = observedId
				Object.assign(record, makeReady())
				this.kick(record)
			},
			invalidateIfCurrent: () => {
				if (this.profileFence !== record) return
				if (this.profileSwitchTimer) this.clearProfileTimer(this.profileSwitchTimer)
				this.profileSwitchTimer = null
				// Keep an inert fence until a successor owns it. Clearing it would
				// restore ordinary polling and could republish B during C's drain.
				record.invalidated = true
			},
			completeIfCurrent: () => {
				if (this.profileFence !== record) return
				this.profileFence = null
				this.kick()
			},
			observeCoherently: () => this.observeCoherently(record),
		}
	}

	/** A non-publishing status+items+profiles observation for activation recovery. */
	private async observeCoherently(record: ProfileFenceRecord): Promise<ProfilesState | null> {
		const [status, items] = await Promise.all([
			this.request<DaemonStatus>('GET', '/status'),
			this.request<DashboardItem[]>('GET', '/items'),
		])
		if (!this.isCurrentFence(record)) return null
		const statusProfileId = status.data?.profile?.id
		if (
			status.error !== undefined ||
			!statusProfileId ||
			items.error !== undefined ||
			items.data === undefined ||
			!items.data.every(item => item.profileId === statusProfileId)
		) {
			return null
		}
		const profiles = await this.listProfiles()
		if (!this.isCurrentFence(record) || profiles.error !== undefined || profiles.data === undefined) return null
		if (profiles.data.activeProfileId !== statusProfileId) return null
		if (status.data.profileGeneration !== undefined && status.data.profileGeneration !== profiles.data.generation)
			return null
		return profiles.data
	}

	async listProfiles(): Promise<HelmResult<ProfilesDocument>> {
		return normalizeProfilesDocumentResult(await this.controlRequest<ProfilesDocument>('GET', '/profiles'))
	}

	async activateProfile(profileId: string): Promise<HelmResult<ProfileActivationResult>> {
		return normalizeProfileActivationResult(
			await this.controlRequest<ProfileActivationResult>('POST', `/profiles/${encodeURIComponent(profileId)}/activate`),
		)
	}

	async createProfile(name: string, enabledProjects: string[]): Promise<HelmResult<ProfileMutationResult>> {
		return normalizeProfileMutationResult(
			await this.controlRequest<ProfileMutationResult>('POST', '/profiles', { name, enabledProjects }),
		)
	}

	updateProfile(
		profileId: string,
		body: { name?: string; enabledProjects?: string[]; knowledgeBindings?: ProfileKnowledgeBinding[] },
	): Promise<HelmResult<ProfileMutationResult>> {
		const protocolVersion = this.snapshot.status?.protocolVersion
		const compatibleBody =
			protocolVersion !== undefined && protocolVersion !== EXPECTED_DAEMON_PROTOCOL_VERSION
				? { name: body.name, enabledProjects: body.enabledProjects }
				: body
		return this.controlRequest<ProfileMutationResult>(
			'PUT',
			`/profiles/${encodeURIComponent(profileId)}`,
			compatibleBody,
		).then(normalizeProfileMutationResult)
	}

	archiveProfile(profileId: string): Promise<HelmResult<ProfileMutationResult>> {
		return this.controlRequest<ProfileMutationResult>(
			'POST',
			`/profiles/${encodeURIComponent(profileId)}/archive`,
		).then(normalizeProfileMutationResult)
	}

	restoreProfile(profileId: string): Promise<HelmResult<ProfileMutationResult>> {
		return this.controlRequest<ProfileMutationResult>(
			'POST',
			`/profiles/${encodeURIComponent(profileId)}/restore`,
		).then(normalizeProfileMutationResult)
	}

	// --- IPC surface -------------------------------------------------------------

	registerIpc(): void {
		// Channel args cross the context bridge from renderer code — validate the
		// path-building ones and reject every stale profile renderer after activation.
		const id = (raw: unknown): string => encodeURIComponent(String(raw))
		const stale = (token: unknown): HelmResult<never> | null =>
			this.acceptsProfileToken(token) ? null : { error: 'Profile changed — retry in the active profile.', status: 409 }

		ipcMain.handle('daemon:subscribe', () => this.snapshot)

		ipcMain.handle('daemon:item', async (_e, rawId: unknown, token: unknown) => {
			if (stale(token)) return stale(token)
			if (this.profileFence !== null) return { error: 'Profile is switching — try again shortly.' }
			const privileged = await controlRead<DashboardItem>(`/items/${id(rawId)}`, token)
			const loaded =
				'error' in privileged && privileged.status === 503
					? await this.request<DashboardItem>('GET', `/items/${id(rawId)}`)
					: privileged
			const result = normalizeDashboardItemResult(loaded)
			if (stale(token)) return stale(token)
			if (this.profileFence !== null) return { error: 'Profile is switching — try again shortly.', status: 409 }
			return result
		})

		ipcMain.handle(
			'daemon:itemAction',
			async (_e, rawId: unknown, action: DashboardActionId, body: unknown, token: unknown) => {
				if (stale(token)) return stale(token)
				if (!ITEM_ACTIONS.has(action)) return { error: `Unknown item action: ${String(action)}` }
				const result = normalizeDashboardItemResult(
					await this.request<DashboardItem>('POST', `/items/${id(rawId)}/${action}`, body ?? {}),
				)
				this.kick()
				return result
			},
		)

		ipcMain.handle('daemon:plan', async (_e, rawId: unknown, body: unknown, token: unknown) => {
			if (stale(token)) return stale(token)
			const result = await this.request('POST', `/items/${id(rawId)}/plan`, body ?? {}, WORKSPACE_REQUEST_TIMEOUT_MS)
			this.kick()
			return result
		})

		ipcMain.handle('daemon:openOkena', async (_e, rawId: unknown, token: unknown) => {
			if (stale(token)) return stale(token)
			const result = await this.request(
				'POST',
				`/items/${id(rawId)}/open-okena`,
				undefined,
				WORKSPACE_REQUEST_TIMEOUT_MS,
			)
			this.kick()
			return result
		})

		ipcMain.handle(
			'daemon:retryKnowledgeDelivery',
			async (_e, rawItemId: unknown, rawDeliveryId: unknown, token: unknown) => {
				if (stale(token)) return stale(token)
				const result = await controlWrite<{ retried: true }>(
					'POST',
					`/items/${id(rawItemId)}/knowledge-deliveries/${id(rawDeliveryId)}/retry`,
					{},
					REQUEST_TIMEOUT_MS,
					token,
				)
				this.kick()
				return result
			},
		)

		ipcMain.handle('daemon:recoverKnowledgeDelivery', async (_e, rawItemId: unknown, token: unknown) => {
			if (stale(token)) return stale(token)
			const result = await controlWrite<{ recovered: true; deliveryId: string }>(
				'POST',
				`/items/${id(rawItemId)}/knowledge-deliveries/recover`,
				{},
				REQUEST_TIMEOUT_MS,
				token,
			)
			this.kick()
			return result
		})

		ipcMain.handle('daemon:aiPass', async (_e, rawId: unknown, pass: AiPass, token: unknown) => {
			if (stale(token)) return stale(token)
			if (!AI_PASSES.has(pass)) return { error: `Unknown AI pass: ${String(pass)}` }
			const result = normalizeDashboardItemResult(
				await this.request<DashboardItem>(
					'POST',
					`/items/${id(rawId)}/ai/${pass}`,
					undefined,
					HELPER_REQUEST_TIMEOUT_MS,
				),
			)
			this.kick()
			return result
		})

		ipcMain.handle('daemon:createItem', async (_e, body: unknown, token: unknown) => {
			if (stale(token)) return stale(token)
			const result = await this.request('POST', '/items', body)
			this.kick()
			return result
		})

		ipcMain.handle('daemon:assignItem', async (_e, rawId: unknown, body: unknown, token: unknown) => {
			if (stale(token)) return stale(token)
			const result = normalizeDashboardItemResult(
				await this.request<DashboardItem>('POST', `/items/${id(rawId)}/assign`, body),
			)
			this.kick()
			return result
		})

		ipcMain.handle('daemon:sourceTask', async (_e, rawId: unknown, token: unknown) => {
			if (stale(token)) return stale(token)
			const result = normalizeDashboardItemResult(
				await this.request<DashboardItem>('POST', `/items/${id(rawId)}/source-task`),
			)
			this.kick()
			return result
		})

		ipcMain.handle('daemon:setStatus', async (_e, rawId: unknown, status: ItemStatus, token: unknown) => {
			if (stale(token)) return stale(token)
			const result = normalizeDashboardItemResult(
				await this.request<DashboardItem>('POST', `/items/${id(rawId)}/status`, { status }),
			)
			this.kick()
			return result
		})

		ipcMain.handle('daemon:config', (_e, token: unknown) => {
			if (stale(token)) return stale(token)
			return this.request('GET', '/config/full')
		})

		ipcMain.handle('daemon:updateConfig', async (_e, body: unknown, token: unknown) => {
			if (stale(token)) return stale(token)
			const result = await this.request('PUT', '/config', body)
			if (result.error === undefined) void this.refreshConfig()
			return result
		})

		// Deferred config apply: on success the daemon exits ~300ms after
		// answering and launchd respawns it, so no kick — the poll loop rides
		// out the blip (last-known snapshot data is kept through an outage).
		ipcMain.handle('daemon:restart', (_e, token: unknown) => {
			if (stale(token)) return stale(token)
			return this.request('POST', '/daemon/restart')
		})

		ipcMain.handle('daemon:pauseToggle', async (_e, token: unknown) => {
			if (stale(token)) return stale(token)
			const paused = this.snapshot.status?.queue.paused ?? false
			const result = await this.request('POST', paused ? '/queue/resume' : '/queue/pause')
			this.kick()
			return result
		})

		ipcMain.handle('daemon:poll', async (_e, token: unknown) => {
			if (stale(token)) return stale(token)
			const result = await this.request('POST', '/poll/trigger')
			this.kick()
			return result
		})

		// Schedule definitions/history are profile-owned. Keep profileId in the
		// renderer request explicit, then fence both before and after any await.
		const scheduledProfile = (profileId: unknown, token: unknown): HelmResult<never> | null => {
			if (stale(token)) return stale(token)
			if (typeof profileId !== 'string' || profileId === '')
				return { error: 'A scheduled profile is required.', status: 400 }
			if (!scheduledProfileTokenMatches(profileId, token))
				return { error: 'Scheduled profile changed. Reload and try again.', status: 409 }
			return null
		}
		const controlTokenProvider = this.options.localControlToken ?? this.options.scheduledControlToken
		const controlRead = async <T>(path: string, profileToken?: unknown): Promise<HelmResult<T>> => {
			if (!controlTokenProvider) return { error: 'Local control is unavailable.', status: 503 }
			const denied = profileToken === undefined ? null : stale(profileToken)
			if (denied) return denied
			try {
				const controlToken = await controlTokenProvider()
				const staleAfterAuth = profileToken === undefined ? null : stale(profileToken)
				if (staleAfterAuth) return staleAfterAuth
				const profileId = profileIdFromProfileToken(profileToken)
				const result = await this.request<T>('GET', path, undefined, REQUEST_TIMEOUT_MS, {
					Authorization: `Bearer ${controlToken}`,
					...(profileId ? { 'X-Helm-Profile-Id': profileId } : {}),
				})
				return (profileToken === undefined ? null : stale(profileToken)) ?? result
			} catch {
				return { error: 'Local control is unavailable.', status: 503 }
			}
		}
		const controlWrite = async <T>(
			method: 'POST' | 'PUT',
			path: string,
			body: unknown,
			timeoutMs = REQUEST_TIMEOUT_MS,
			profileToken?: unknown,
		): Promise<HelmResult<T>> => {
			if (!controlTokenProvider) return { error: 'Local control is unavailable.', status: 503 }
			const denied = profileToken === undefined ? null : stale(profileToken)
			if (denied) return denied
			try {
				const controlToken = await controlTokenProvider()
				const staleAfterAuth = profileToken === undefined ? null : stale(profileToken)
				if (staleAfterAuth) return staleAfterAuth
				const profileId = profileIdFromProfileToken(profileToken)
				const result = await this.request<T>(method, path, body, timeoutMs, {
					Authorization: `Bearer ${controlToken}`,
					...(profileId ? { 'X-Helm-Profile-Id': profileId } : {}),
				})
				return (profileToken === undefined ? null : stale(profileToken)) ?? result
			} catch {
				return { error: 'Local control is unavailable.', status: 503 }
			}
		}
		ipcMain.handle('daemon:scheduled:list', async (_e, profileId: unknown, token: unknown) => {
			const denied = scheduledProfile(profileId, token)
			if (denied) return denied
			return controlRead<ScheduledSchedule[]>(`/scheduled-runs?profileId=${id(profileId)}`, token)
		})
		ipcMain.handle('daemon:scheduled:load', async (_e, profileId: unknown, rawId: unknown, token: unknown) => {
			const denied = scheduledProfile(profileId, token)
			if (denied) return denied
			return controlRead<ScheduledScheduleEditor>(
				`/scheduled-runs/${id(rawId)}/editor?profileId=${id(profileId)}`,
				token,
			)
		})
		ipcMain.handle('daemon:scheduled:active', async (_e, profileId: unknown, token: unknown) => {
			const denied = scheduledProfile(profileId, token)
			if (denied) return denied
			return controlRead<ScheduledRun[]>(`/scheduled-runs/active?profileId=${id(profileId)}`, token)
		})
		ipcMain.handle('daemon:scheduled:create', async (_e, profileId: unknown, body: unknown, token: unknown) => {
			const denied = scheduledProfile(profileId, token)
			if (denied) return denied
			return controlWrite<ScheduledSchedule>(
				'POST',
				'/scheduled-runs',
				{ ...(body as object), profileId },
				REQUEST_TIMEOUT_MS,
				token,
			)
		})
		ipcMain.handle(
			'daemon:scheduled:update',
			async (_e, profileId: unknown, rawId: unknown, body: unknown, token: unknown) => {
				const denied = scheduledProfile(profileId, token)
				if (denied) return denied
				return controlWrite<ScheduledSchedule>(
					'PUT',
					`/scheduled-runs/${id(rawId)}`,
					{ ...(body as object), profileId },
					REQUEST_TIMEOUT_MS,
					token,
				)
			},
		)
		ipcMain.handle(
			'daemon:scheduled:action',
			async (_e, profileId: unknown, rawId: unknown, action: unknown, revision: unknown, token: unknown) => {
				const denied = scheduledProfile(profileId, token)
				if (denied) return denied
				if (action !== 'archive' && action !== 'enable' && action !== 'disable' && action !== 'run')
					return { error: 'Unknown scheduled action.', status: 400 }
				const path = action === 'run' ? `/scheduled-runs/${id(rawId)}/run` : `/scheduled-runs/${id(rawId)}/${action}`
				const body = action === 'run' ? { profileId } : { profileId, revision }
				return controlWrite<ScheduledSchedule | ScheduledRun>('POST', path, body, REQUEST_TIMEOUT_MS, token)
			},
		)
		ipcMain.handle(
			'daemon:scheduled:history',
			async (_e, profileId: unknown, rawId: unknown, limit: unknown, token: unknown) => {
				const denied = scheduledProfile(profileId, token)
				if (denied) return denied
				const safeLimit = typeof limit === 'number' && Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 20
				return controlRead<ScheduledRun[]>(
					`/scheduled-runs/${id(rawId)}/history?profileId=${id(profileId)}&limit=${safeLimit}`,
					token,
				)
			},
		)
		ipcMain.handle(
			'daemon:scheduled:cancel-run',
			async (_e, profileId: unknown, runId: unknown, revision: unknown, token: unknown) => {
				const denied = scheduledProfile(profileId, token)
				if (denied) return denied
				if (typeof runId !== 'string' || typeof revision !== 'number' || !Number.isInteger(revision))
					return { error: 'Invalid scheduled run identity.', status: 400 }
				return controlWrite<ScheduledRun>(
					'POST',
					`/scheduled-runs/runs/${id(runId)}/cancel`,
					{ profileId, revision },
					REQUEST_TIMEOUT_MS,
					token,
				)
			},
		)
	}
}

export default { HelmBridge, scheduledProfileTokenMatches }
