// Live reload's edit for the code view: pure, so it is unit-tested without CodeMirror.

/** The smallest single replacement turning `before` into `after`: common prefix and suffix stay untouched. */
export function changedSpan(before: string, after: string): { from: number; to: number; insert: string } {
	const shortest = Math.min(before.length, after.length)
	let start = 0
	while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start++
	let end = 0
	while (
		end < shortest - start &&
		before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
	)
		end++
	// Never split a surrogate pair at either edge.
	const high = (code: number) => code >= 0xd800 && code <= 0xdbff
	if (start > 0 && high(before.charCodeAt(start - 1))) start--
	if (end > 0 && high(before.charCodeAt(before.length - end - 1))) end--
	return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) }
}
