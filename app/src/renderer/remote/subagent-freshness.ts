import {
	REMOTE_MAX_OWNERS,
	REMOTE_STALE_MS,
	type RemoteDetail,
	type RemoteDirectory,
	type RemoteTarget,
} from '../../../../src/remote/protocol.js'
import type { RemoteSubagentActivity } from '../../../../src/remote/subagent-activity-protocol.js'

type Clock = () => number
type Timer = ReturnType<typeof setTimeout>
type Entry = { revision: number; activity: RemoteSubagentActivity; deadline: number }
type Baseline = { revision: number; activity?: RemoteSubagentActivity }
export interface RemotePollReceipt {
	accepted(value: unknown, startedAt: number): void
	retire(): void
}
export interface FreshnessTimers {
	setTimeout: (callback: () => void, delay: number) => Timer
	clearTimeout: (timer: Timer) => void
}

const unavailable: RemoteSubagentActivity = Object.freeze({
	availability: 'unavailable',
	coverage: 'unavailable',
	active: null,
})
const activityEqual = (a: RemoteSubagentActivity, b: RemoteSubagentActivity) =>
	a.availability === b.availability && a.coverage === b.coverage && a.active === b.active
const copyActivity = (activity: RemoteSubagentActivity): RemoteSubagentActivity => ({ ...activity })
const validRevision = (revision: number) => Number.isSafeInteger(revision) && revision >= 0
const validTtl = (ttl: number | undefined): ttl is number =>
	typeof ttl === 'number' && Number.isSafeInteger(ttl) && ttl > 0 && ttl <= REMOTE_STALE_MS

export class RemoteSubagentFreshnessController {
	private entries = new Map<string, Entry>()
	private baselines = new Map<string, Baseline>()
	private listeners = new Set<() => void>()
	private timer: Timer | undefined
	private disposed = false
	private snapshot = 0
	private readonly timers: FreshnessTimers
	constructor(
		private readonly now: Clock = () => performance.now(),
		timers?: Partial<FreshnessTimers>,
	) {
		this.timers = {
			setTimeout: (callback, delay) => setTimeout(callback, delay),
			clearTimeout: timer => clearTimeout(timer),
			...timers,
		}
	}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	getSnapshot = () => this.snapshot
	private publish() {
		this.snapshot++
		for (const listener of this.listeners) listener()
	}
	private ownerKey(hostEpoch: string, target: RemoteTarget) {
		return [hostEpoch, target.sessionId, target.incarnation, target.scopeId ?? '', target.generation].join(':')
	}
	private arm() {
		if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
		let next = Number.POSITIVE_INFINITY
		for (const entry of this.entries.values()) next = Math.min(next, entry.deadline)
		if (!Number.isFinite(next)) {
			this.timer = undefined
			return
		}
		this.timer = this.timers.setTimeout(
			() => {
				this.timer = undefined
				this.expire(true)
				this.arm()
			},
			Math.max(0, next - this.now()),
		)
	}
	private expire(notify = true) {
		if (this.disposed) return
		const now = this.now()
		let changed = false
		for (const [key, entry] of this.entries)
			if (entry.deadline <= now) {
				this.entries.delete(key)
				changed = true
			}
		if (changed && notify) this.publish()
	}
	private acceptable(
		hostEpoch: string,
		target: RemoteTarget,
		revision: number,
		connected: boolean,
		activity: RemoteSubagentActivity | undefined,
		ttl: number | undefined,
		startedAt: number,
		entries: Map<string, Entry>,
	) {
		if (!validRevision(revision)) return
		const key = this.ownerKey(hostEpoch, target)
		let baseline = this.baselines.get(key)
		if (baseline && revision < baseline.revision) return
		if (!baseline || revision > baseline.revision) {
			baseline = { revision }
			this.baselines.set(key, baseline)
		}
		if (!connected || activity?.availability !== 'available') return
		if (baseline.activity && !activityEqual(baseline.activity, activity)) return
		// Even aged evidence binds the value at this revision, but never its lease.
		baseline.activity = copyActivity(activity)
		if (!validTtl(ttl) || !Number.isFinite(startedAt)) return
		const deadline = startedAt + ttl
		if (deadline <= this.now()) return
		entries.set(key, { revision, activity: copyActivity(activity), deadline })
	}
	replaceDirectory(value: RemoteDirectory, startedAt: number) {
		if (this.disposed) return
		if (value.sessions.length > REMOTE_MAX_OWNERS) {
			this.retire()
			return
		}
		const keys = value.sessions.map(session => this.ownerKey(value.hostEpoch, session.target))
		if (new Set(keys).size !== keys.length) {
			this.retire()
			return
		}
		const nextEntries = new Map<string, Entry>()
		for (const session of value.sessions)
			this.acceptable(
				value.hostEpoch,
				session.target,
				session.revision,
				session.connected,
				session.subagents,
				session.subagentsFreshForMs,
				startedAt,
				nextEntries,
			)
		const nextKeys = new Set(keys)
		for (const key of this.baselines.keys()) if (!nextKeys.has(key)) this.baselines.delete(key)
		const changed =
			this.entries.size !== nextEntries.size ||
			[...this.entries].some(([key, entry]) => {
				const next = nextEntries.get(key)
				return !next || entry.deadline <= this.now() || !activityEqual(entry.activity, next.activity)
			})
		this.entries = nextEntries
		if (changed) this.publish()
		this.arm()
	}
	replaceDetail(value: RemoteDetail, startedAt: number) {
		if (this.disposed) return
		const key = this.ownerKey(value.hostEpoch, value.snapshot.target)
		const nextEntries = new Map<string, Entry>()
		this.acceptable(
			value.hostEpoch,
			value.snapshot.target,
			value.snapshot.revision,
			value.snapshot.connected,
			value.snapshot.subagents,
			value.snapshot.subagentsFreshForMs,
			startedAt,
			nextEntries,
		)
		for (const baselineKey of this.baselines.keys()) if (baselineKey !== key) this.baselines.delete(baselineKey)
		const changed =
			this.entries.size !== nextEntries.size ||
			[...this.entries].some(([entryKey, entry]) => {
				const next = nextEntries.get(entryKey)
				return !next || entry.deadline <= this.now() || !activityEqual(entry.activity, next.activity)
			})
		this.entries = nextEntries
		if (changed) this.publish()
		this.arm()
	}
	resolve(
		hostEpoch: string,
		target: RemoteTarget,
		revision: number,
		connected: boolean,
		activity: RemoteSubagentActivity | undefined,
	): RemoteSubagentActivity {
		if (this.disposed || !connected || !activity || !validRevision(revision)) return unavailable
		const entry = this.entries.get(this.ownerKey(hostEpoch, target))
		return entry &&
			entry.revision === revision &&
			entry.deadline > this.now() &&
			activityEqual(entry.activity, activity)
			? copyActivity(entry.activity)
			: unavailable
	}
	retire() {
		if (this.disposed) return
		if (this.entries.size) {
			this.entries.clear()
			this.publish()
		}
		this.arm()
	}
	dispose() {
		if (this.disposed) return
		this.disposed = true
		if (this.timer !== undefined) this.timers.clearTimeout(this.timer)
		this.timer = undefined
		this.entries.clear()
		this.baselines.clear()
		this.listeners.clear()
	}
	receipt(onAccepted: (value: unknown, startedAt: number) => void): RemotePollReceipt {
		return { accepted: onAccepted, retire: () => this.retire() }
	}
}
export function remoteActivityAvailable(
	activity: RemoteSubagentActivity | undefined,
): activity is Extract<RemoteSubagentActivity, { availability: 'available' }> {
	return activity?.availability === 'available'
}
