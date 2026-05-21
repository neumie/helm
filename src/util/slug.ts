export function slugify(text: string, maxLength = 50): string {
	return text
		.normalize('NFD')
		.replace(/\p{Mn}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, maxLength)
}

/**
 * Human-readable, chronologically-sortable identifier for a task's plan
 * directory under `docs/plans/`. Format: `<YYYY-MM-DD>-<slug>` derived from
 * the task title at first-compute time. Stable thereafter \u2014 does NOT follow
 * branch renames or title edits.
 */
export function computePlanDirName(title: string, now: Date = new Date()): string {
	const yyyy = now.getUTCFullYear()
	const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
	const dd = String(now.getUTCDate()).padStart(2, '0')
	return `${yyyy}-${mm}-${dd}-${slugify(title)}`
}
