// helm open S1 (docs/plans/helm-open/spec.md): CLI arguments, the `hello` / `view` wire against new and old hosts,
// byte compatibility of every version 1 result, plain-mode admission, the window-aware shortcut router and plain
// windows in the real window manager (Electron mocked in a child process).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import artifactModule from '../app/src/document-review/canvas-artifact'
import documentModule from '../app/src/document-review/document'
import viewerModule from '../app/src/document-review/viewer-file'
import shortcutModule from '../app/src/window-shortcuts'
import { parseOpenArguments, runOpenCli } from '../src/cli/open.js'
import type { OpenCliDependencies } from '../src/cli/open.js'
import { REVIEW_V1, callReview, helloReview, viewReview } from '../src/document-review/client.js'
import { ReviewControlServer } from '../src/document-review/control-server.js'
import type { ReviewControlBackend } from '../src/document-review/control-server.js'
import { privateDirectory, writePrivateJson } from '../src/document-review/private-state.js'
import { helloSchema } from '../src/document-review/protocol.js'
import type { ReviewViewResult } from '../src/document-review/protocol.js'
import { UNCERTAIN_REVIEW_FAILURE, refuse } from '../src/document-review/refusal.js'
import { recordWireTranscript } from './helpers/document-review-wire-transcript.js'
const { helmPrivatePaths, plistWorkingDirectory, readViewerFile, privatePathRefusal } = viewerModule
const { routeShortcut } = shortcutModule
const { appendReviewArtifact } = artifactModule
const { ReviewDocumentObservation, reviewRevision } = documentModule
const run = promisify(execFile)

// ---- CLI arguments ------------------------------------------------------------------------------------------------

test('helm open parses files and flags and refuses every mistake before contacting the desktop', () => {
	assert.deepEqual(parseOpenArguments(['a.md', 'b.md']), {
		files: ['a.md', 'b.md'],
		listen: false,
		json: false,
		help: false,
		editOptions: [],
	})
	assert.equal(parseOpenArguments(['--json', 'a.md']).json, true)
	assert.equal(parseOpenArguments(['help']).help, true)
	assert.equal(parseOpenArguments(['--help']).help, true)
	assert.deepEqual(parseOpenArguments(['--listen', 'a.md', '--agent', 'claude', '--timeout', '60']).editOptions, [
		'--agent',
		'claude',
		'--timeout',
		'60',
	])
	for (const [args, reason] of [
		[[], /Name at least one file/],
		[['--listen', 'a.md', 'b.md'], /--listen takes exactly one file; nothing was opened/],
		[['--agent', 'claude', 'a.md'], /--agent belongs to helm open --listen/],
		[['--json', '--json', 'a.md'], /Repeated option: --json/],
		[['--timeout'], /Expected one value for --timeout/],
		[['-'], /does not read standard input/],
		[['--reveal', 'a.md'], /--reveal is not available yet/],
		[['--default-app', 'a.md'], /--default-app is not available yet/],
		[['--bogus', 'a.md'], /Unknown option for helm open: --bogus/],
		[Array.from({ length: 33 }, (_, index) => `${index}.md`), /at most 32 files at once/],
	] as const)
		assert.throws(() => parseOpenArguments([...args]), reason)
})

test('helm open --listen is helm edit FILE, and two files with --listen never reach the desktop', async () => {
	const edits: string[][] = []
	const deps: OpenCliDependencies = {
		root: '/nonexistent/helm-open-root',
		stdout: async () => {},
		stderr: () => assert.fail('no stderr'),
		sleep: async () => {},
		edit: async args => {
			edits.push(args)
		},
	}
	assert.equal(await runOpenCli(['--listen', 'spec.md', '--label', 'Spec'], deps), 0)
	assert.deepEqual(edits, [['spec.md', '--label', 'Spec']])
	// Refused in parsing: no discovery read, no connect.
	await assert.rejects(runOpenCli(['--listen', 'a.md', 'b.md'], deps), /exactly one file/)
	assert.equal(edits.length, 1)
})

// ---- hosts --------------------------------------------------------------------------------------------------------

async function newHost(view?: ReviewControlBackend['view']) {
	const root = join(await realpath(await mkdtemp('/tmp/hop-')), 'r')
	const backend: ReviewControlBackend = {
		status: () => ({ available: true }),
		current: () => true,
		connect: async () => assert.fail('helm open never connects'),
		command: () => assert.fail('helm open sends no caller command'),
		disconnect: () => {},
		...(view ? { view } : {}),
	}
	const host = new ReviewControlServer(root, backend)
	await host.start()
	return { root, host, close: () => host.stop() }
}

/** A version 1 desktop: it answers every frame it cannot parse with the old generic failure. */
async function oldHost() {
	const root = await privateDirectory(join(await realpath(await mkdtemp('/tmp/hoo-')), 'r'))
	const socket = join(root, 'control.sock')
	const frames: unknown[] = []
	const server: Server = createServer(connection => {
		let data = ''
		connection.on('data', chunk => {
			data += chunk.toString('utf8')
			if (!data.endsWith('\n')) return
			frames.push(JSON.parse(data))
			connection.end(`${JSON.stringify({ error: UNCERTAIN_REVIEW_FAILURE })}\n`)
		})
	})
	await new Promise<void>(done => server.listen(socket, done))
	await chmod(socket, 0o600)
	await writePrivateJson(join(root, 'discovery.json'), {
		version: 1,
		epoch: randomUUID(),
		socket,
		token: 'a'.repeat(64),
	})
	return { root, frames, close: () => new Promise<void>(done => server.close(() => done())) }
}

const capture = () => {
	const out: string[] = []
	const err: string[] = []
	const deps = (root: string): OpenCliDependencies => ({
		root,
		stdout: async text => {
			out.push(text)
		},
		stderr: text => {
			err.push(text)
		},
		sleep: ms => new Promise(done => setTimeout(done, ms)),
		edit: async () => assert.fail('no edit'),
	})
	return { out, err, deps }
}

test('hello answers protocol 2; a version 1 host is learned from hello only and helm open says to update', async () => {
	const fresh = await newHost()
	try {
		assert.deepEqual(await helloReview(fresh.root), { protocol: 2, features: ['session-hint'] })
	} finally {
		await fresh.close()
	}
	const old = await oldHost()
	try {
		assert.deepEqual(await helloReview(old.root), REVIEW_V1)
		const io = capture()
		assert.equal(await runOpenCli(['notes.md'], io.deps(old.root)), 1)
		assert.deepEqual(io.err, ['Update the Helm desktop to use helm open. Nothing was opened.\n'])
		assert.deepEqual(io.out, [])
		// Only the probe reached the old host: a `view` is never sent to learn its version.
		assert.deepEqual(
			old.frames.map(frame => (frame as { command: { action: string } }).command.action),
			['hello', 'hello'],
		)
	} finally {
		await old.close()
	}
})

test('hello never downgrades on a definite refusal or a missing desktop', async () => {
	const fresh = await newHost()
	try {
		const discovery = JSON.parse(await readFile(join(fresh.root, 'discovery.json'), 'utf8'))
		await assert.rejects(
			callReview({ ...discovery, token: 'b'.repeat(64) }, { action: 'hello' }, helloSchema),
			/discovery token is not current/,
		)
	} finally {
		await fresh.close()
	}
	await assert.rejects(helloReview('/tmp/helm-open-no-such-root'), error => error !== null)
})

test('unknown commands and unknown command fields are refused definitively with an update message', async () => {
	const fresh = await newHost()
	try {
		const discovery = JSON.parse(await readFile(join(fresh.root, 'discovery.json'), 'utf8'))
		const raw = (command: unknown) =>
			callReview(discovery, command as never, helloSchema).then(
				() => assert.fail('must be refused'),
				(error: Error) => error.message,
			)
		const unknown = await raw({ action: 'frobnicate' })
		assert.match(unknown, /^Unknown review command "frobnicate"\. Nothing was done; update the helm CLI/)
		assert.notEqual(unknown, UNCERTAIN_REVIEW_FAILURE)
		const field = await raw({ action: 'hello', anchors: 'v2' })
		assert.match(field, /^Unknown field anchors in review command/)
		const named = await raw({ action: `x${'\u0000'.repeat(3)}${'y'.repeat(200)}` })
		assert.ok(named.length <= 400 && !named.includes('\u0000'))
		// The log never repeats frame content: only the path-and-code shape of a malformed command.
		const lines: string[] = []
		const original = console.warn
		console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '))
		try {
			await raw({ action: 'frobnicate' })
			await raw({ action: 'hello', anchors: 'v2' })
		} finally {
			console.warn = original
		}
		assert.deepEqual(lines, [
			'[helm] review: unparsed failed: malformed command (command.action unknown)',
			'[helm] review: unparsed failed: malformed command (command unrecognized_keys)',
		])
	} finally {
		await fresh.close()
	}
})

test('connect carries the session hint only with the session-hint feature; unknown features are refused definitively', async () => {
	const root = join(await realpath(await mkdtemp('/tmp/hop-')), 'r')
	const seen: unknown[] = []
	const host = new ReviewControlServer(root, {
		status: () => ({ available: true }),
		current: () => true,
		connect: async command => {
			seen.push(command)
			throw refuse('Recorded; nothing connected.')
		},
		command: () => assert.fail('no caller command'),
		disconnect: () => {},
	})
	await host.start()
	try {
		const discovery = JSON.parse(await readFile(join(root, 'discovery.json'), 'utf8'))
		const raw = (command: unknown) =>
			callReview(discovery, command as never, helloSchema).then(
				() => assert.fail('must be refused'),
				(error: Error) => error.message,
			)
		const base = {
			action: 'connect',
			workspace: root,
			provider: 'claude',
			label: 'Claude Code',
			transport: 'tool-return',
		}
		const session = randomUUID()
		assert.equal(await raw({ ...base, features: ['session-hint'], session }), 'Recorded; nothing connected.')
		assert.deepEqual(seen, [{ ...base, features: ['session-hint'], session }])
		assert.match(
			await raw({ ...base, features: ['anchors-v3'] }),
			/^Unknown connect feature "anchors-v3"\. Nothing was done/,
		)
		assert.match(await raw({ ...base, session }), /^A session hint needs the session-hint connect feature/)
		assert.equal(seen.length, 1)
		// An old CLI's connect (no features) is unchanged.
		assert.equal(await raw(base), 'Recorded; nothing connected.')
		assert.deepEqual(seen[1], base)
	} finally {
		await host.stop()
	}
})

test('version 1 results stay byte-identical (fixture recorded against main before protocol 2)', async () => {
	const expected = JSON.parse(await readFile('tests/fixtures/document-review-wire-v1.json', 'utf8'))
	const original = console.warn
	console.warn = () => {}
	try {
		assert.deepEqual(await recordWireTranscript(resolve('.')), expected)
	} finally {
		console.warn = original
	}
})

test('view is refused by a host without plain windows, runs one at a time and at most 8 files a second', async () => {
	const none = await newHost()
	try {
		await assert.rejects(viewReview(['/tmp/a.md'], none.root), /cannot show files with helm open/)
	} finally {
		await none.close()
	}
	let release: (() => void) | null = null
	const seen: string[][] = []
	const held = await newHost(async files => {
		seen.push(files)
		if (files[0] === '/tmp/hold.md')
			await new Promise<void>(done => {
				release = done
			})
		return { opened: files.map(file => ({ file, documentId: randomUUID(), format: 'markdown' })), refused: [] }
	})
	try {
		const first = viewReview(['/tmp/hold.md'], held.root)
		while (!release) await new Promise(done => setTimeout(done, 5))
		await assert.rejects(viewReview(['/tmp/b.md'], held.root), /still opening files from another helm open/)
		;(release as () => void)()
		await first
		const files = Array.from({ length: 10 }, (_, index) => `/tmp/f${index}.md`)
		const result = await viewReview(files, held.root)
		// One went to the held call this second: 7 more are admitted, 3 refused with a per-file reason.
		assert.equal(result.opened.length, 7)
		assert.equal(result.refused.length, 3)
		for (const refusal of result.refused) assert.match(refusal.reason, /at most 8 files per second\. Open it again\./)
	} finally {
		await held.close()
	}
})

test('helm open prints JSON, one stderr line per refusal, exit 1, and paces batches under the rate', async () => {
	const host = await newHost(async files => {
		const result: ReviewViewResult = { opened: [], refused: [] }
		for (const file of files)
			if (file.endsWith('bad.md')) result.refused.push({ file, reason: 'bad.md is a device;\nnever shown.' })
			else result.opened.push({ file, documentId: randomUUID(), format: 'markdown' })
		return result
	})
	try {
		const io = capture()
		const files = Array.from({ length: 9 }, (_, index) => `/tmp/n${index}.md`)
		assert.equal(await runOpenCli(['--json', ...files, '/tmp/bad.md'], io.deps(host.root)), 1)
		const printed = JSON.parse(io.out.join('')) as ReviewViewResult
		assert.equal(printed.opened.length, 9)
		assert.deepEqual(
			printed.refused.map(entry => entry.file),
			['/tmp/bad.md'],
		)
		assert.deepEqual(io.err, ['bad.md is a device; never shown.\n'])
		const quiet = capture()
		assert.equal(await runOpenCli(['/tmp/one.md'], quiet.deps(host.root)), 0)
		assert.deepEqual(quiet.out, [])
		assert.deepEqual(quiet.err, [])
	} finally {
		await host.close()
	}
})

test('helm open keeps earlier batches when a later one is refused, and refuses odd paths without sending them', async () => {
	const sent: string[][] = []
	const host = await newHost(async files => {
		sent.push(files)
		if (sent.length === 2) throw refuse('The active Helm profile changed. Nothing was opened.')
		return { opened: files.map(file => ({ file, documentId: randomUUID(), format: 'markdown' as const })), refused: [] }
	})
	try {
		const io = capture()
		const files = Array.from({ length: 18 }, (_, index) => `/tmp/b${index}.md`)
		const odd = ['/tmp/line\nbreak.md', `/tmp/${'x'.repeat(2100)}.md`]
		assert.equal(await runOpenCli(['--json', ...files, ...odd], io.deps(host.root)), 1)
		const printed = JSON.parse(io.out.join('')) as ReviewViewResult
		assert.deepEqual(
			printed.opened.map(entry => entry.file),
			files.slice(0, 8),
		)
		assert.equal(printed.refused.length, 12)
		assert.equal(sent.length, 2)
		assert.ok(sent.flat().every(file => !file.includes('\n') && file.length <= 2048))
		assert.match(io.err.join(''), /\/tmp\/b8\.md: The active Helm profile changed/)
		assert.match(io.err.join(''), /\/tmp\/b16\.md: not sent \(The active Helm profile changed/)
		assert.match(io.err.join(''), /\/tmp\/line\?break\.md: the path has control characters/)
		assert.match(io.err.join(''), /longer than 2048 characters/)
		assert.equal(io.err.length, 12)
		assert.ok(io.err.every(line => line.endsWith('\n') && !line.slice(0, -1).includes('\n')))
	} finally {
		await host.close()
	}
})

// ---- plain admission ----------------------------------------------------------------------------------------------

async function admissionFixture() {
	const base = await realpath(await mkdtemp('/tmp/hoa-'))
	const home = join(base, 'home')
	const daemon = join(base, 'daemon')
	const tmp = join(base, 'tmp')
	const uid = process.getuid?.() ?? 501
	for (const dir of [
		join(home, '.helm'),
		join(home, 'userData', 'profiles'),
		daemon,
		join(tmp, `helm-${uid}`),
		join(base, 'docs'),
	])
		await mkdir(dir, { recursive: true })
	await writeFile(join(home, '.helm', 'local-api-token'), 'SECRET-TOKEN-BYTES\n', { mode: 0o600 })
	await writeFile(join(daemon, 'helm.config.json'), '{}\n', { mode: 0o600 })
	const paths = await helmPrivatePaths({
		home,
		userData: join(home, 'userData'),
		daemonRoots: [daemon],
		authFile: join(home, '.helm', 'local-api-token'),
		uid,
		tmp,
	})
	return {
		base,
		home,
		daemon,
		tmp,
		uid,
		paths,
		docs: join(base, 'docs'),
		close: () => rm(base, { recursive: true, force: true }),
	}
}

test('plain admission shows readable Markdown anywhere, outside any repository, and hides a review journal', async () => {
	const f = await admissionFixture()
	try {
		const file = join(f.docs, 'notes.md')
		await writeFile(file, '# Notes\n\nPlain.\n', { mode: 0o644 })
		const read = await readViewerFile(file, f.paths)
		assert.equal(read.file, file)
		assert.equal(read.format, 'markdown')
		assert.equal(read.text, '# Notes\n\nPlain.\n')
		// A file with another hard link that is not Helm's is shown.
		await link(file, join(f.docs, 'alias.md'))
		assert.equal((await readViewerFile(join(f.docs, 'alias.md'), f.paths)).text, '# Notes\n\nPlain.\n')
		await assert.rejects(readViewerFile(join(f.docs, 'other.markdown'), f.paths), /other\.markdown does not exist/)
		// A plain window shows the body only: a trailing helm-review journal is never shown, required or written.
		const journaled = join(f.docs, 'journaled.md')
		const body = '# Reviewed\n\nBody.\n'
		await writeFile(journaled, body, { mode: 0o600 })
		await appendReviewArtifact(
			f.docs,
			journaled,
			[
				{
					version: 1,
					type: 'thread',
					thread: {
						id: randomUUID(),
						instruction: 'Explain this',
						intent: 'discuss',
						passage: null,
						fields: [],
						provider: 'pi',
						name: 'Conversation',
						state: 'unconfirmed',
					},
				},
			],
			{ expectedSourceRevision: reviewRevision(body), current: () => true },
		)
		const before = await readFile(journaled, 'utf8')
		assert.ok(before.length > body.length)
		const observation = new ReviewDocumentObservation(f.docs, journaled, () => {}, {
			paths: f.paths,
			displayPath: '~/docs/journaled.md',
		})
		await observation.start()
		const shown = observation.current()
		await observation.dispose()
		assert.equal(shown.text, body)
		assert.equal(shown.relativePath, '~/docs/journaled.md')
		assert.equal(shown.archive, undefined)
		assert.equal(await readFile(journaled, 'utf8'), before)
	} finally {
		await f.close()
	}
})

test('plain admission refuses FIFOs, devices through symlinks, folders, swapped symlinks and Helm private files', async () => {
	const f = await admissionFixture()
	try {
		const refused = async (path: string, reason: RegExp, hooks = {}) =>
			assert.rejects(readViewerFile(path, f.paths, hooks), reason)
		const fifo = join(f.docs, 'pipe.md')
		await run('mkfifo', [fifo])
		await refused(fifo, /pipe\.md is a named pipe; helm open shows regular files only/)
		const device = join(f.docs, 'device.md')
		await symlink('/dev/null', device)
		await refused(device, /null is a device/)
		await mkdir(join(f.docs, 'folder.md'))
		await refused(join(f.docs, 'folder.md'), /folder\.md is a folder/)
		// Swapped between the path checks and the open: the open must not follow the new link.
		const swapped = join(f.docs, 'swap.md')
		await writeFile(swapped, '# Safe\n', { mode: 0o600 })
		await refused(swapped, /swap\.md changed while it was opened/, {
			beforeOpen: async () => {
				await symlink(join(f.home, '.helm', 'local-api-token'), join(f.docs, 'swap-link'))
				await rename(join(f.docs, 'swap-link'), swapped)
			},
		})
		// The spec's example: a hard link to the control token under another name.
		await link(join(f.home, '.helm', 'local-api-token'), join(f.docs, 'notes.md'))
		await assert.rejects(readViewerFile(join(f.docs, 'notes.md'), f.paths), error => {
			assert.match((error as Error).message, /notes\.md is a hard link to one of Helm's private files/)
			assert.doesNotMatch((error as Error).message, /SECRET/)
			return true
		})
		// A symlink into ~/.helm is refused by its canonical path.
		await writeFile(join(f.home, '.helm', 'state.md'), '# private\n', { mode: 0o600 })
		await symlink(join(f.home, '.helm', 'state.md'), join(f.docs, 'pointer.md'))
		await refused(join(f.docs, 'pointer.md'), /state\.md is one of Helm's private files/)
		await mkdir(join(f.docs, '.helm-review'))
		await writeFile(join(f.docs, '.helm-review', 'x.md'), '# x\n', { mode: 0o600 })
		await refused(join(f.docs, '.helm-review', 'x.md'), /one of Helm's private files/)
		await writeFile(join(f.tmp, `helm-${f.uid}`, 'session.md'), '# x\n', { mode: 0o600 })
		await refused(join(f.tmp, `helm-${f.uid}`, 'session.md'), /one of Helm's private files/)
		assert.ok(privatePathRefusal(join(f.daemon, 'helm.config.json'), f.paths))
		assert.ok(privatePathRefusal(join(f.daemon, 'helm.db-wal'), f.paths))
		assert.equal(privatePathRefusal(join(f.daemon, 'README.md'), f.paths), null)
		assert.ok(privatePathRefusal(join(f.home, 'userData', 'profiles', 'p', 'notes.md'), f.paths))
	} finally {
		await f.close()
	}
})

test('plain admission sees through macOS firmlink spellings, by path and by inode, and refuses a walk it cannot finish', async () => {
	const f = await admissionFixture()
	const locked = join(f.home, '.helm', 'locked')
	try {
		const state = join(f.home, '.helm', 'state.md')
		await writeFile(state, '# private\n', { mode: 0o600 })
		if (process.platform === 'darwin') {
			// realpath keeps /System/Volumes/Data/… as written; that is still ~/.helm.
			await assert.rejects(
				readViewerFile(`/System/Volumes/Data${state}`, f.paths),
				/state\.md is one of Helm's private files/,
			)
			// Roots spelled the other way: the string check misses, the inode of a folder on the path does not.
			const respelled = {
				...f.paths,
				trees: f.paths.trees.map(root => `/System/Volumes/Data${root}`),
				files: f.paths.files.map(file => `/System/Volumes/Data${file}`),
			}
			assert.equal(privatePathRefusal(state, respelled), null)
			await assert.rejects(readViewerFile(state, respelled), /state\.md is one of Helm's private files/)
			// A private file listed under the other spelling: the opened inode itself is refused.
			await assert.rejects(
				readViewerFile(state, { ...respelled, trees: [], files: [`/System/Volumes/Data${state}`] }),
				/state\.md is one of Helm's private files/,
			)
		}
		// A file with another link, and a private folder Helm cannot list: the walk cannot finish, so it refuses.
		const shared = join(f.docs, 'shared.md')
		await writeFile(shared, '# Shared\n', { mode: 0o644 })
		await link(shared, join(f.docs, 'shared-copy.md'))
		await mkdir(locked)
		await chmod(locked, 0o000)
		await assert.rejects(
			readViewerFile(shared, f.paths),
			/shared\.md has more than one hard link and Helm could not check/,
		)
		await chmod(locked, 0o700)
		assert.equal((await readViewerFile(shared, f.paths)).text, '# Shared\n')
	} finally {
		await chmod(locked, 0o700).catch(() => {})
		await f.close()
	}
})

test('plain admission refuses components, unknown types, invalid UTF-8 and files over 512 KiB with the number', async () => {
	const f = await admissionFixture()
	try {
		await writeFile(join(f.docs, 'card.tsx'), 'export default () => null\n', { mode: 0o600 })
		await assert.rejects(readViewerFile(join(f.docs, 'card.tsx'), f.paths), /Use helm edit to preview components/)
		await writeFile(join(f.docs, 'data.csv'), 'a,b\n', { mode: 0o600 })
		await assert.rejects(readViewerFile(join(f.docs, 'data.csv'), f.paths), /Helm can't show \.csv files yet/)
		await writeFile(join(f.docs, 'Makefile'), 'all:\n', { mode: 0o600 })
		await assert.rejects(readViewerFile(join(f.docs, 'Makefile'), f.paths), /it has no file extension/)
		await writeFile(join(f.docs, 'bytes.md'), Buffer.from([0xc3, 0x28]), { mode: 0o600 })
		await assert.rejects(readViewerFile(join(f.docs, 'bytes.md'), f.paths), /not valid UTF-8/)
		await writeFile(join(f.docs, 'big.md'), 'x'.repeat(600 * 1024), { mode: 0o600 })
		await assert.rejects(
			readViewerFile(join(f.docs, 'big.md'), f.paths),
			/big\.md is 600 KiB; Helm shows Markdown up to 512 KiB/,
		)
		await unlink(join(f.docs, 'big.md'))
	} finally {
		await f.close()
	}
})

test('the launchd plist WorkingDirectory is read for the daemon root', () => {
	const plist = '<dict>\n\t<key>WorkingDirectory</key>\n\t<string>/Users/me/code/helm &amp; co</string>\n</dict>'
	assert.equal(plistWorkingDirectory(plist), '/Users/me/code/helm & co')
	assert.equal(plistWorkingDirectory('<dict></dict>'), null)
	assert.equal(plistWorkingDirectory('<key>WorkingDirectory</key><string>relative</string>'), null)
})

// ---- shortcut routing ---------------------------------------------------------------------------------------------

test('the shortcut router keeps the cockpit unchanged and gives document windows zoom, close, open and no reload', () => {
	const key = (code: string, extra: Partial<{ shiftKey: boolean; altKey: boolean }> = {}) => ({
		code,
		metaKey: true,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...extra,
	})
	for (const action of ['fontBigger', 'fontSmaller', 'fontReset', 'closeFocused', 'newTerminal'] as const)
		assert.deepEqual(routeShortcut('cockpit', action, key('KeyX'), 'darwin'), { kind: 'action', action })
	// ⌘O stays the agent dock's in the cockpit; ⌘R reaches the View menu there.
	assert.deepEqual(routeShortcut('cockpit', null, key('KeyO'), 'darwin'), { kind: 'pass' })
	assert.deepEqual(routeShortcut('cockpit', null, key('KeyR'), 'darwin'), { kind: 'pass' })

	assert.deepEqual(routeShortcut('document', 'fontBigger', key('Equal'), 'darwin'), { kind: 'zoom', step: 1 })
	assert.deepEqual(routeShortcut('document', 'fontSmaller', key('Minus'), 'darwin'), { kind: 'zoom', step: -1 })
	assert.deepEqual(routeShortcut('document', 'fontReset', key('Digit0'), 'darwin'), { kind: 'zoom', step: 0 })
	assert.deepEqual(routeShortcut('document', 'closeFocused', key('KeyW'), 'darwin'), { kind: 'close-window' })
	assert.deepEqual(routeShortcut('document', null, key('KeyO'), 'darwin'), { kind: 'open-file' })
	assert.deepEqual(routeShortcut('document', null, key('KeyR'), 'darwin'), { kind: 'swallow' })
	assert.deepEqual(routeShortcut('document', null, key('KeyR', { shiftKey: true }), 'darwin'), { kind: 'swallow' })
	// ⌥⌘R is the planned reveal key, not a reload.
	assert.deepEqual(routeShortcut('document', null, key('KeyR', { altKey: true }), 'darwin'), { kind: 'pass' })
	assert.deepEqual(routeShortcut('document', null, key('KeyO', { shiftKey: true }), 'darwin'), { kind: 'pass' })
	assert.deepEqual(routeShortcut('document', 'newTerminal', key('KeyT'), 'darwin'), {
		kind: 'action',
		action: 'newTerminal',
	})
	// Ctrl is Primary elsewhere; Cmd there is not.
	const ctrl = { code: 'KeyO', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }
	assert.deepEqual(routeShortcut('document', null, ctrl, 'linux'), { kind: 'open-file' })
	assert.deepEqual(routeShortcut('document', null, ctrl, 'darwin'), { kind: 'pass' })
})

// ---- plain windows in the real window manager ---------------------------------------------------------------------

test('plain windows open inactive, are reused, have their own bound, and binding reruns feedback admission', async () => {
	const base = await realpath(await mkdtemp('/tmp/how-'))
	const workspace = join(base, 'repo')
	await mkdir(workspace)
	await run('git', ['init', '-q', workspace])
	const files: Record<string, string> = {}
	for (const name of ['spec.md', '.hidden.md', 'linked.md', ...Array.from({ length: 8 }, (_, i) => `v${i}.md`)]) {
		files[name] = join(workspace, name)
		await writeFile(files[name] as string, `# ${name}\n`, { mode: 0o600 })
	}
	await link(files['linked.md'] as string, join(base, 'linked-copy.md'))
	const module = resolve('app/src/document-review/window.ts')
	const viewer = resolve('app/src/document-review/viewer-file.ts')
	const script = `
		const assert = require('node:assert/strict');
		const { createRequire } = require('node:module');
		const local = createRequire(${JSON.stringify(module)});
		const electron = local.resolve('electron');
		let nextId = 1;
		const windows = [];
		const handlers = {};
		class BrowserWindow {
			constructor(options) {
				this.options = options; this.calls = []; this.events = {}; this.destroyed = false;
				const self = this;
				this.webContents = {
					id: nextId++, isDestroyed: () => self.destroyed,
					mainFrame: { isDestroyed: () => self.destroyed, send() {} },
					setWindowOpenHandler() {}, on() {}, send() {},
				};
				windows.push(this);
			}
			on(event, listener) { (this.events[event] ??= []).push(listener); return this }
			once(event, listener) { return this.on(event, listener) }
			emit(event, ...args) { for (const listener of this.events[event] ?? []) listener(...args) }
			async loadFile() { this.emit('ready-to-show') }
			show() { this.calls.push('show') } showInactive() { this.calls.push('showInactive') } focus() { this.calls.push('focus') }
			isDestroyed() { return this.destroyed }
			close() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
			destroy() { this.close() }
		}
		require.cache[electron] = { id: electron, filename: electron, loaded: true,
			exports: { BrowserWindow, dialog: {}, ipcMain: { handle(name, fn) { handlers[name] = fn }, on() {} }, shell: {} } };
		const { DocumentReviewWindows } = local(${JSON.stringify(module)});
		const { helmPrivatePaths } = local(${JSON.stringify(viewer)});
		const files = ${JSON.stringify(files)};
		(async () => {
			const paths = await helmPrivatePaths({ home: ${JSON.stringify(join(base, 'home'))}, userData: ${JSON.stringify(join(base, 'ud'))},
				daemonRoots: [], authFile: ${JSON.stringify(join(base, 'home', '.helm', 'token'))}, uid: process.getuid(), tmp: ${JSON.stringify(join(base, 'tmp'))} });
			const manager = new DocumentReviewWindows({
				distDir: ${JSON.stringify(base)}, profileToken: () => 'current', allowsToken: token => token === 'current',
				profileId: () => 'profile', profileDir: () => ${JSON.stringify(join(base, 'profile'))}, registry: () => ({}),
				mainWindow: () => null, planArtifact: () => null, privatePaths: async () => paths,
			});
			manager.registerIpc();
			const signal = new AbortController().signal;
			const opened = await manager.viewFiles([files['.hidden.md'], files['linked.md']], signal);
			assert.deepEqual(opened.refused, []);
			assert.equal(windows.length, 2);
			// A wire view never takes focus.
			for (const win of windows) assert.deepEqual(win.calls, ['showInactive']);
			// The same file again: the existing window, no new one, still no focus.
			const again = await manager.viewFiles([files['.hidden.md']], signal);
			assert.equal(again.opened[0].documentId, opened.opened[0].documentId);
			assert.equal(windows.length, 2);
			assert.deepEqual(windows[0].calls, ['showInactive']);

			const caller = manager.connectCaller('pi', ${JSON.stringify(workspace)}, 'Pi', 'in-process');
			const edit = file => manager.openForCaller(file, 'current', 'profile', caller.id, caller.owner);
			// Binding a plain window reruns the feedback admission: hidden and hard-linked files stay plain.
			await assert.rejects(edit(files['.hidden.md']), /hidden file/);
			await assert.rejects(edit(files['linked.md']), /more than one hard link/);
			assert.equal(windows.length, 2);
			for (const win of windows) assert.deepEqual(win.calls, ['showInactive']);

			// Eight more plain windows (ten in all) never count against the eight feedback windows.
			const many = await manager.viewFiles(Array.from({ length: 8 }, (_, i) => files['v' + i + '.md']), signal);
			assert.equal(many.opened.length, 8);
			assert.equal(windows.length, 10);
			await edit(files['spec.md']);
			assert.equal(windows.length, 11);
			assert.deepEqual(windows[10].calls, ['show']);
			// helm open --listen on a plain-shown visible file binds that same window instead of opening another.
			await edit(files['v0.md']);
			assert.equal(windows.length, 11);
			assert.deepEqual(windows[2].calls, ['showInactive', 'show', 'focus']);
			// A plain window has no review content: retrying or discarding a save through it is refused, and its
			// archive is its own, so nothing retained for the file can hold its close.
			const ipc = (name, win, ...args) =>
				handlers[name]({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'current', ...args);
			assert.match((await ipc('document-review:retry', windows[1])).error, /only shows the file/);
			assert.match(
				(await ipc('document-review:discard-archive', windows[1], '00000000-0000-4000-8000-000000000000')).error,
				/only shows the file/,
			);
			let prevented = false;
			windows[1].emit('close', { preventDefault: () => { prevented = true } });
			assert.equal(prevented, false);
			for (const win of windows) win.close();
		})().catch(error => { console.error(error); process.exitCode = 1; });
	`
	try {
		await run(process.execPath, ['--import', import.meta.resolve('tsx'), '-e', script], { timeout: 60000 })
	} finally {
		await rm(base, { recursive: true, force: true })
	}
})
