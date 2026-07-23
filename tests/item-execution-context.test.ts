import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { attachmentsDir, saveAttachment } from '../src/attachments/store.js'
import type { HelmConfig } from '../src/config.js'
import { DB } from '../src/db/client.js'
import { ItemCommands } from '../src/items/commands.js'
import { buildItemExecutionContext, prepareItemExecutionContext } from '../src/items/context.js'

const config = {
	provider: {
		type: 'contember',
		apiBaseUrl: 'https://example.test',
		projectSlug: 'helm',
		apiToken: 'token',
		statuses: ['new'],
	},
	projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
	polling: { intervalSeconds: 60 },
	solver: {
		type: 'default',
		agent: 'claude',
		workspace: 'worktree',
		concurrency: 1,
		timeoutMinutes: 30,
		branchNaming: { enabled: false },
		displayName: { enabled: false },
		triage: { enabled: false },
		modelGuidance: {},
	},
	spawner: { name: 'default' },
	server: { port: 7474, host: 'localhost' },
	github: { createPrs: false, postComments: false, prPrefix: '[Helm]', trackDeployments: false, deployPollSeconds: 60 },
} as HelmConfig

function captured(commands: ItemCommands, title: string, bytes: string) {
	const id = `capture-${Math.random().toString(36).slice(2)}`
	const name = saveAttachment(id, 'same.txt', Buffer.from(bytes))
	return commands.createSolveItem({
		id,
		title,
		projectSlug: 'helm',
		prompt: title,
		source: { provider: 'Email', externalId: id },
		capturedContext: { title, attachments: [{ name: 'same.txt', url: `/api/items/${id}/attachments/${name}` }] },
	})
}

test('prepared captured contexts snapshot bytes and isolate same-name Main attachments by Item', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-execution-context-'))
	const db = new DB(join(root, 'helm.db'))
	const commands = new ItemCommands(db.items, config)
	try {
		const first = captured(commands, 'first', 'first bytes')
		const second = captured(commands, 'second', 'second bytes')
		const workspace = mkdtempSync(join(tmpdir(), 'helm-main-attachment-'))
		const firstPrepared = prepareItemExecutionContext(first, buildItemExecutionContext(first, first.capturedContext))
		const secondPrepared = prepareItemExecutionContext(
			second,
			buildItemExecutionContext(second, second.capturedContext),
		)
		assert.equal(
			firstPrepared.onWorktreeReady(workspace).attachments?.[0]?.url,
			`.helm-attachments/${first.id}/same.txt`,
		)
		assert.equal(
			secondPrepared.onWorktreeReady(workspace).attachments?.[0]?.url,
			`.helm-attachments/${second.id}/same.txt`,
		)
		assert.equal(readFileSync(join(workspace, '.helm-attachments', first.id, 'same.txt'), 'utf8'), 'first bytes')
		assert.equal(readFileSync(join(workspace, '.helm-attachments', second.id, 'same.txt'), 'utf8'), 'second bytes')
		rmSync(workspace, { recursive: true, force: true })
	} finally {
		for (const item of db.items.list()) rmSync(attachmentsDir(item.id), { recursive: true, force: true })
		db.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test('prepared captured contexts reject a symlinked attachment destination before outside writes', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-execution-context-'))
	const db = new DB(join(root, 'helm.db'))
	const commands = new ItemCommands(db.items, config)
	const workspace = mkdtempSync(join(tmpdir(), 'helm-symlink-'))
	const outside = mkdtempSync(join(tmpdir(), 'helm-outside-'))
	try {
		const item = captured(commands, 'symlink', 'safe bytes')
		const prepared = prepareItemExecutionContext(item, buildItemExecutionContext(item, item.capturedContext))
		symlinkSync(outside, join(workspace, '.helm-attachments'))
		assert.throws(() => prepared.onWorktreeReady(workspace), /unsafe|symlink/i)
		assert.equal(existsSync(join(outside, item.id, 'same.txt')), false)
	} finally {
		for (const item of db.items.list()) rmSync(attachmentsDir(item.id), { recursive: true, force: true })
		db.close()
		rmSync(root, { recursive: true, force: true })
		rmSync(workspace, { recursive: true, force: true })
		rmSync(outside, { recursive: true, force: true })
	}
})

test('prepared captured contexts reject final source and Item destination symlinks', () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-execution-context-'))
	const db = new DB(join(root, 'helm.db'))
	const commands = new ItemCommands(db.items, config)
	const workspace = mkdtempSync(join(tmpdir(), 'helm-symlink-item-'))
	const outside = mkdtempSync(join(tmpdir(), 'helm-outside-'))
	try {
		const sourceItem = captured(commands, 'source symlink', 'safe bytes')
		const sourcePath = join(attachmentsDir(sourceItem.id), 'same.txt')
		unlinkSync(sourcePath)
		symlinkSync(join(outside, 'source.txt'), sourcePath)
		assert.throws(
			() => prepareItemExecutionContext(sourceItem, buildItemExecutionContext(sourceItem, sourceItem.capturedContext)),
			/non-symlink|regular|ELOOP/i,
		)

		const destItem = captured(commands, 'destination symlink', 'safe bytes')
		const prepared = prepareItemExecutionContext(
			destItem,
			buildItemExecutionContext(destItem, destItem.capturedContext),
		)
		const attachmentRoot = join(workspace, '.helm-attachments')
		mkdirSync(attachmentRoot)
		symlinkSync(outside, join(attachmentRoot, destItem.id))
		assert.throws(() => prepared.onWorktreeReady(workspace), /unsafe|symlink/i)
		assert.equal(existsSync(join(outside, 'same.txt')), false)
	} finally {
		for (const item of db.items.list()) rmSync(attachmentsDir(item.id), { recursive: true, force: true })
		db.close()
		rmSync(root, { recursive: true, force: true })
		rmSync(workspace, { recursive: true, force: true })
		rmSync(outside, { recursive: true, force: true })
	}
})
