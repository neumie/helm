import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
	chmodSync,
	closeSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
	attachmentPath,
	materializePreparedAttachmentsToWorktree,
	readAttachment,
	sanitizeAttachmentName,
	saveAttachment,
	snapshotDeclaredAttachments,
	worktreeAttachmentRelativePath,
} from '../src/attachments/store.js'

function withWorkspace(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), 'helm-attachment-maintenance-'))
	try {
		run(root)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}

test('boundary collision names remain reader/localization-stable with distinct bytes through multi-digit suffixes', () => {
	withWorkspace(root => {
		const previous = process.cwd()
		process.chdir(root)
		try {
			const workspace = join(root, 'worktree')
			mkdirSync(workspace)
			for (const [index, input] of [
				'a'.repeat(120),
				`${'b'.repeat(116)}.pdf`,
				`c.${'e'.repeat(118)}`,
				`${'d'.repeat(115)}😀.png`,
			].entries()) {
				const itemId = `item-${index}`
				const names: string[] = []
				for (let i = 0; i < 15; i++) {
					const bytes = Buffer.from(`distinct bytes ${index}/${i}`)
					const name = saveAttachment(itemId, input, bytes)
					assert.ok(name.length <= 120)
					assert.equal(sanitizeAttachmentName(name), name)
					assert.equal(/[\uD800-\uDFFF]/u.test(name), false)
					assert.equal(names.includes(name), false)
					names.push(name)
					assert.deepEqual(readAttachment(itemId, name), bytes)
					const path = attachmentPath(itemId, name)
					assert.ok(path)
					assert.deepEqual(readFileSync(path), bytes)
				}
				const prepared = snapshotDeclaredAttachments(itemId, names)
				materializePreparedAttachmentsToWorktree(itemId, prepared, workspace)
				for (const [i, name] of names.entries()) {
					assert.equal(
						readFileSync(join(workspace, worktreeAttachmentRelativePath(itemId, name)), 'utf8'),
						`distinct bytes ${index}/${i}`,
					)
				}
			}
		} finally {
			process.chdir(previous)
		}
	})
})

for (const kind of ['hardlink', 'symlink', 'dangling-symlink', 'directory', 'fifo', 'writable'] as const) {
	test(`materialization refuses ${kind} before replacing any existing destination`, () => {
		withWorkspace(root => {
			const dest = join(root, '.helm-attachments', 'item')
			mkdirSync(dest, { recursive: true })
			const sentinel = join(root, 'sentinel.txt')
			writeFileSync(sentinel, 'sentinel bytes')
			const first = join(dest, 'first.txt')
			writeFileSync(first, 'original first')
			const unsafe = join(dest, 'unsafe.txt')
			switch (kind) {
				case 'hardlink':
					linkSync(sentinel, unsafe)
					break
				case 'symlink':
					symlinkSync(sentinel, unsafe)
					break
				case 'dangling-symlink':
					symlinkSync(join(root, 'missing'), unsafe)
					break
				case 'directory':
					mkdirSync(unsafe)
					break
				case 'fifo':
					execFileSync('mkfifo', [unsafe])
					break
				case 'writable':
					writeFileSync(unsafe, 'unsafe original')
					chmodSync(unsafe, 0o666)
					break
			}
			const before = lstatSync(unsafe)
			assert.throws(
				() =>
					materializePreparedAttachmentsToWorktree(
						'item',
						[
							{ name: 'first.txt', bytes: Buffer.from('replacement first') },
							{ name: 'unsafe.txt', bytes: Buffer.from('replacement unsafe') },
						],
						root,
					),
				/unsafe|single-link|regular/i,
			)
			assert.equal(readFileSync(sentinel, 'utf8'), 'sentinel bytes')
			assert.equal(readFileSync(first, 'utf8'), 'original first')
			assert.equal(lstatSync(unsafe).ino, before.ino)
			assert.deepEqual(readdirSync(dest).sort(), ['first.txt', 'unsafe.txt'])
		})
	})
}

test('ordinary replacement publishes a private new inode and leaves no temporary files', () => {
	withWorkspace(root => {
		const dest = join(root, '.helm-attachments', 'item')
		mkdirSync(dest, { recursive: true })
		const path = join(dest, 'file.txt')
		writeFileSync(path, 'old bytes')
		const old = lstatSync(path)
		const retained = openSync(path, 'r')
		try {
			materializePreparedAttachmentsToWorktree('item', [{ name: 'file.txt', bytes: Buffer.from('new bytes') }], root)
			assert.equal(readFileSync(retained, 'utf8'), 'old bytes')
		} finally {
			closeSync(retained)
		}
		assert.equal(readFileSync(path, 'utf8'), 'new bytes')
		assert.notEqual(lstatSync(path).ino, old.ino)
		assert.equal(lstatSync(path).mode & 0o777, 0o600)
		assert.deepEqual(readdirSync(dest), ['file.txt'])
	})
})
