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

import { BrowserWindow, ipcMain } from 'electron'
import { normalizeDashboardItemResult, normalizeDashboardItems } from './normalize-helm'
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
	ProfileMutationResult,
	ProfilesDocument,
	ProfilesState,
	RunContextDraft,
	RunContextLoad,
	RunContextReset,
	RunContextSave,
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
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
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

	constructor(
		daemonUrl: string,
		private readonly acceptsProfileToken: (token: unknown) => boolean = () => true,
	) {
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
		if (this.profileSwitchTimer) clearTimeout(this.profileSwitchTimer)
		this.timer = null
		this.profileSwitchTimer = null
		this.profileFence = null
	}

	getSnapshot(): HelmSnapshot {
		return this.snapshot
	}

	// --- polling ---------------------------------------------------------------

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
			if (this.stopped || fence !== this.profileFence) return
			if (status.error === undefined && !sameProfileSnapshot && fence) this.kick(fence)

			// A fence owns every completion it started. A replaced epoch must not
			// blank, publish, resolve, or schedule work for its successor.
			if (fence && this.profileFence === fence) {
				const profiles = reachable ? await this.request<ProfilesDocument>('GET', '/profiles') : { error: 'incoherent' }
				if (this.stopped || this.profileFence !== fence) return
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
				if (this.profileSwitchTimer) clearTimeout(this.profileSwitchTimer)
				this.profileSwitchTimer = null
				if (!fence.readyResolved) {
					fence.readyResolved = true
					fence.resolveReady()
				}
			}
			if (status.data && (await this.restartForProtocolMismatch(status.data))) return
			let config = this.snapshot.config
			if (reachable && config === null) config = (await this.request<AppConfig>('GET', '/config')).data ?? null
			this.snapshot = {
				reachable,
				status: status.data ?? this.snapshot.status,
				items: items.data ? normalizeDashboardItems(items.data) : this.snapshot.items,
				config,
			}
			this.publish()
		} finally {
			this.ticking = false
			if (
				!this.stopped &&
				this.profileFence !== null &&
				!this.profileFence.readyResolved &&
				this.profileSwitchTimer === null
			) {
				const epoch = this.profileFence.epoch
				this.profileSwitchTimer = setTimeout(() => {
					if (this.profileFence?.epoch === epoch) {
						this.profileSwitchTimer = null
						this.kick()
					}
				}, 150)
				this.profileSwitchTimer.unref()
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
		for (const win of BrowserWindow.getAllWindows()) {
			if (!win.webContents.isDestroyed()) win.webContents.send('daemon:snapshot', this.snapshot)
		}
	}

	// --- HTTP proxy ------------------------------------------------------------

	private async request<T>(
		method: 'GET' | 'POST' | 'PUT',
		path: string,
		body?: unknown,
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<HelmResult<T>> {
		try {
			const res = await fetch(`${this.baseUrl}/api${path}`, {
				method,
				headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
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
		if (this.profileSwitchTimer) clearTimeout(this.profileSwitchTimer)
		this.profileSwitchTimer = null
		let resolveReady!: () => void
		const record: ProfileFenceRecord = {
			epoch: ++this.nextProfileFenceEpoch,
			targetId: profileId,
			ready: new Promise<void>(resolve => {
				resolveReady = resolve
			}),
			resolveReady: () => resolveReady(),
			readyResolved: false,
		}
		this.profileFence = record
		this.snapshot = { ...this.snapshot, reachable: false, status: null, items: null }
		this.publish()
		this.kick(record)
		return {
			epoch: record.epoch,
			ready: record.ready,
			cancelIfCurrent: () => {
				if (this.profileFence !== record) return
				this.profileFence = null
				if (this.profileSwitchTimer) clearTimeout(this.profileSwitchTimer)
				this.profileSwitchTimer = null
				this.kick()
			},
			adoptObservedProfile: observedId => {
				if (this.profileFence !== record) return
				record.targetId = observedId
				this.kick(record)
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
		if (this.profileFence !== record) return null
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
		const profiles = await this.request<ProfilesDocument>('GET', '/profiles')
		if (this.profileFence !== record || profiles.error !== undefined || profiles.data === undefined) return null
		if (profiles.data.activeProfileId !== statusProfileId) return null
		if (status.data.profileGeneration !== undefined && status.data.profileGeneration !== profiles.data.generation)
			return null
		return profiles.data
	}

	listProfiles(): Promise<HelmResult<ProfilesDocument>> {
		return this.request<ProfilesDocument>('GET', '/profiles')
	}

	activateProfile(profileId: string): Promise<HelmResult<ProfileActivationResult>> {
		return this.request<ProfileActivationResult>('POST', `/profiles/${encodeURIComponent(profileId)}/activate`)
	}

	createProfile(name: string, enabledProjects: string[]): Promise<HelmResult<ProfileMutationResult>> {
		return this.request<ProfileMutationResult>('POST', '/profiles', { name, enabledProjects })
	}

	updateProfile(
		profileId: string,
		body: { name?: string; enabledProjects?: string[] },
	): Promise<HelmResult<ProfileMutationResult>> {
		return this.request<ProfileMutationResult>('PUT', `/profiles/${encodeURIComponent(profileId)}`, body)
	}

	archiveProfile(profileId: string): Promise<HelmResult<ProfileMutationResult>> {
		return this.request<ProfileMutationResult>('POST', `/profiles/${encodeURIComponent(profileId)}/archive`)
	}

	restoreProfile(profileId: string): Promise<HelmResult<ProfileMutationResult>> {
		return this.request<ProfileMutationResult>('POST', `/profiles/${encodeURIComponent(profileId)}/restore`)
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
			return normalizeDashboardItemResult(await this.request<DashboardItem>('GET', `/items/${id(rawId)}`))
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
	}
}
