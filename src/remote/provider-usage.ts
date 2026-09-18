import { MAX_USAGE_WINDOWS, type UsageWindow } from './usage-protocol.js'

const FIVE_HOUR_SECONDS = 5 * 3600
const SEVEN_DAY_SECONDS = 7 * 86_400

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value))
}

function elapsedPercent(resetsAt: number | null, windowSeconds: number | null, now: number): number | null {
	if (resetsAt === null || windowSeconds === null || windowSeconds <= 0) return null
	const remaining = Math.max(0, (resetsAt - now) / 1000)
	return clampPercent(((windowSeconds - remaining) / windowSeconds) * 100)
}

function readRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function readNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Claude reports reset points as ISO-8601; anything unparsable leaves the window without an anchor. */
export function isoToEpochMs(value: unknown): number | null {
	if (typeof value !== 'string') return null
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) ? parsed : null
}

function window(
	label: string,
	usedPercent: number,
	resetsAt: number | null,
	windowSeconds: number,
	now: number,
): UsageWindow {
	return {
		label,
		usedPercent: clampPercent(usedPercent),
		resetsAt,
		windowSeconds,
		elapsedPercent: elapsedPercent(resetsAt, windowSeconds, now),
	}
}

/** Label a scoped weekly limit by the model it covers, e.g. a dedicated Fable bucket. */
function scopedLabel(limit: Record<string, unknown>): string | null {
	const model = readRecord(readRecord(limit.scope)?.model)
	const name = model?.display_name
	return typeof name === 'string' && name.trim() ? `Weekly · ${name.trim()}` : null
}

/**
 * Build the visible windows from Anthropic's OAuth usage payload. The top-level
 * `five_hour`/`seven_day` tiers carry the reset anchors; the `limits` array carries
 * the authoritative percentages and the scoped per-model buckets.
 */
export function parseClaudeWindows(payload: unknown, now: number): UsageWindow[] {
	const root = readRecord(payload)
	if (!root) return []
	const tier = (key: string, seconds: number, label: string): UsageWindow | null => {
		const value = readRecord(root[key])
		const used = value ? readNumber(value.utilization) : null
		if (used === null) return null
		return window(label, used, isoToEpochMs(value?.resets_at), seconds, now)
	}
	let session = tier('five_hour', FIVE_HOUR_SECONDS, '5-hour')
	let weekly = tier('seven_day', SEVEN_DAY_SECONDS, 'Weekly')
	const scoped: UsageWindow[] = []

	const limits = Array.isArray(root.limits) ? root.limits : []
	for (const entry of limits) {
		const limit = readRecord(entry)
		if (!limit) continue
		const percent = readNumber(limit.percent)
		if (percent === null) continue
		const kind = typeof limit.kind === 'string' ? limit.kind : null
		const group = typeof limit.group === 'string' ? limit.group : null
		const scopeEmpty = limit.scope === undefined || limit.scope === null
		const resetsAt = isoToEpochMs(limit.resets_at)
		if (kind === 'session' || group === 'session') {
			session = window('5-hour', percent, resetsAt ?? session?.resetsAt ?? null, FIVE_HOUR_SECONDS, now)
			continue
		}
		if (kind === 'weekly_all' || (group === 'weekly' && scopeEmpty)) {
			weekly = window('Weekly', percent, resetsAt ?? weekly?.resetsAt ?? null, SEVEN_DAY_SECONDS, now)
			continue
		}
		if (kind !== 'weekly_scoped' && group !== 'weekly') continue
		const label = scopedLabel(limit)
		// A scoped bucket nobody is using is noise, not information.
		if (!label || (percent <= 0 && limit.is_active !== true)) continue
		scoped.push(window(label, percent, resetsAt ?? weekly?.resetsAt ?? null, SEVEN_DAY_SECONDS, now))
	}

	return [session, weekly, ...scoped]
		.filter((value): value is UsageWindow => value !== null)
		.slice(0, MAX_USAGE_WINDOWS)
}

export function claudeWindowLabel(seconds: number): string {
	return seconds === SEVEN_DAY_SECONDS ? 'Weekly' : `${Math.round(seconds / 3600)}-hour`
}

/**
 * Codex reports one or two windows. The live `/codex/usage` API spells the reset
 * point `reset_at` and the length `limit_window_seconds`; the on-disk `token_count`
 * events spell them `resets_at` and `window_minutes`. Accept either spelling.
 */
export function parseCodexWindow(value: unknown, now: number): UsageWindow | null {
	const record = readRecord(value)
	if (!record) return null
	const used = readNumber(record.used_percent)
	if (used === null) return null
	const seconds =
		readNumber(record.limit_window_seconds) ??
		(readNumber(record.window_minutes) !== null ? (readNumber(record.window_minutes) as number) * 60 : null)
	if (seconds === null || seconds <= 0) return null
	const resetSeconds = readNumber(record.reset_at) ?? readNumber(record.resets_at)
	const resetsAt = resetSeconds !== null && resetSeconds > 0 ? Math.round(resetSeconds * 1000) : null
	return window(claudeWindowLabel(seconds), used, resetsAt, seconds, now)
}

/**
 * The live API nests its windows under `rate_limit` as `primary_window`/`secondary_window`;
 * the on-disk events nest them under `rate_limits` as `primary`/`secondary`.
 */
export function parseCodexWindows(rateLimits: unknown, now: number): UsageWindow[] {
	const record = readRecord(rateLimits)
	if (!record) return []
	return [
		parseCodexWindow(record.primary ?? record.primary_window, now),
		parseCodexWindow(record.secondary ?? record.secondary_window, now),
	].filter((value): value is UsageWindow => value !== null)
}

export function readCodexPlan(rateLimits: unknown): string | null {
	const plan = readRecord(rateLimits)?.plan_type
	return typeof plan === 'string' && plan.trim() ? plan.trim() : null
}
