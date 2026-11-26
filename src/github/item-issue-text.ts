import type { TaskContext } from '../providers/provider.js'

/**
 * Markdown Helm writes onto a run's GitHub issue: the issue body (the task) and
 * the comments (start, result, pull request, failure, close). Pure functions so
 * the wording and the hidden machine-readable blocks are tested on their own.
 *
 * Task content comes from the requester and may come from an untrusted sender.
 * It is shown as data: @mentions are defused so a task can never ping people,
 * and Helm's own markers are only trusted where Helm put them (the first lines).
 */

/** GitHub rejects issue and comment bodies above 65,536 characters. */
const BODY_LIMIT = 60_000
const TITLE_LIMIT = 200
const SUMMARY_LIMIT = 6_000
const ERROR_LIMIT = 1_200
const FILES_LIMIT = 50

export const RESULT_BLOCK_VERSION = 1

/** Marker that ties an issue to one Helm Item; the issue body starts with it. */
export function itemIssueMarker(itemId: string): string {
	return `<!-- helm:item ${safeCommentText(itemId)} -->`
}

/** Marker for the source task, so a later Item for the same task finds its open issue. */
export function sourceIssueMarker(source: { provider: string; externalId: string }): string {
	return `<!-- helm:source ${safeCommentText(`${source.provider}:${source.externalId}`)} -->`
}

/** Text that cannot end or nest an HTML comment and stays on one line. */
function safeCommentText(text: string): string {
	return text
		.replace(/[\r\n]+/g, ' ')
		.replace(/--/g, '-‐')
		.replace(/[<>]/g, '')
}

/** Stop untrusted text from @-mentioning people or teams. */
export function defuseMentions(text: string): string {
	return text.replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, '$1@​')
}

/** Untrusted text may not fake a Helm marker or hidden result block. */
function defuseMarkers(text: string): string {
	return text.replace(/<!--(\s*helm)/gi, '&lt;!--$1')
}

function untrusted(text: string): string {
	return defuseMarkers(defuseMentions(text))
}

/**
 * Untrusted markdown built by a provider (`TaskContext.descriptionMarkdown`).
 * Every `@` that could mention is defused, link destinations included (no
 * exemption: leaf text can fake a `](mailto:@team)` destination), and also right
 * after a backtick, because the markdown may close a code span just before it
 * (`` `x`@team `` mentions @team on GitHub). Providers percent-encode such an `@`
 * inside real destinations, so their links survive.
 */
function untrustedMarkdown(markdown: string): string {
	return defuseMarkers(markdown.replace(/(^|[^\w])@(?=[A-Za-z0-9])/g, '$1@\u200b'))
}

function oneLine(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function bounded(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}\n\n… (truncated)` : text
}

function isHttpUrl(url: string): boolean {
	return /^https?:\/\//i.test(url)
}

/** Local paths say nothing to a reader on GitHub and expose the machine; show `~` for home. */
export function scrubLocalPaths(text: string, home = process.env.HOME): string {
	if (!home || home.length < 2) return text
	return text.split(home).join('~')
}

/**
 * Strip credentials an error message may carry before it is posted: URL
 * userinfo, bearer/basic auth values, GitHub/OpenAI/Slack-style tokens and
 * `key=value` / `key: value` pairs whose key names a secret.
 */
export function redactSecrets(text: string): string {
	return text
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
		.replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
		.replace(/\b(gh[pousr]_|github_pat_|sk-|xox[abposr]-|AKIA)[A-Za-z0-9_-]{8,}/g, '[redacted]')
		.replace(
			/(["']?)([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|auth|cookie|credential)[A-Za-z0-9_-]*)\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&]+)/gi,
			'$1$2$1$3[redacted]',
		)
}

export function issueTitle(item: { title: string; displayName?: string | null }): string {
	return oneLine(item.displayName?.trim() || item.title, TITLE_LIMIT) || 'Helm task'
}

function taskDescription(task: TaskContext): string {
	const markdown = task.descriptionMarkdown?.trim()
	if (markdown) return untrustedMarkdown(markdown)
	const blocks = task.descriptionBlocks ?? []
	if (blocks.length > 0) {
		const parts = blocks.map(block =>
			block.type === 'text' ? untrusted(block.text) : isHttpUrl(block.url) ? `![image](${block.url})` : '',
		)
		const joined = parts.filter(part => part.trim().length > 0).join('\n\n')
		if (joined.trim()) return joined
	}
	return untrusted(task.description?.trim() ?? '')
}

export interface IssueBodyInput {
	itemId: string
	projectSlug: string
	source: { provider: string; externalId: string; url?: string | null } | null
	task: TaskContext
}

/**
 * The issue body is the task as it stands when Helm first starts it. The task
 * text is quoted as data; the run itself still takes its instructions from
 * Helm's prompt, never from this issue.
 */
export function issueBody(input: IssueBodyInput): string {
	const lines = [itemIssueMarker(input.itemId)]
	if (input.source) lines.push(sourceIssueMarker(input.source))
	lines.push(
		'',
		'_Filed by Helm. Helm posts each run’s start and result here; the pull request that solves it closes this issue._',
		'',
	)
	const facts = [`**Project:** ${input.projectSlug}`]
	if (input.source?.url && isHttpUrl(input.source.url)) facts.push(`**Source:** ${input.source.url}`)
	lines.push(facts.join('  \n'), '', '## Task', '', `### ${untrusted(oneLine(input.task.title, TITLE_LIMIT))}`, '')
	const description = taskDescription(input.task)
	lines.push(description || '_No description._')
	const attachments = input.task.attachments ?? []
	if (attachments.length > 0) {
		lines.push('', '### Attachments', '')
		for (const attachment of attachments.slice(0, 50)) {
			const name = untrusted(oneLine(attachment.name, 200))
			lines.push(isHttpUrl(attachment.url) ? `- [${name}](${attachment.url})` : `- ${name}`)
		}
	}
	return bounded(lines.join('\n'), BODY_LIMIT)
}

export interface RunStartInput {
	attempt: number
	agent: string
	model?: string | null
	workspace: string
	branchName?: string | null
}

export function runStartComment(input: RunStartInput): string {
	const details = [`agent ${input.agent}`]
	if (input.model) details.push(`model ${input.model}`)
	details.push(input.workspace === 'main' ? 'main checkout' : 'worktree')
	if (input.branchName) details.push(`branch \`${input.branchName}\``)
	return `**Helm** started run ${input.attempt} (${details.join(', ')}).`
}

/** Machine-readable run result carried in a hidden block of the result comment. */
export interface IssueRunResult {
	v: typeof RESULT_BLOCK_VERSION
	itemId: string
	attempt: number
	summary: string
	filesChanged: string[]
	prTitle?: string
	prUrl?: string
	finishedAt: string
}

const RESULT_OPEN = '<!-- helm:result '
const RESULT_CLOSE = ' -->'

/** JSON that cannot close the surrounding HTML comment (`--` only occurs inside strings). */
function hiddenJson(value: unknown): string {
	return JSON.stringify(value).replace(/--/g, '-\\u002d').replace(/>/g, '\\u003e')
}

export function runResultComment(result: IssueRunResult): string {
	const lines = [
		`**Helm** finished run ${result.attempt}.`,
		'',
		bounded(untrusted(result.summary.trim()), SUMMARY_LIMIT),
	]
	const files = result.filesChanged.slice(0, FILES_LIMIT)
	if (files.length > 0) {
		lines.push('', `**Files changed (${result.filesChanged.length})**`, '')
		for (const file of files) lines.push(`- \`${oneLine(file, 300).replace(/`/g, "'")}\``)
		if (result.filesChanged.length > files.length)
			lines.push(`- … and ${result.filesChanged.length - files.length} more`)
	}
	if (result.prUrl) lines.push('', `**Pull request:** ${result.prUrl}`)
	const block = {
		...result,
		summary: oneLine(result.summary, SUMMARY_LIMIT),
		filesChanged: files,
	}
	lines.push('', `${RESULT_OPEN}${hiddenJson(block)}${RESULT_CLOSE}`)
	return lines.join('\n')
}

/** Read the hidden result block back from a comment body (null when absent or malformed). */
export function parseRunResultComment(body: string): IssueRunResult | null {
	const start = body.lastIndexOf(RESULT_OPEN)
	if (start === -1) return null
	const end = body.indexOf(RESULT_CLOSE, start + RESULT_OPEN.length)
	if (end === -1) return null
	try {
		const value = JSON.parse(body.slice(start + RESULT_OPEN.length, end)) as Partial<IssueRunResult>
		if (
			value.v !== RESULT_BLOCK_VERSION ||
			typeof value.itemId !== 'string' ||
			typeof value.attempt !== 'number' ||
			typeof value.summary !== 'string' ||
			!Array.isArray(value.filesChanged) ||
			typeof value.finishedAt !== 'string'
		)
			return null
		return value as IssueRunResult
	} catch {
		return null
	}
}

export function pullRequestComment(prUrl: string): string {
	return `**Helm** pull request: ${prUrl}`
}

export function runFailureComment(input: { attempt: number; phase: string; message: string }): string {
	const message = bounded(untrusted(redactSecrets(scrubLocalPaths(input.message.trim()))), ERROR_LIMIT)
	return `**Helm** run ${input.attempt} failed (${input.phase}).\n\n> ${message.replace(/\n/g, '\n> ')}`
}

export function runCancelledComment(attempt: number): string {
	return `**Helm** run ${attempt} was cancelled.`
}

export function closeComment(kind: 'done' | 'merged' | 'cancelled'): string {
	if (kind === 'cancelled') return '**Helm**: the task was cancelled, closing.'
	if (kind === 'merged') return '**Helm**: the pull request was merged, closing.'
	return '**Helm**: the task was marked done without a pull request, closing.'
}

/** True when a PR body already closes `reference` (`#12` or `owner/repo#12`) with a GitHub closing keyword. */
export function closesIssue(body: string, reference: string): boolean {
	const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	return new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s*:?\\s+${escaped}(?![\\w/])`, 'i').test(body)
}

/** `body` with a `Closes <reference>` line appended unless it already closes it. */
export function withClosingReference(body: string, reference: string): string {
	if (closesIssue(body, reference)) return body
	return body.trim() ? `${body.trimEnd()}\n\nCloses ${reference}` : `Closes ${reference}`
}
