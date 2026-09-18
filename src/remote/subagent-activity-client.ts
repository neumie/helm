import { z } from 'zod'
import {
	type RemoteSubagentActivity,
	type RemoteSubagentActivityFrame,
	SUBAGENT_ACTIVITY_READY_EVENT,
	SUBAGENT_ACTIVITY_REQUEST_EVENT,
} from './subagent-activity-protocol.js'
import { remoteSubagentActivityFrameSchema } from './subagent-activity-protocol.js'

export interface RemoteSubagentActivityEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void
	emit(channel: string, data: unknown): void
}

const RETIRED_LIMIT = 16
const unavailable = (availability: 'unavailable' | 'unsupported' = 'unavailable'): RemoteSubagentActivity => ({
	availability,
	coverage: 'unavailable',
	active: null,
})

const validId = (value: unknown): value is string =>
	typeof value === 'string' && value.length === 36 && uuidSchema.safeParse(value).success

type Source = { providerId: string; getter: () => unknown; sequence: number; content: string }
type CapturedValue = string | number | boolean | (() => unknown) | object | null | undefined
function own(value: unknown, key: string): CapturedValue {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const descriptor = Object.getOwnPropertyDescriptor(value, key)
	if (!descriptor || !('value' in descriptor)) return undefined
	const field = descriptor.value
	return field
}

function captureFrame(value: unknown): RemoteSubagentActivityFrame | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const bindingValue = own(value, 'binding')
	const activityValue = own(value, 'activity')
	if (
		!bindingValue ||
		typeof bindingValue !== 'object' ||
		Array.isArray(bindingValue) ||
		!activityValue ||
		typeof activityValue !== 'object' ||
		Array.isArray(activityValue)
	)
		return null
	const binding = {
		version: own(bindingValue, 'version'),
		scope: own(bindingValue, 'scope'),
		sessionId: own(bindingValue, 'sessionId'),
		providerId: own(bindingValue, 'providerId'),
		sequence: own(bindingValue, 'sequence'),
	}
	const activity = {
		availability: own(activityValue, 'availability'),
		coverage: own(activityValue, 'coverage'),
		active: own(activityValue, 'active'),
	}
	const result = remoteSubagentActivityFrameSchema.safeParse({ binding, activity })
	return result.success ? result.data : null
}

const uuidSchema = z.string().uuid()
function captureOffer(
	value: unknown,
	sessionId: string,
): { providerId: string; getter: () => unknown } | 'foreign' | null {
	const offeredSession = own(value, 'sessionId')
	if (validId(offeredSession) && offeredSession !== sessionId) return 'foreign'
	const version = own(value, 'version')
	const scope = own(value, 'scope')
	const providerId = own(value, 'providerId')
	const getter = own(value, 'readActivity')
	return version === 1 &&
		scope === 'session' &&
		offeredSession === sessionId &&
		validId(providerId) &&
		typeof getter === 'function'
		? { providerId, getter: getter as () => unknown }
		: null
}

export class RemoteSubagentActivityClient {
	private source?: Source
	private readonly retired = new Set<string>()
	private observed = false
	private busy = false
	private ambiguous = false
	private disposed = false
	private revision = 0
	private readonly off: () => void

	constructor(
		private readonly events: RemoteSubagentActivityEventBus,
		private readonly sessionId: string,
		private readonly current: () => boolean,
	) {
		this.off = () => {}
		if (!validId(sessionId) || !this.checkCurrent()) {
			this.disposed = true
			return
		}
		this.off = events.on(SUBAGENT_ACTIVITY_READY_EVENT, value => this.accept(value))
		try {
			events.emit(SUBAGENT_ACTIVITY_REQUEST_EVENT, Object.freeze({ version: 1, scope: 'session', sessionId }))
		} catch {
			this.fail()
		}
	}

	private fail() {
		this.observed = true
		this.ambiguous = true
		this.revision++
	}
	private checkCurrent(): boolean {
		if (this.disposed || this.ambiguous) return false
		try {
			if (this.current()) return !this.disposed && !this.ambiguous
		} catch {
			this.fail()
			return false
		}
		this.fail()
		return false
	}
	private valid(source: Source | undefined, revision: number) {
		return (
			!this.disposed && !this.ambiguous && this.checkCurrent() && this.source === source && this.revision === revision
		)
	}
	private retire(providerId: string) {
		this.observed = true
		if (!this.retired.has(providerId) && this.retired.size >= RETIRED_LIMIT) {
			this.fail()
			this.source = undefined
			return
		}
		this.retired.add(providerId)
		this.source = undefined
		this.revision++
	}
	private accept(value: unknown) {
		if (this.disposed || this.ambiguous || !this.checkCurrent()) return
		if (this.busy) {
			this.fail()
			return
		}
		this.busy = true
		const baseline = this.source
		const revision = this.revision
		try {
			const candidate = captureOffer(value, this.sessionId)
			if (!this.valid(baseline, revision)) return
			if (candidate === 'foreign') return
			if (!candidate) {
				this.fail()
				return
			}
			if (this.retired.has(candidate.providerId)) return
			this.observed = true
			if (baseline) {
				if (baseline.providerId === candidate.providerId && baseline.getter === candidate.getter) return
				this.fail()
				return
			}
			const getter = candidate.getter
			const raw = getter()
			if (!this.valid(baseline, revision)) return
			if (raw === null) {
				this.retire(candidate.providerId)
				return
			}
			const frame = captureFrame(raw)
			if (!this.valid(baseline, revision)) return
			if (!frame || frame.binding.sessionId !== this.sessionId || frame.binding.providerId !== candidate.providerId) {
				this.fail()
				return
			}
			this.source = {
				providerId: candidate.providerId,
				getter: candidate.getter,
				sequence: frame.binding.sequence,
				content: JSON.stringify(frame.activity),
			}
			this.revision++
		} catch {
			this.fail()
		} finally {
			this.busy = false
		}
	}
	read(): { activity: RemoteSubagentActivity; revision: number } {
		const source = this.source
		if (this.disposed || this.ambiguous || !this.checkCurrent() || !source)
			return { activity: unavailable(this.observed ? 'unavailable' : 'unsupported'), revision: this.revision }
		if (this.busy) {
			this.fail()
			return { activity: unavailable(), revision: this.revision }
		}
		this.busy = true
		const revision = this.revision
		try {
			const getter = source.getter
			const raw = getter()
			if (!this.valid(source, revision)) return { activity: unavailable(), revision: this.revision }
			if (raw === null) {
				this.retire(source.providerId)
				return { activity: unavailable(), revision: this.revision }
			}
			const frame = captureFrame(raw)
			if (!this.valid(source, revision)) return { activity: unavailable(), revision: this.revision }
			if (!frame || frame.binding.sessionId !== this.sessionId || frame.binding.providerId !== source.providerId)
				return { activity: unavailable(), revision: this.revision }
			const content = JSON.stringify(frame.activity)
			if (
				frame.binding.sequence < source.sequence ||
				(frame.binding.sequence === source.sequence && content !== source.content)
			) {
				this.fail()
				return { activity: unavailable(), revision: this.revision }
			}
			source.sequence = frame.binding.sequence
			source.content = content
			return { activity: frame.activity, revision: this.revision }
		} catch {
			return { activity: unavailable(), revision: this.revision }
		} finally {
			this.busy = false
		}
	}
	dispose() {
		if (this.disposed) return
		this.disposed = true
		this.source = undefined
		this.revision++
		this.off()
	}
}
