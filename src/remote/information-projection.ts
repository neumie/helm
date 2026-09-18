import { z } from 'zod'
import {
	INFORMATION_MAX_ROWS,
	INFORMATION_MAX_SECTIONS,
	INFORMATION_MAX_SECTION_ROWS,
	INFORMATION_SIDEBAR_BYTES,
	type InformationFooter,
	type InformationSection,
	type InformationSidebar,
	informationBytes,
	informationFooterFieldsSchema,
	informationSectionSchema,
} from './information-protocol.js'

// This module deliberately does not import a producer. Its only input is the
// public request/ready capability's synchronous result; source arbitration and
// current-owner admission must be supplied by the Pi client before disclosure.
const identity = (max: number) =>
	z
		.string()
		.min(1)
		.max(max)
		.refine(value => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value))
const bindingShape = {
	version: z.literal(1),
	scope: z.literal('session'),
	sessionId: identity(1024),
	providerId: identity(128),
	sequence: z.number().int().nonnegative().safe(),
}
const bindingSchema = z.object(bindingShape).strict()
export type InformationSourceBinding = z.infer<typeof bindingSchema>
export interface ProjectedInformationSource<T> {
	binding: InformationSourceBinding
	information: T
}
const footerFields = [
	'cwd',
	'trusted',
	'sessionName',
	'model',
	'thinking',
	'inputTokens',
	'outputTokens',
	'contextTokens',
	'contextWindow',
	'contextPercent',
	'goalAvailable',
	'goalPhase',
	'omittedStatuses',
	'omitted',
] as const

type DescriptorField = string | number | boolean | null | undefined | object
/** Own data descriptors only. Never invoke getters, enumerate, spread, or toJSON. */
function own(value: unknown, key: string): DescriptorField {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const descriptor = Object.getOwnPropertyDescriptor(value, key)
	const field: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined
	return field === null ||
		typeof field === 'string' ||
		typeof field === 'number' ||
		typeof field === 'boolean' ||
		typeof field === 'object'
		? field
		: undefined
}
function primitive(value: unknown): string | number | boolean | null | undefined {
	return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
		? value
		: undefined
}
function fields(value: unknown, keys: readonly string[]): Record<string, ReturnType<typeof primitive>> {
	const detached: Record<string, ReturnType<typeof primitive>> = {}
	for (const key of keys) detached[key] = primitive(own(value, key))
	return detached
}
function binding(value: unknown): InformationSourceBinding | null {
	const result = bindingSchema.safeParse(fields(value, Object.keys(bindingShape)))
	return result.success ? result.data : null
}
function array(value: unknown, max: number): unknown[] | null {
	if (!Array.isArray(value)) return null
	const length = Object.getOwnPropertyDescriptor(value, 'length')?.value as unknown
	if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > max) return null
	const detached: unknown[] = []
	for (let index = 0; index < length; index++) {
		const entry = Object.getOwnPropertyDescriptor(value, String(index))
		if (!entry || !('value' in entry)) return null
		detached.push(entry.value)
	}
	return detached
}
export function unavailableFooter(availability: 'unavailable' | 'unsupported' = 'unavailable'): InformationFooter {
	return { availability, fields: null }
}
export function unavailableSidebar(availability: 'unavailable' | 'unsupported' = 'unavailable'): InformationSidebar {
	return { availability, sections: [], omittedProviders: 0 }
}

/** Invalid source frames return null; valid unavailable frames keep their sequence. */
export function projectFooterSource(value: unknown): ProjectedInformationSource<InformationFooter> | null {
	try {
		const source = binding(value)
		const available = primitive(own(value, 'available'))
		if (!source || typeof available !== 'boolean') return null
		const parsed = informationFooterFieldsSchema.safeParse(fields(value, footerFields))
		if (!parsed.success) return null
		return {
			binding: source,
			information: available ? { availability: 'available', fields: parsed.data } : unavailableFooter(),
		}
	} catch {
		return null
	}
}

/** Isolate a malformed panel without discarding other already-safe sections. */
function section(value: unknown): InformationSection {
	const detached = fields(value, ['title', 'scope', 'availability', 'coverage', 'omitted'])
	const rawRows = array(own(value, 'rows'), INFORMATION_MAX_SECTION_ROWS)
	const parsed = informationSectionSchema.safeParse({
		...detached,
		rows: rawRows?.map(row => fields(row, ['label', 'value'])),
	})
	if (parsed.success) return parsed.data
	// Never preserve stale rows or a malformed title on a failed projection.
	return {
		title: 'Provider',
		scope: detached.scope === 'process' ? 'process' : 'session',
		availability: 'unavailable',
		coverage: 'unavailable',
		rows: [],
		omitted: 0,
	}
}
export function projectSidebarSource(value: unknown): ProjectedInformationSource<InformationSidebar> | null {
	try {
		const source = binding(value)
		const rawSections = array(own(value, 'sections'), INFORMATION_MAX_SECTIONS)
		const omittedProviders = primitive(own(value, 'omittedProviders'))
		if (
			!source ||
			!rawSections ||
			typeof omittedProviders !== 'number' ||
			!Number.isSafeInteger(omittedProviders) ||
			omittedProviders < 0 ||
			omittedProviders > 10_000
		)
			return null
		const sections = rawSections.map(value => {
			try {
				return section(value)
			} catch {
				return {
					title: 'Provider',
					scope: 'session',
					availability: 'unavailable',
					coverage: 'unavailable',
					rows: [],
					omitted: 0,
				} satisfies InformationSection
			}
		})
		if (sections.reduce((total, entry) => total + entry.rows.length, 0) > INFORMATION_MAX_ROWS) return null
		// Include producer-local identity and sequence in the ONE sidebar limit,
		// even though those routing fields are removed before browser disclosure.
		if (informationBytes({ ...source, sections, omittedProviders }) > INFORMATION_SIDEBAR_BYTES) return null
		return { binding: source, information: { availability: 'available', sections, omittedProviders } }
	} catch {
		return null
	}
}
