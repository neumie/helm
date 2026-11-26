import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dispatchSolveItem } from '../src/actions/dispatcher.js'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { GhIssueClient, IssueUnavailableError, classifyGhError, parseGithubRemote } from '../src/github/issues.js'
import {
	closesIssue,
	defuseMentions,
	issueBody,
	itemIssueMarker,
	parseRunResultComment,
	redactSecrets,
	runResultComment,
	runSessionLines,
	withClosingReference,
} from '../src/github/item-issue-text.js'
import { ItemCommands } from '../src/items/commands.js'
import { ItemIssues } from '../src/items/issues.js'
import { processSolveItem } from '../src/queue/worker.js'
import { buildPrompt } from '../src/solver/prompt-builder.js'
import { RunResultFile, runResultPath } from '../src/solver/run-result.js'
import type { Solver } from '../src/solver/solver.js'
import { phaseError } from '../src/util/errors.js'
import { FakeIssueClient } from './helpers/fake-issue-client.js'

const config = {
	projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
	solver: { agent: 'claude', branchNaming: { enabled: false }, displayName: { enabled: false } },
	github: { createPrs: false, postComments: false, prPrefix: '[Helm]' },
} as unknown as HelmConfig

function payloadOf(event: { payload: unknown } | undefined): Record<string, unknown> | null {
	if (!event || event.payload == null) return null
	return typeof event.payload === 'string' ? JSON.parse(event.payload) : (event.payload as Record<string, unknown>)
}

const run = { agent: 'claude', model: 'claude-opus-4-7', workspace: 'worktree', branchName: 'fix/thing' }
const task = { title: 'Fix the thing', description: 'Please fix it, @boss will review.' }

function fixture(t: test.TestContext) {
	const dir = mkdtempSync(join(tmpdir(), 'helm-issues-'))
	const db = new DB(join(dir, 'helm.db'))
	t.after(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})
	const commands = new ItemCommands(db.items, config)
	const client = new FakeIssueClient()
	client.remotes.set('/repo', { owner: 'acme', name: 'app' })
	const issues = new ItemIssues(client)
	const startSolve = (input: Partial<Parameters<ItemCommands['createSolveItem']>[0]> = {}) => {
		const item = commands.createSolveItem({ title: 'Fix the thing', projectSlug: 'helm', prompt: 'p', ...input })
		return commands.startItem(item.id)
	}
	return { db, commands, client, issues, startSolve, dir }
}

test('parseGithubRemote accepts github https/ssh remotes only', () => {
	assert.deepEqual(parseGithubRemote('https://github.com/acme/app.git'), { owner: 'acme', name: 'app' })
	assert.deepEqual(parseGithubRemote('https://x-token@github.com/acme/app\n'), { owner: 'acme', name: 'app' })
	assert.deepEqual(parseGithubRemote('git@github.com:acme/my.app.git'), { owner: 'acme', name: 'my.app' })
	assert.deepEqual(parseGithubRemote('ssh://git@github.com/acme/app.git'), { owner: 'acme', name: 'app' })
	assert.equal(parseGithubRemote('https://gitlab.com/acme/app.git'), null)
	assert.equal(parseGithubRemote('/local/bare.git'), null)
	assert.equal(parseGithubRemote('https://github.com/acme/app/../x'), null)
})

test('classifyGhError maps gh failures onto actionable reasons', () => {
	assert.equal(classifyGhError(Object.assign(new Error('spawn gh'), { code: 'ENOENT' })).reason, 'gh-missing')
	assert.equal(
		classifyGhError({ code: 1, stderr: 'To get started with GitHub CLI, please run:  gh auth login' }).reason,
		'gh-auth',
	)
	assert.equal(
		classifyGhError({ code: 1, stderr: 'the acme/app repository has disabled issues' }).reason,
		'issues-disabled',
	)
	assert.equal(
		classifyGhError({ code: 1, stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/x'." }).reason,
		'repo-not-found',
	)
	assert.equal(classifyGhError({ code: 1, stderr: 'boom' }).reason, 'failed')
})

test('GhIssueClient sends bodies on stdin, never argv, and parses created issues', async () => {
	const calls: Array<{ args: string[]; input?: string }> = []
	const client = new GhIssueClient(async (args, options) => {
		calls.push({ args, input: options.input })
		if (args[1] === 'create') return 'https://github.com/acme/app/issues/7\n'
		if (args[1] === 'list')
			return JSON.stringify([
				{ number: 3, url: 'u3', state: 'OPEN', body: 'mentions helm:item abc in text only' },
				{ number: 4, url: 'u4', state: 'CLOSED', body: `${itemIssueMarker('abc')}\nbody` },
			])
		return ''
	})
	const repo = { owner: 'acme', name: 'app' }
	const created = await client.create(repo, { title: 'T', body: 'secret-ish body' })
	assert.deepEqual(created, { number: 7, url: 'https://github.com/acme/app/issues/7', state: 'open' })
	assert.ok(!calls[0]?.args.includes('secret-ish body'))
	assert.equal(calls[0]?.input, 'secret-ish body')
	assert.deepEqual(calls[0]?.args.slice(0, 4), ['issue', 'create', '-R', 'acme/app'])
	const found = await client.find(repo, itemIssueMarker('abc'), 'all')
	assert.deepEqual(found, { number: 4, url: 'u4', state: 'closed' }, 'only an exact marker matches')
	const listArgs = calls.find(call => call.args[1] === 'list')?.args ?? []
	assert.equal(listArgs[listArgs.indexOf('--author') + 1], '@me', 'only issues the gh user filed')
	await client.comment(repo, 4, 'hello')
	assert.deepEqual(calls.at(-1), {
		args: ['issue', 'comment', '4', '-R', 'acme/app', '--body-file', '-'],
		input: 'hello',
	})
})

test('GhIssueClient turns gh failures into IssueUnavailableError', async () => {
	const client = new GhIssueClient(async () => {
		throw Object.assign(new Error('exit 4'), { code: 4, stderr: 'gh auth login required' })
	})
	await assert.rejects(client.comment({ owner: 'a', name: 'b' }, 1, 'x'), (error: unknown) => {
		assert.ok(error instanceof IssueUnavailableError)
		assert.equal(error.reason, 'gh-auth')
		return true
	})
})

test('issue text defuses mentions and markers and round-trips the hidden result block', () => {
	assert.equal(defuseMentions('ping @boss and mail a@b.cz'), 'ping @​boss and mail a@b.cz')
	const body = issueBody({
		itemId: 'item-1',
		projectSlug: 'psyon',
		source: { provider: 'ClientCare', externalId: 'T-1', url: 'https://cc.test/t/1' },
		task: {
			title: 'Fix @team',
			description: 'Do it <!-- helm:item other --> now',
			attachments: [
				{ name: 'shot.png', url: 'https://cdn.test/shot.png' },
				{ name: 'mail.eml', url: '/api/items/x/attachments/mail.eml' },
			],
		},
	})
	assert.ok(body.startsWith(`${itemIssueMarker('item-1')}\n<!-- helm:source ClientCare:T-1 -->`))
	assert.ok(body.includes('**Source:** https://cc.test/t/1'))
	assert.ok(body.includes('Fix @​team'))
	assert.ok(!body.includes('<!-- helm:item other'), 'task text cannot plant a Helm marker')
	assert.ok(body.includes('- [shot.png](https://cdn.test/shot.png)'))
	assert.ok(body.includes('- mail.eml'))

	const comment = runResultComment({
		v: 1,
		itemId: 'item-1',
		attempt: 2,
		summary: 'Done --> fixed <tag> @boss',
		filesChanged: ['src/a.ts'],
		prUrl: 'https://github.com/acme/app/pull/9',
		finishedAt: '2026-11-24T10:00:00.000Z',
	})
	assert.ok(comment.includes('**Helm** finished run 2.'))
	assert.ok(comment.includes('- `src/a.ts`'))
	const hidden = comment.slice(comment.lastIndexOf('<!-- helm:result'))
	assert.ok(!hidden.slice(4, -3).includes('--'), 'hidden JSON cannot close its HTML comment')
	assert.ok(!hidden.slice(0, -3).includes('>'))
	const parsed = parseRunResultComment(comment)
	assert.equal(parsed?.summary, 'Done --> fixed <tag> @boss')
	assert.deepEqual(parsed?.filesChanged, ['src/a.ts'])
	assert.equal(parsed?.prUrl, 'https://github.com/acme/app/pull/9')
	assert.equal(parseRunResultComment('no block'), null)
})

test('failure text is redacted before it is posted', () => {
	const text = redactSecrets(
		'push to https://x-access-token:ghs_abcdefghijklmnop@github.com/a/b failed; Authorization: Bearer abc.def.ghi123; API_KEY=sk-live123456789 token: "s3cr3t-value" ok=1',
	)
	assert.ok(!text.includes('ghs_abcdefghijklmnop'))
	assert.ok(!text.includes('abc.def.ghi123'))
	assert.ok(!text.includes('sk-live123456789'))
	assert.ok(!text.includes('s3cr3t-value'))
	assert.ok(text.includes('ok=1'))
	const json = redactSecrets(
		'{"access_token": "abc\\"def123", \'client_secret\':\'zz9\', "Authorization":"Basic dXNlcjpwYXNz"}',
	)
	assert.ok(!json.includes('def123'), json)
	assert.ok(!json.includes('zz9'), json)
	assert.ok(!json.includes('dXNlcjpwYXNz'), json)
	assert.ok(!redactSecrets('password=ab}cd]ef').includes('cd'), 'unquoted values are redacted up to whitespace')
	assert.ok(text.includes('github.com/a/b failed'))
})

test('GhIssueClient refuses public repositories and repositories without issues', async t => {
	const repoPath = mkdtempSync(join(tmpdir(), 'helm-remote-'))
	t.after(() => rmSync(repoPath, { recursive: true, force: true }))
	execFileSync('git', ['init', '-q'], { cwd: repoPath })
	execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/app.git'], { cwd: repoPath })
	let view = { visibility: 'PUBLIC', hasIssuesEnabled: true }
	const client = new GhIssueClient(async args => {
		assert.deepEqual(args, ['repo', 'view', 'acme/app', '--json', 'visibility,hasIssuesEnabled'])
		return JSON.stringify(view)
	})
	await assert.rejects(client.repoFor(repoPath), (error: IssueUnavailableError) => error.reason === 'public-repo')
	view = { visibility: 'PRIVATE', hasIssuesEnabled: false }
	await assert.rejects(client.repoFor(repoPath), (error: IssueUnavailableError) => error.reason === 'issues-disabled')
	view = { visibility: 'PRIVATE', hasIssuesEnabled: true }
	assert.deepEqual(await client.repoFor(repoPath), { owner: 'acme', name: 'app' })
})

test('closing references are recognized and appended once', () => {
	assert.ok(closesIssue('Fixes #12', '#12'))
	assert.ok(closesIssue('closes: #12.', '#12'))
	assert.ok(!closesIssue('Closes #123', '#12'))
	assert.ok(!closesIssue('See #12', '#12'))
	assert.ok(closesIssue('Resolves acme/app#12', 'acme/app#12'))
	assert.equal(withClosingReference('Body', '#12'), 'Body\n\nCloses #12')
	assert.equal(withClosingReference('Body\n\nCloses #12', '#12'), 'Body\n\nCloses #12')
	assert.equal(withClosingReference('', '#12'), 'Closes #12')
})

test('beginRun creates the issue and links it to the Item; the start comment follows with the session', async t => {
	const { commands, client, issues, startSolve, db } = fixture(t)
	const item = startSolve({ source: { provider: 'ClientCare', externalId: 'T-9', url: 'https://cc.test/t/9' } })
	const linked = await issues.beginRun({ commands, item, repoPath: '/repo', task })
	assert.deepEqual(linked, { number: 1, url: 'https://github.com/acme/app/issues/1', reference: '#1' })
	const issue = client.issue(1)
	assert.equal(issue.title, 'Fix the thing')
	assert.ok(issue.body.startsWith(itemIssueMarker(item.id)))
	assert.ok(issue.body.includes('@​boss'))
	assert.deepEqual(issue.comments, [], 'the start waits for the run directory')
	await issues.announceRunStart(commands, item.id, run)
	assert.deepEqual(issue.comments, [
		'**Helm** started run 1 (agent claude, model claude-opus-4-7, worktree, branch `fix/thing`).',
	])
	const stored = db.items.get(item.id)?.githubIssue
	assert.equal(stored?.number, 1)
	assert.equal(stored?.owner, 'acme')
	assert.equal(stored?.state, 'open')
	assert.deepEqual(
		db.items
			.getEvents(item.id)
			.filter(event => event.eventType.startsWith('issue_'))
			.map(event => event.eventType),
		['issue_linked'],
	)
})

test('a later run reuses the issue, reopening it when it was closed', async t => {
	const { commands, client, issues, startSolve, db } = fixture(t)
	const item = startSolve()
	await issues.beginRun({ commands, item, repoPath: '/repo', task })
	client.issue(1).state = 'closed'
	commands.failItem(item.id, 'boom', 'solve')
	commands.retryItem(item.id)
	const second = commands.startItem(item.id)
	const linked = await issues.beginRun({ commands, item: second, repoPath: '/repo', task })
	await issues.announceRunStart(commands, item.id, run)
	assert.equal(linked?.number, 1)
	assert.equal(client.issues.length, 1, 'no second issue')
	assert.equal(client.issue(1).state, 'open')
	assert.match(client.issue(1).comments.at(-1) ?? '', /started run 2/)
	assert.ok(!client.calls.includes('repoFor') || client.calls.indexOf('repoFor') === 0, 'stored repo is reused')
	const events = db.items.getEvents(item.id).filter(event => event.eventType === 'issue_linked')
	assert.deepEqual(
		events.map(event => payloadOf(event)?.how),
		['created', 'reopened'],
	)
})

test('an Item without a recorded issue finds its own issue by marker, or the open issue of its source task', async t => {
	const { commands, client, issues, startSolve } = fixture(t)
	const first = startSolve({ source: { provider: 'ClientCare', externalId: 'T-5' } })
	await issues.beginRun({ commands, item: first, repoPath: '/repo', task })
	const followUp = startSolve({ source: { provider: 'ClientCare', externalId: 'T-5' } })
	const linked = await issues.beginRun({ commands, item: followUp, repoPath: '/repo', task })
	assert.equal(linked?.number, 1, 'the open issue of the same source task is reused')
	assert.equal(client.issues.length, 1)

	client.issue(1).state = 'closed'
	const third = startSolve({ source: { provider: 'ClientCare', externalId: 'T-5' } })
	const own = await issues.beginRun({ commands, item: third, repoPath: '/repo', task })
	assert.equal(own?.number, 2, 'a closed source issue is not reused by another Item')
})

test('an issue someone else filed with a copied marker is never adopted', async t => {
	const { commands, client, issues, startSolve } = fixture(t)
	const item = startSolve({ source: { provider: 'ClientCare', externalId: 'T-7' } })
	client.issues.push({
		repo: 'acme/app',
		number: 1,
		url: 'https://github.com/acme/app/issues/1',
		title: 'Planted',
		body: `${itemIssueMarker(item.id)}\n<!-- helm:source ClientCare:T-7 -->`,
		state: 'open',
		author: 'mallory',
		closeReason: null,
		comments: [],
	})
	const linked = await issues.beginRun({ commands, item, repoPath: '/repo', task })
	assert.equal(linked?.number, 2, 'Helm files its own issue')
	assert.deepEqual(client.issue(1).comments, [], 'the planted issue is untouched')
})

test('a project without a GitHub remote runs without an issue and records why', async t => {
	const { commands, client, issues, startSolve, db } = fixture(t)
	client.remotes.clear()
	const item = startSolve()
	const linked = await issues.beginRun({ commands, item, repoPath: '/repo', task })
	assert.equal(linked, null)
	assert.equal(client.issues.length, 0)
	const unavailable = db.items.getEvents(item.id).find(event => event.eventType === 'issue_unavailable')
	assert.deepEqual(payloadOf(unavailable), {
		reason: 'no-github-remote',
		message: 'the project has no GitHub remote (origin)',
	})
	assert.equal(db.items.get(item.id)?.githubIssue ?? null, null)
	assert.equal(db.items.get(item.id)?.status, 'running', 'the run itself goes on')
})

test('gh failures while linking degrade to no issue; a cancelled run still throws', async t => {
	const { commands, client, issues, startSolve } = fixture(t)
	const item = startSolve()
	client.failNext = { method: 'create', error: { code: 1, stderr: 'gh auth login' } }
	assert.equal(await issues.beginRun({ commands, item, repoPath: '/repo', task }), null)

	const cancelled = new AbortController()
	cancelled.abort()
	await assert.rejects(
		issues.beginRun({ commands, item, repoPath: '/repo', task, signal: cancelled.signal }),
		(error: Error) => error.name === 'AbortError',
	)
})

test('the result comment carries the summary and a hidden JSON block', async t => {
	const { commands, client, issues, startSolve } = fixture(t)
	const item = startSolve()
	await issues.beginRun({ commands, item, repoPath: '/repo', task })
	await issues.reportResult(commands, item.id, { summary: 'Fixed it', filesChanged: ['a.ts', 'b.ts'] })
	const comment = client.issue(1).comments.at(-1) ?? ''
	assert.match(comment, /^\*\*Helm\*\* finished run 1\.\n\nFixed it/)
	const parsed = parseRunResultComment(comment)
	assert.equal(parsed?.itemId, item.id)
	assert.deepEqual(parsed?.filesChanged, ['a.ts', 'b.ts'])
})

test('an agent-shipped PR gets a closing reference; a Helm-opened PR is announced', async t => {
	const { commands, client, issues, startSolve } = fixture(t)
	const item = startSolve()
	await issues.beginRun({ commands, item, repoPath: '/repo', task })
	commands.completeSolveItem(item.id, {
		worktreePath: '/wt',
		branchName: 'fix/thing',
		planDirName: 'p',
		resultSummary: 's',
	})
	const prUrl = 'https://github.com/acme/app/pull/5'
	commands.recordDispatchPr(item.id, { prUrl, shippedByAgent: true })
	client.pullRequests.set(prUrl, 'Agent body')
	await issues.reportPullRequest(commands, item.id, { announce: false })
	assert.equal(client.pullRequests.get(prUrl), 'Agent body\n\nCloses #1')
	await issues.reportPullRequest(commands, item.id, { announce: true })
	assert.equal(client.calls.filter(call => call === 'editPullRequestBody').length, 1, 'edited once')
	assert.equal(client.issue(1).comments.at(-1), `**Helm** pull request: ${prUrl}`)
})

test('a PR in another repository refers to the issue by owner/repo#N', async t => {
	const { commands, client, issues, startSolve } = fixture(t)
	const item = startSolve()
	await issues.beginRun({ commands, item, repoPath: '/repo', task })
	commands.completeSolveItem(item.id, { worktreePath: '/wt', branchName: 'b', planDirName: 'p', resultSummary: 's' })
	const prUrl = 'https://github.com/acme/other/pull/2'
	commands.recordDispatchPr(item.id, { prUrl })
	await issues.reportPullRequest(commands, item.id, { announce: false })
	assert.equal(client.pullRequests.get(prUrl), 'Closes acme/app#1')
})

test('settle closes done Items as completed and cancelled ones as not planned, once', async t => {
	const { commands, client, issues, startSolve, db } = fixture(t)
	const done = startSolve()
	await issues.beginRun({ commands, item: done, repoPath: '/repo', task })
	commands.completeSolveItem(done.id, { worktreePath: '/wt', branchName: 'b', planDirName: 'p', resultSummary: 's' })
	await issues.settle(commands, done.id)
	assert.equal(client.issue(1).state, 'open', 'review is not finished')
	commands.setItemStatus(done.id, 'done')
	await issues.settle(commands, done.id)
	await issues.settle(commands, done.id)
	assert.equal(client.issue(1).state, 'closed')
	assert.equal(client.issue(1).closeReason, 'completed')
	assert.equal(client.issue(1).comments.at(-1), '**Helm**: the task was marked done without a pull request, closing.')
	assert.equal(client.calls.filter(call => call === 'close').length, 1)
	assert.equal(db.items.get(done.id)?.githubIssue?.state, 'closed')

	const cancelled = startSolve()
	await issues.beginRun({ commands, item: cancelled, repoPath: '/repo', task })
	commands.cancelProcessingItem(cancelled.id, 'Item cancelled by user', 'solve')
	await issues.reportRunEnded(commands, cancelled.id, { cancelled: true })
	assert.equal(client.issue(2).closeReason, 'not planned')
	assert.deepEqual(client.issue(2).comments.slice(-2), [
		'**Helm** run 1 was cancelled.',
		'**Helm**: the task was cancelled, closing.',
	])
	assert.equal(db.items.get(cancelled.id)?.githubIssue?.closedReason, 'not_planned')
})

test('settle records an issue GitHub already closed (merged PR) without closing it again', async t => {
	const { commands, client, issues, startSolve, db } = fixture(t)
	const item = startSolve()
	await issues.beginRun({ commands, item, repoPath: '/repo', task })
	commands.completeSolveItem(item.id, { worktreePath: '/wt', branchName: 'b', planDirName: 'p', resultSummary: 's' })
	commands.recordDispatchPr(item.id, { prUrl: 'https://github.com/acme/app/pull/3' })
	commands.markItemMerged(item.id)
	client.issue(1).state = 'closed'
	await issues.settle(commands, item.id)
	assert.ok(!client.calls.includes('close'))
	const stored = db.items.get(item.id)?.githubIssue
	assert.equal(stored?.state, 'closed')
	assert.equal(payloadOf(db.items.getEvents(item.id).find(event => event.eventType === 'issue_closed'))?.by, 'github')
	assert.deepEqual(
		db.items.listOpenIssuesToSettle().map(open => open.id),
		[],
	)
})

test('a failed run comments on the issue and keeps it open; a failed close is retried later', async t => {
	const { commands, client, issues, startSolve, db } = fixture(t)
	const item = startSolve()
	await issues.beginRun({ commands, item, repoPath: '/repo', task })
	commands.failItem(item.id, `No solver-result.json at ${process.env.HOME}/x/result.json`, 'solve')
	await issues.reportRunEnded(commands, item.id, {
		cancelled: false,
		phase: 'solve',
		message: db.items.get(item.id)?.errorMessage ?? '',
	})
	assert.equal(client.issue(1).state, 'open')
	assert.equal(
		client.issue(1).comments.at(-1),
		'**Helm** run 1 failed (solve).\n\n> No solver-result.json at ~/x/result.json',
	)

	commands.setItemStatus(item.id, 'cancelled')
	client.failNext = { method: 'close', error: { code: 1, stderr: 'HTTP 502' } }
	await issues.settle(commands, item.id)
	assert.deepEqual(
		db.items.listOpenIssuesToSettle().map(open => open.id),
		[item.id],
		'the close is still owed',
	)
	await issues.settleAll(commands, db.items.listOpenIssuesToSettle())
	assert.equal(client.issue(1).state, 'closed')
})

test('RunResultFile reads a plain result and refuses links and stale attempts', t => {
	const dir = mkdtempSync(join(tmpdir(), 'helm-run-result-'))
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const file = new RunResultFile(join(dir, 'runs', 'item-1', 'solver-result.json'))
	file.prepare()
	assert.equal(file.exists(), false)
	assert.equal(file.read(), null)
	writeFileSync(file.path, JSON.stringify({ summary: 'ok', prUrl: 'https://github.com/a/b/pull/1' }))
	assert.equal(file.exists(), true)
	assert.deepEqual(file.read(), { summary: 'ok', filesChanged: [], prUrl: 'https://github.com/a/b/pull/1' })
	file.prepare()
	assert.equal(file.exists(), false, 'prepare drops the previous attempt')

	const target = join(dir, 'elsewhere.json')
	writeFileSync(target, JSON.stringify({ summary: 'planted' }))
	symlinkSync(target, file.path)
	assert.equal(file.exists(), false)
	assert.equal(file.read(), null)

	assert.match(runResultPath('work', '../escape'), /runs\/id-[0-9a-f]{32}\/solver-result\.json$/)
	mkdirSync(join(dir, 'x'))
	assert.match(runResultPath('work', 'abc-123'), /runs\/abc-123\/solver-result\.json$/)
})

test('a solve run files the task as an issue, writes its result outside the repo and links the PR', async t => {
	const { db, commands, client, issues, dir } = fixture(t)
	const provider = {
		name: 'fake',
		pollNewTasks: async () => [],
		getTaskContext: async () => null,
		resolveTaskSummary: async () => null,
		postComment: async () => null,
	}
	const item = commands.createSolveItem({
		title: 'Fix login',
		projectSlug: 'helm',
		prompt: 'The login button is dead.',
	})
	const prUrl = 'https://github.com/acme/app/pull/4'
	client.pullRequests.set(prUrl, 'Fixes the login button.')
	let prompt = ''
	let worktree = ''
	let resultPath = ''
	let sessionId = ''
	const solver: Solver = {
		async solve(params) {
			sessionId = params.sessionId ?? ''
			worktree = join(dir, 'worktrees', params.taskId)
			mkdirSync(worktree, { recursive: true })
			params.onWorktreeReady(worktree)
			// The issue exists before the agent starts, and the prompt names it.
			assert.equal(client.issues.length, 1)
			assert.equal(params.issue?.reference, '#1')
			resultPath = params.resultPath
			const run = new RunResultFile(params.resultPath)
			run.prepare()
			writeFileSync(
				params.resultPath,
				JSON.stringify({ summary: 'Wired the button', filesChanged: ['src/login.ts'], prUrl }),
			)
			prompt = buildPrompt(
				{ title: params.taskTitle },
				{ planDirName: params.planDirName, worktreePath: worktree, resultPath: params.resultPath, issue: params.issue },
			)
			return { worktreePath: worktree, branchName: params.branchName, outcome: { exitCode: 0, events: [] } }
		},
	}
	await processSolveItem(item.id, config, db, provider, solver, undefined, { issues })

	const after = db.items.get(item.id)
	assert.equal(after?.status, 'review')
	assert.equal(after?.prUrl, prUrl)
	assert.equal(after?.githubIssue?.number, 1)
	assert.ok(!resultPath.startsWith(worktree), 'the result lives in Helm state, not the worktree')
	assert.equal(existsSync(join(worktree, 'docs')), false, 'nothing is written under docs/plans')
	assert.match(prompt, /tracked as GitHub issue #1/)
	assert.match(prompt, /Put `Closes #1` in the PR body/)
	assert.ok(prompt.includes(resultPath))
	assert.doesNotMatch(prompt, /git add .*solver-result/)

	const issue = client.issue(1)
	assert.ok(issue.body.includes('The login button is dead.'))
	assert.equal(issue.comments.length, 2)
	assert.match(issue.comments[0] ?? '', /^\*\*Helm\*\* started run 1/)
	assert.equal(parseRunResultComment(issue.comments[1] ?? '')?.summary, 'Wired the button')
	// Helm named the Claude Code session itself; both comments say how to resume it.
	assert.match(sessionId, /^[0-9a-f-]{36}$/)
	const resume = runSessionLines({ agent: 'claude', id: sessionId, directory: worktree })[1] ?? 'missing'
	assert.ok(issue.comments[0]?.includes(`**Session:** Claude Code \`${sessionId}\``))
	assert.ok(issue.comments[0]?.includes(resume))
	assert.ok(issue.comments[1]?.includes(resume))
	assert.deepEqual(parseRunResultComment(issue.comments[1] ?? '')?.session, { agent: 'claude', id: sessionId })
	assert.equal(client.pullRequests.get(prUrl), 'Fixes the login button.\n\nCloses #1')
})

test('a Codex run gets no Helm session ID; its own reported session ID reaches the result comment', async t => {
	const { db, commands, client, issues, dir } = fixture(t)
	const provider = {
		name: 'fake',
		pollNewTasks: async () => [],
		getTaskContext: async () => null,
		resolveTaskSummary: async () => null,
		postComment: async () => null,
	}
	const codexConfig = { ...config, solver: { ...config.solver, agent: 'codex' } } as HelmConfig
	const item = commands.createSolveItem({ title: 'Codex task', projectSlug: 'helm', prompt: 'p' })
	const reported = '019a8c2e-6a1d-7c3e-9f7a-2b8d9e0f1a2b'
	let worktree = ''
	const solver: Solver = {
		async solve(params) {
			assert.equal(params.sessionId ?? null, null)
			worktree = join(dir, 'wt-codex')
			mkdirSync(worktree, { recursive: true })
			params.onWorktreeReady(worktree)
			new RunResultFile(params.resultPath).prepare()
			writeFileSync(params.resultPath, JSON.stringify({ summary: 'Done by Codex', sessionId: reported }))
			return { worktreePath: worktree, branchName: params.branchName, outcome: { exitCode: 0, events: [] } }
		},
	}
	await processSolveItem(item.id, codexConfig, db, provider, solver, undefined, { issues })
	assert.equal(db.items.get(item.id)?.status, 'review')
	const [start, result] = client.issue(1).comments
	assert.match(start ?? '', /^\*\*Helm\*\* started run 1 \(agent codex/)
	assert.ok(!start?.includes('**Session:**'), 'no session line before the ID is known')
	assert.ok(result?.includes(`**Session:** Codex \`${reported}\``))
	assert.ok(result?.includes(runSessionLines({ agent: 'codex', id: reported, directory: worktree })[1] ?? 'missing'))
})

test('a run that fails before its workspace is ready still opens with a start comment, without a session', async t => {
	const { db, commands, client, issues } = fixture(t)
	const provider = {
		name: 'fake',
		pollNewTasks: async () => [],
		getTaskContext: async () => null,
		resolveTaskSummary: async () => null,
		postComment: async () => null,
	}
	const item = commands.createSolveItem({ title: 'No worktree', projectSlug: 'helm', prompt: 'p' })
	const solver: Solver = {
		async solve() {
			throw phaseError('worktree', 'git worktree add failed')
		},
	}
	await processSolveItem(item.id, config, db, provider, solver, undefined, { issues })
	assert.equal(db.items.get(item.id)?.status, 'failed')
	const [start, failure, ...rest] = client.issue(1).comments
	assert.match(start ?? '', /^\*\*Helm\*\* started run 1 \(agent claude/)
	assert.ok(!start?.includes('**Session:**'), 'the agent never started, so there is no session')
	assert.match(failure ?? '', /^\*\*Helm\*\* run 1 failed \(worktree\)/)
	assert.deepEqual(rest, [])
})

test('a solve run in a project without a GitHub remote still completes from its Helm-side result', async t => {
	const { db, commands, client, issues, dir } = fixture(t)
	client.remotes.clear()
	const provider = {
		name: 'fake',
		pollNewTasks: async () => [],
		getTaskContext: async () => null,
		resolveTaskSummary: async () => null,
		postComment: async () => null,
	}
	const item = commands.createSolveItem({ title: 'Local only', projectSlug: 'helm', prompt: 'p' })
	const solver: Solver = {
		async solve(params) {
			const worktree = join(dir, 'wt-local')
			mkdirSync(worktree, { recursive: true })
			params.onWorktreeReady(worktree)
			assert.equal(params.issue ?? null, null)
			new RunResultFile(params.resultPath).prepare()
			writeFileSync(params.resultPath, JSON.stringify({ summary: 'Done locally' }))
			return { worktreePath: worktree, branchName: params.branchName, outcome: { exitCode: 0, events: [] } }
		},
	}
	await processSolveItem(item.id, config, db, provider, solver, undefined, { issues })
	const after = db.items.get(item.id)
	assert.equal(after?.status, 'review')
	assert.equal(after?.resultSummary, 'Done locally')
	assert.equal(after?.githubIssue ?? null, null)
	assert.ok(db.items.getEvents(item.id).some(event => event.eventType === 'issue_unavailable'))
})

test('the fallback PR body closes the tracking issue', async t => {
	const { db, commands, client, issues } = fixture(t)
	const item = commands.startItem(commands.createSolveItem({ title: 'T', projectSlug: 'helm', prompt: 'p' }).id)
	await issues.beginRun({ commands, item, repoPath: '/repo', task })
	commands.completeSolveItem(item.id, { worktreePath: '/wt', branchName: 'b', planDirName: 'p', resultSummary: 's' })
	const bodies: string[] = []
	await dispatchSolveItem({
		itemId: item.id,
		result: { summary: 'Did it', filesChanged: [] },
		config: { ...config, github: { ...config.github, createPrs: true } } as HelmConfig,
		commands,
		provider: { name: 'fake' } as never,
		sideEffects: {
			pushBranch: async () => undefined,
			createPr: async opts => {
				bodies.push(opts.body)
				return 'https://github.com/acme/app/pull/8'
			},
			postComment: async () => null,
		} as never,
	})
	assert.equal(bodies[0], 'Did it\n\nCloses #1')
	assert.equal(db.items.get(item.id)?.prUrl, 'https://github.com/acme/app/pull/8')
	void client
})
