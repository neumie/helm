/** Pure recurrence policy for scheduled runs. Occurrences are minute-granular. */

export const MAX_CRON_LENGTH = 100
export const OCCURRENCE_HORIZON_DAYS = 400
export const MISFIRE_GRACE_MS = 6 * 60 * 60 * 1000
export const MISSED_OCCURRENCE_COUNT_CAP = 99

export type Cadence =
	| { kind: 'hourly'; minute: number }
	| { kind: 'daily'; hour: number; minute: number }
	| { kind: 'weekly'; weekday: number; hour: number; minute: number }
	| { kind: 'cron'; expression: string }

export type CadenceKind = Cadence['kind']

export interface NormalizedRecurrence {
	cadenceKind: CadenceKind
	cron: string
	timezone: string
}

export interface ScheduledOccurrence {
	/** UTC instant at which this nominal civil slot occurs. */
	at: Date
	/** ISO-8601 UTC form of `at`, convenient for persistence. */
	scheduledFor: string
	/** Civil minute in the schedule timezone, independent of offset. */
	localCivil: string
	/** Offset at the selected (first, for a fold) occurrence. */
	offsetMinutes: number
	/** Durable identity for a civil slot. Folds deliberately share this key. */
	slotKey: string
}

export interface DueOccurrence {
	occurrence: ScheduledOccurrence
	decision: 'run' | 'skipped_misfire'
	/** Older nominal slots dropped rather than queued. */
	dropped: { count: number; many: boolean }
}

interface ParsedCron {
	minute: Set<number>
	hour: Set<number>
	dayOfMonth: Set<number>
	month: Set<number>
	dayOfWeek: Set<number>
	dayOfMonthAny: boolean
	dayOfWeekAny: boolean
	canonical: string
}

interface CivilMinute {
	year: number
	month: number
	day: number
	hour: number
	minute: number
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function assertIntegerInRange(value: number, min: number, max: number, label: string): void {
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${label} must be an integer from ${min} to ${max}`)
	}
}

function cronField(field: string, min: number, max: number, label: string): Set<number> {
	if (!field || /\s/.test(field)) throw new Error(`Invalid ${label} cron field`)
	const values = new Set<number>()
	for (const part of field.split(',')) {
		if (!part) throw new Error(`Invalid ${label} cron field`)
		const stepParts = part.split('/')
		if (stepParts.length > 2) throw new Error(`Invalid ${label} cron step`)
		const [rangePart, stepText] = stepParts
		const step = stepText === undefined ? 1 : Number(stepText)
		if (!Number.isInteger(step) || step <= 0 || step > max - min + 1) {
			throw new Error(`Invalid ${label} cron step`)
		}

		let start: number
		let end: number
		if (rangePart === '*') {
			start = min
			end = max
		} else if (/^\d+$/.test(rangePart)) {
			start = Number(rangePart)
			end = stepText === undefined ? start : max
		} else {
			const match = /^(\d+)-(\d+)$/.exec(rangePart)
			if (!match) throw new Error(`Invalid ${label} cron range`)
			start = Number(match[1])
			end = Number(match[2])
		}
		assertIntegerInRange(start, min, max, label)
		assertIntegerInRange(end, min, max, label)
		if (end < start) throw new Error(`Invalid ${label} cron range`)
		for (let value = start; value <= end; value += step) values.add(value)
	}
	return values
}

/** Parses exactly five numeric cron fields; aliases, seconds, and years are rejected. */
export function parseCron(expression: string): ParsedCron {
	if (typeof expression !== 'string' || expression.length === 0 || expression.length > MAX_CRON_LENGTH) {
		throw new Error('Cron expression must be 1 to 100 characters')
	}
	if (expression.trim() !== expression || expression.startsWith('@')) {
		throw new Error('Cron must be an explicit five-field expression')
	}
	const fields = expression.split(/\s+/)
	if (fields.length !== 5) throw new Error('Cron must have exactly five fields')
	const [minuteText, hourText, domText, monthText, dowText] = fields
	const dayOfWeek = cronField(dowText, 0, 7, 'day of week')
	if (dayOfWeek.delete(7)) dayOfWeek.add(0)
	return {
		minute: cronField(minuteText, 0, 59, 'minute'),
		hour: cronField(hourText, 0, 23, 'hour'),
		dayOfMonth: cronField(domText, 1, 31, 'day of month'),
		month: cronField(monthText, 1, 12, 'month'),
		dayOfWeek,
		dayOfMonthAny: domText === '*',
		dayOfWeekAny: dowText === '*',
		canonical: fields.join(' '),
	}
}

export function assertIanaTimezone(timezone: string): string {
	if (typeof timezone !== 'string' || !timezone || timezone.trim() !== timezone) {
		throw new Error('Timezone must be an explicit IANA timezone')
	}
	try {
		const resolved = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone
		if (!resolved || resolved === 'UTC' ? timezone !== 'UTC' && timezone !== 'Etc/UTC' : false) {
			throw new Error('Timezone must be an explicit IANA timezone')
		}
	} catch {
		throw new Error(`Invalid IANA timezone: ${timezone}`)
	}
	return timezone
}

/** Converts guided cadence controls to the persisted five-field cron form. */
export function normalizeCadence(cadence: Cadence, timezone: string): NormalizedRecurrence {
	assertIanaTimezone(timezone)
	let cron: string
	switch (cadence.kind) {
		case 'hourly':
			assertIntegerInRange(cadence.minute, 0, 59, 'minute')
			cron = `${cadence.minute} * * * *`
			break
		case 'daily':
			assertIntegerInRange(cadence.minute, 0, 59, 'minute')
			assertIntegerInRange(cadence.hour, 0, 23, 'hour')
			cron = `${cadence.minute} ${cadence.hour} * * *`
			break
		case 'weekly':
			assertIntegerInRange(cadence.minute, 0, 59, 'minute')
			assertIntegerInRange(cadence.hour, 0, 23, 'hour')
			assertIntegerInRange(cadence.weekday, 0, 6, 'weekday')
			cron = `${cadence.minute} ${cadence.hour} * * ${cadence.weekday}`
			break
		case 'cron':
			cron = parseCron(cadence.expression).canonical
			break
		default:
			return assertNever(cadence)
	}
	const parsed = parseCron(cron)
	// A syntactically valid cron such as 0 0 31 2 * must not be accepted.
	if (!findNext(parsed, timezone, new Date(), OCCURRENCE_HORIZON_DAYS)) {
		throw new Error(`Cron has no occurrence within ${OCCURRENCE_HORIZON_DAYS} days`)
	}
	return { cadenceKind: cadence.kind, cron: parsed.canonical, timezone }
}

/** Stable non-cadence identity for an explicit manual run. */
export function manualSlotKey(runId: string): string {
	if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
		throw new Error('Manual run id must be a safe opaque identifier')
	}
	return `manual:${runId}`
}

/** Finds the first civil slot strictly after `after`. */
export function nextOccurrence(cron: string, timezone: string, after: Date): ScheduledOccurrence | null {
	return findNext(parseCron(cron), assertIanaTimezone(timezone), after, OCCURRENCE_HORIZON_DAYS)
}

/**
 * Selects at most one due occurrence. Earlier slots are represented by a bounded
 * aggregate, never returned as a launch backlog.
 */
export function latestDueOccurrence(cron: string, timezone: string, nextRunAt: Date, now: Date): DueOccurrence | null {
	const parsed = parseCron(cron)
	assertIanaTimezone(timezone)
	if (!isValidDate(nextRunAt) || !isValidDate(now)) throw new Error('Occurrence times must be valid dates')
	if (nextRunAt.getTime() > now.getTime()) return null

	const latest = findPreviousOrEqual(parsed, timezone, now, OCCURRENCE_HORIZON_DAYS)
	if (!latest || latest.at.getTime() < nextRunAt.getTime()) return null
	let cursor = nextRunAt
	let olderCount = 0
	let many = false
	while (cursor.getTime() < latest.at.getTime()) {
		olderCount += 1
		if (olderCount > MISSED_OCCURRENCE_COUNT_CAP) {
			olderCount = MISSED_OCCURRENCE_COUNT_CAP
			many = true
			break
		}
		const following = findNext(parsed, timezone, cursor, OCCURRENCE_HORIZON_DAYS)
		if (!following || following.at.getTime() > latest.at.getTime()) break
		cursor = following.at
	}
	return {
		occurrence: latest,
		decision: now.getTime() - latest.at.getTime() <= MISFIRE_GRACE_MS ? 'run' : 'skipped_misfire',
		dropped: { count: olderCount, many },
	}
}

function findNext(parsed: ParsedCron, timezone: string, after: Date, horizonDays: number): ScheduledOccurrence | null {
	if (!isValidDate(after)) throw new Error('Occurrence time must be a valid date')
	let wall = civilAt(after, timezone)
	// Every recurrence is strictly after the supplied instant, including an exact fire time.
	let cursor = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) + 60_000
	const end = cursor + horizonDays * 86_400_000
	while (cursor <= end) {
		wall = civilFromWallMs(cursor)
		if (matches(parsed, wall)) {
			const occurrence = resolveCivilMinute(wall, timezone)
			if (occurrence && occurrence.at.getTime() > after.getTime()) return occurrence
		}
		cursor += 60_000
	}
	return null
}

function findPreviousOrEqual(
	parsed: ParsedCron,
	timezone: string,
	before: Date,
	horizonDays: number,
): ScheduledOccurrence | null {
	let wall = civilAt(before, timezone)
	let cursor = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
	const end = cursor - horizonDays * 86_400_000
	while (cursor >= end) {
		wall = civilFromWallMs(cursor)
		if (matches(parsed, wall)) {
			const occurrence = resolveCivilMinute(wall, timezone)
			if (occurrence && occurrence.at.getTime() <= before.getTime()) return occurrence
		}
		cursor -= 60_000
	}
	return null
}

function matches(parsed: ParsedCron, civil: CivilMinute): boolean {
	if (!parsed.minute.has(civil.minute) || !parsed.hour.has(civil.hour) || !parsed.month.has(civil.month)) return false
	const date = new Date(Date.UTC(civil.year, civil.month - 1, civil.day))
	if (date.getUTCMonth() !== civil.month - 1) return false
	const domMatches = parsed.dayOfMonth.has(civil.day)
	const dowMatches = parsed.dayOfWeek.has(date.getUTCDay())
	// Standard cron semantics: DOM and DOW are ORed when both are restricted.
	return parsed.dayOfMonthAny ? dowMatches : parsed.dayOfWeekAny ? domMatches : domMatches || dowMatches
}

/** Resolves a civil minute to its first real UTC instant; null means a spring gap. */
function resolveCivilMinute(civil: CivilMinute, timezone: string): ScheduledOccurrence | null {
	const wallMs = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute)
	const offsets = new Set<number>()
	// Future IANA changes are normally one hour, but sampling a broad window also
	// covers 30-minute folds and date-line changes without assuming an offset size.
	for (let sample = wallMs - 36 * 3_600_000; sample <= wallMs + 36 * 3_600_000; sample += 3_600_000) {
		offsets.add(offsetAt(new Date(sample), timezone))
	}
	const candidates = [...offsets]
		.map(offset => new Date(wallMs - offset * 60_000))
		.filter(candidate => sameCivilMinute(civilAt(candidate, timezone), civil))
		.sort((a, b) => a.getTime() - b.getTime())
	const at = candidates[0]
	if (!at) return null
	const offsetMinutes = offsetAt(at, timezone)
	const localCivil = civilText(civil)
	return { at, scheduledFor: at.toISOString(), localCivil, offsetMinutes, slotKey: localCivil }
}

function formatter(timezone: string): Intl.DateTimeFormat {
	let cached = formatterCache.get(timezone)
	if (!cached) {
		cached = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		})
		formatterCache.set(timezone, cached)
	}
	return cached
}

function civilAt(date: Date, timezone: string): CivilMinute {
	const values: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {}
	for (const part of formatter(timezone).formatToParts(date)) {
		if (part.type !== 'literal') values[part.type] = Number(part.value)
	}
	return {
		year: requiredPart(values.year),
		month: requiredPart(values.month),
		day: requiredPart(values.day),
		hour: requiredPart(values.hour),
		minute: requiredPart(values.minute),
	}
}

function offsetAt(date: Date, timezone: string): number {
	const civil = civilAt(date, timezone)
	return Math.round(
		(Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute) - date.getTime()) / 60_000,
	)
}

function civilFromWallMs(wallMs: number): CivilMinute {
	const date = new Date(wallMs)
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
		hour: date.getUTCHours(),
		minute: date.getUTCMinutes(),
	}
}

function civilText(civil: CivilMinute): string {
	return `${civil.year.toString().padStart(4, '0')}-${civil.month.toString().padStart(2, '0')}-${civil.day
		.toString()
		.padStart(2, '0')}T${civil.hour.toString().padStart(2, '0')}:${civil.minute.toString().padStart(2, '0')}`
}

function sameCivilMinute(a: CivilMinute, b: CivilMinute): boolean {
	return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute
}

function requiredPart(value: number | undefined): number {
	if (value === undefined || Number.isNaN(value)) throw new Error('Timezone formatter returned an invalid civil time')
	return value
}

function isValidDate(date: Date): boolean {
	return date instanceof Date && !Number.isNaN(date.getTime())
}

function assertNever(value: never): never {
	throw new Error(`Unsupported cadence: ${JSON.stringify(value)}`)
}
