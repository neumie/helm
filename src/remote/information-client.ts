import {
	type ProjectedInformationSource,
	projectFooterSource,
	projectSidebarSource,
	unavailableFooter,
	unavailableSidebar,
} from './information-projection.js'
import type { InformationFooter, InformationSidebar } from './information-protocol.js'

export const FOOTER_INFORMATION_REQUEST = 'pi-footer:information:v1:request'
export const FOOTER_INFORMATION_READY = 'pi-footer:information:v1:ready'
export const SIDEBAR_INFORMATION_REQUEST = '@neumie/pi-sidebar:information:v1:request'
export const SIDEBAR_INFORMATION_READY = '@neumie/pi-sidebar:information:v1:ready'
export const INFORMATION_RETIRED_SOURCE_LIMIT = 64

/** Structural subset of Pi 0.85.1's public EventBus; no producer/runtime imports. */
export interface InformationEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void
	emit(channel: string, data: unknown): void
}
export interface InformationClientValue {
	footer: InformationFooter
	sidebar: InformationSidebar
}
interface Capability {
	providerId: string
	getter: () => unknown
}
interface Source extends Capability {
	sequence: number
	content: string
	invalid: boolean
}
function identity(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
}
type CapabilityField = string | number | (() => unknown) | undefined
function own(value: unknown, key: string): CapabilityField {
	if (!value || typeof value !== 'object') return undefined
	const descriptor = Object.getOwnPropertyDescriptor(value, key)
	const field: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined
	if (typeof field === 'function') return field as () => unknown
	return typeof field === 'string' || typeof field === 'number' ? field : undefined
}
/** Capture every named descriptor exactly once, before invoking any capability. */
function capability(value: unknown, sessionId: string): Capability | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const version = own(value, 'version')
	const scope = own(value, 'scope')
	const session = own(value, 'sessionId')
	const providerId = own(value, 'providerId')
	const getter = own(value, 'readInformation')
	return version === 1 &&
		scope === 'session' &&
		session === sessionId &&
		identity(providerId, 128) &&
		typeof getter === 'function'
		? { providerId, getter: getter as () => unknown }
		: null
}

/** One bounded source lifetime, independent of any transport connection. */
class SourceSlot<T> {
	private source?: Source
	private readonly retired = new Set<string>()
	private observed = false
	private ambiguous = false
	private busy = false
	private revision = Symbol()
	constructor(
		private readonly sessionId: string,
		private readonly current: () => boolean,
		private readonly project: (value: unknown) => ProjectedInformationSource<T> | null,
		private readonly unavailable: (availability?: 'unsupported' | 'unavailable') => T,
	) {}
	private changed(): void {
		this.revision = Symbol()
	}
	private conflict(): void {
		this.ambiguous = true
		this.changed()
	}
	failedSubscription(): void {
		this.observed = true
		this.conflict()
	}
	clear(): void {
		this.source = undefined
		this.retired.clear()
		this.conflict()
	}
	private retire(providerId: string): boolean {
		if (!this.retired.has(providerId) && this.retired.size >= INFORMATION_RETIRED_SOURCE_LIMIT) {
			this.source = undefined
			this.conflict()
			return false
		}
		this.retired.add(providerId)
		this.source = undefined
		this.changed()
		return true
	}
	private matches(
		value: ProjectedInformationSource<T> | null,
		providerId: string,
	): value is ProjectedInformationSource<T> {
		return value !== null && value.binding.sessionId === this.sessionId && value.binding.providerId === providerId
	}
	accept(payload: unknown): void {
		if (!this.current() || this.ambiguous) return
		if (this.busy) {
			this.conflict()
			return
		}
		this.busy = true
		const source = this.source
		const revision = this.revision
		const valid = () => this.current() && !this.ambiguous && this.source === source && this.revision === revision
		try {
			const candidate = capability(payload, this.sessionId)
			if (!candidate || !valid() || this.retired.has(candidate.providerId)) return
			this.observed = true
			if (source?.providerId === candidate.providerId) {
				if (source.getter !== candidate.getter) this.conflict()
				return // The first admission baseline must not be reset by another ready.
			}
			const candidateGetter = candidate.getter
			const raw = candidateGetter()
			if (!valid()) return
			if (raw === null) {
				// Remember even a candidate first seen after its reliable retirement.
				if (this.retired.size >= INFORMATION_RETIRED_SOURCE_LIMIT) this.conflict()
				else {
					this.retired.add(candidate.providerId)
					this.changed()
				}
				return
			}
			const projected = this.project(raw)
			if (!this.matches(projected, candidate.providerId) || !valid()) return
			const content = JSON.stringify(projected.information) // Detached bounded schema data only.
			if (source) {
				let prior: unknown
				try {
					const priorGetter = source.getter
					prior = priorGetter()
				} catch {
					this.conflict()
					return
				}
				if (!valid()) return
				if (prior !== null) {
					this.conflict()
					return
				}
				if (!this.retire(source.providerId)) return
			}
			this.source = { ...candidate, sequence: projected.binding.sequence, content, invalid: false }
			this.changed()
		} catch {
			// A malformed/throwing candidate is not evidence that an admitted owner retired.
		} finally {
			this.busy = false
		}
	}
	read(): { information: T; valid: () => boolean } {
		let information = this.unavailable(this.observed ? 'unavailable' : 'unsupported')
		if (this.current() && !this.ambiguous && this.source) {
			if (this.busy) this.conflict()
			else {
				this.busy = true
				const source = this.source
				const revision = this.revision
				const valid = () => this.current() && !this.ambiguous && this.source === source && this.revision === revision
				try {
					const sourceGetter = source.getter
					const raw = sourceGetter()
					if (valid()) {
						if (raw === null) this.retire(source.providerId)
						else if (!source.invalid) {
							const projected = this.project(raw)
							if (this.matches(projected, source.providerId) && valid()) {
								const content = JSON.stringify(projected.information)
								if (
									projected.binding.sequence < source.sequence ||
									(projected.binding.sequence === source.sequence && content !== source.content)
								) {
									source.invalid = true
									this.changed()
								} else {
									source.sequence = projected.binding.sequence
									source.content = content
									information = projected.information
								}
							}
						}
					}
				} catch {
					/* Transient failure clears display, not replay/retirement evidence. */
				} finally {
					this.busy = false
				}
			}
		}
		const revision = this.revision
		return { information, valid: () => this.current() && !this.ambiguous && this.revision === revision }
	}
}

/**
 * Create ONCE per admitted Pi observation lifecycle, never per discovery/exchange
 * connection. Keep this instance through transport reconnects. The caller's guard
 * must attest both captured session ID and observation lifecycle. Before native
 * navigation/shutdown, dispose synchronously; only genuine settled lifecycle
 * evidence may create a replacement. No idle/timer/manual-enrollment settlement.
 */
export class RemoteInformationClient {
	private disposed = false
	private checking = false
	private readonly unsubscribers: Array<() => void> = []
	private readonly footer: SourceSlot<InformationFooter>
	private readonly sidebar: SourceSlot<InformationSidebar>
	constructor(
		events: InformationEventBus,
		sessionId: string,
		private readonly isCurrent: (capturedSessionId: string) => boolean,
	) {
		const current = () => this.current(sessionId)
		this.footer = new SourceSlot(sessionId, current, projectFooterSource, unavailableFooter)
		this.sidebar = new SourceSlot(sessionId, current, projectSidebarSource, unavailableSidebar)
		if (!identity(sessionId, 1024) || !current()) {
			this.dispose()
			return
		}
		for (const [channel, slot] of [
			[FOOTER_INFORMATION_READY, this.footer],
			[SIDEBAR_INFORMATION_READY, this.sidebar],
		] as const) {
			if (!current()) break
			try {
				const unsubscribe = events.on(channel, data => slot.accept(data))
				if (this.disposed) unsubscribe()
				else this.unsubscribers.push(unsubscribe)
			} catch {
				slot.failedSubscription()
			}
		}
		for (const channel of [FOOTER_INFORMATION_REQUEST, SIDEBAR_INFORMATION_REQUEST]) {
			if (!current()) break
			try {
				events.emit(channel, Object.freeze({ version: 1, sessionId }))
			} catch {
				/* Optional exporters only. */
			}
		}
	}
	private current(sessionId: string): boolean {
		if (this.disposed) return false
		if (this.checking) {
			this.dispose()
			return false
		}
		this.checking = true
		let valid = false
		try {
			valid = this.isCurrent(sessionId) === true
		} catch {
			/* Guard loss is permanent. */
		} finally {
			this.checking = false
		}
		if (!valid) this.dispose()
		return !this.disposed
	}
	read(): InformationClientValue | null {
		if (this.disposed) return null
		const footer = this.footer.read()
		const sidebar = this.sidebar.read()
		// A sidebar callback can synchronously replace/conflict the footer source.
		const footerCurrent = footer.valid()
		const sidebarCurrent = sidebar.valid()
		if (this.disposed) return null
		return {
			footer: footerCurrent ? footer.information : unavailableFooter(),
			sidebar: sidebarCurrent ? sidebar.information : unavailableSidebar(),
		}
	}
	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.footer.clear()
		this.sidebar.clear()
		for (const unsubscribe of this.unsubscribers.splice(0)) {
			try {
				unsubscribe()
			} catch {
				/* Late callbacks remain fenced even on cleanup failure. */
			}
		}
	}
}
