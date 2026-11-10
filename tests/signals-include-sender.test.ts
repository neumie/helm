import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema, loadConfig, readConfigFile, writeConfigFile } from '../src/config.js'
import {
	IncludeSenderError,
	createCanUnmuteSender,
	createIncludeSender,
	createMuteSender,
} from '../src/signals/include-sender.js'

function fixture(t: test.TestContext, includeSenders?: string, excludeSenders?: string) {
	const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'helm-include-')))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	const path = join(root, 'helm.config.json')
	const raw = {
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'p', apiToken: 'test-secret' },
		projects: [{ slug: 'p', repoPath: root }],
		signals: {
			mail: {
				enabled: true,
				...(includeSenders === undefined ? {} : { includeSenders }),
				...(excludeSenders === undefined ? {} : { excludeSenders }),
			},
		},
	}
	writeConfigFile(path, JSON.stringify(raw, null, '\t'))
	const config = loadConfig(path).config
	return { path, config }
}

test('adds the exact address to the file and the live config; everything else stays', t => {
	const { path, config } = fixture(t, 'a@b.example')
	const before = JSON.parse(readConfigFile(path))
	const include = createIncludeSender(path, config)
	assert.deepEqual(include(' Petra@Psyon.example '), { address: 'petra@psyon.example', added: true })
	const after = JSON.parse(readConfigFile(path))
	assert.equal(after.signals.mail.includeSenders, 'a@b.example\npetra@psyon.example')
	assert.equal(config.signals.mail.includeSenders, 'a@b.example\npetra@psyon.example')
	assert.equal(after.provider.apiToken, before.provider.apiToken)
	// Settings' strict save writes schema defaults too (baseBranch); the values stay.
	assert.deepEqual(
		after.projects.map((project: { slug: string; repoPath: string }) => [project.slug, project.repoPath]),
		before.projects.map((project: { slug: string; repoPath: string }) => [project.slug, project.repoPath]),
	)
	assert.equal(configSchema.safeParse(after).success, true)
	// Again: already there, nothing written.
	const mtime = fs.statSync(path).mtimeMs
	assert.deepEqual(include('petra@psyon.example'), { address: 'petra@psyon.example', added: false })
	assert.equal(fs.statSync(path).mtimeMs, mtime)
})

test('a glob already on the list counts as included and syncs the live config', t => {
	const { path, config } = fixture(t, '*@psyon.example')
	config.signals.mail.includeSenders = ''
	assert.deepEqual(createIncludeSender(path, config)('petra@psyon.example'), {
		address: 'petra@psyon.example',
		added: false,
	})
	assert.equal(config.signals.mail.includeSenders, '*@psyon.example')
})

test('refuses globs, blanks and a full list without writing', t => {
	const { path, config } = fixture(t, `${'x'.repeat(3990)}@b.example`)
	const raw = readConfigFile(path)
	const include = createIncludeSender(path, config)
	for (const bad of ['', 'no-at-sign', '*@psyon.example', 'a b@c.example', `${'a'.repeat(250)}@b.example`]) {
		assert.throws(() => include(bad), IncludeSenderError, bad)
	}
	assert.throws(() => include('petra@psyon.example'), /include list is full/)
	assert.equal(readConfigFile(path), raw)
})

const lists = (path: string) => {
	const mail = JSON.parse(readConfigFile(path)).signals.mail
	return { include: mail.includeSenders as string, exclude: mail.excludeSenders as string }
}

test('mute adds the exact address to the exclude list and drops its exact include entry', t => {
	// Ridge: an earlier `i` put it on the include list, which beats both the bulk rule and unread-only.
	const { path, config } = fixture(t, '*@sentry.io\nhello@eu.ridge.com', 'ci@builds.example')
	const mute = createMuteSender(path, config)
	assert.deepEqual(mute(' Hello@EU.ridge.com '), { address: 'hello@eu.ridge.com', added: true, unincluded: true })
	assert.deepEqual(lists(path), { include: '*@sentry.io', exclude: 'ci@builds.example\nhello@eu.ridge.com' })
	assert.equal(config.signals.mail.includeSenders, '*@sentry.io')
	assert.equal(config.signals.mail.excludeSenders, 'ci@builds.example\nhello@eu.ridge.com')
	assert.equal(configSchema.safeParse(JSON.parse(readConfigFile(path))).success, true)
	// Again: nothing to change, nothing written.
	const mtime = fs.statSync(path).mtimeMs
	assert.deepEqual(mute('hello@eu.ridge.com'), { address: 'hello@eu.ridge.com', added: false, unincluded: false })
	assert.equal(fs.statSync(path).mtimeMs, mtime)
})

test('mute keeps a matching exclude glob as written', t => {
	const { path, config } = fixture(t, undefined, '*@shop.example')
	assert.deepEqual(createMuteSender(path, config)('deals@shop.example'), {
		address: 'deals@shop.example',
		added: false,
		unincluded: false,
	})
	assert.equal(lists(path).exclude, '*@shop.example')
})

test('mute refuses when Jakub’s include glob would still show the sender, and for Sentry', t => {
	const { path, config } = fixture(t, '*@psyon.example')
	const raw = readConfigFile(path)
	const mute = createMuteSender(path, config)
	assert.throws(() => mute('klara@psyon.example'), /\*@psyon\.example always shows this sender/)
	assert.throws(() => mute('alerts@sentry.io'), /Sentry alerts always show/)
	for (const bad of ['', 'no-at-sign', '*@psyon.example']) assert.throws(() => mute(bad), IncludeSenderError, bad)
	assert.equal(readConfigFile(path), raw)
})

test('mute of a Hide My Email sender: the raw relay address counts like the decoded one', t => {
	// The Mail filter matches the lists against both, so a glob on the relay domain would keep showing it.
	const relay = 'jana_at_x_cz_abc123_0f@privaterelay.appleid.com'
	const glob = fixture(t, '*@privaterelay.appleid.com')
	const raw = readConfigFile(glob.path)
	assert.throws(
		() => createMuteSender(glob.path, glob.config)('jana@x.cz', { raw: relay }),
		/\*@privaterelay\.appleid\.com always shows this sender/,
	)
	assert.equal(readConfigFile(glob.path), raw)
	// An exact include entry for the relay goes with the mute; the decoded address is what is excluded.
	const exact = fixture(t, relay, '')
	assert.deepEqual(createMuteSender(exact.path, exact.config)('jana@x.cz', { raw: relay }), {
		address: 'jana@x.cz',
		added: true,
		unincluded: true,
	})
	assert.deepEqual(lists(exact.path), { include: '', exclude: 'jana@x.cz' })
	// An exclude glob on the relay domain already hides it: nothing added.
	const excluded = fixture(t, '', '*@privaterelay.appleid.com')
	assert.equal(createMuteSender(excluded.path, excluded.config)('jana@x.cz', { raw: relay }).added, false)
})

test('mute refuses an address clipped into another one', t => {
	const { path, config } = fixture(t)
	assert.throws(() => createMuteSender(path, config)(`${'a'.repeat(196)}…`), IncludeSenderError)
	assert.throws(() => createMuteSender(path, config)(`a@${'b'.repeat(196)}…`), IncludeSenderError)
	assert.throws(() => createIncludeSender(path, config)(`a@${'b'.repeat(196)}…`), IncludeSenderError)
	assert.throws(() => createMuteSender(path, config)(`a@${'b'.repeat(260)}.example`), IncludeSenderError)
})

test('canUnmute: only an exact exclude entry with no other exclude glob still matching', t => {
	const relay = 'petra_at_psyon_example_abc_0f@privaterelay.appleid.com'
	const { config } = fixture(t, '', `hello@eu.ridge.com\n*@builds.example\nci@builds.example\n${relay}`)
	const canUnmute = createCanUnmuteSender(config)
	assert.equal(canUnmute('Hello@EU.ridge.com'), true)
	// Jakub's glob keeps it out whatever `i` drops: `i` must always show it instead.
	assert.equal(canUnmute('ci@builds.example'), false)
	assert.equal(canUnmute('deploy@builds.example'), false)
	assert.equal(canUnmute('petra@psyon.example', relay), true)
	assert.equal(canUnmute('nobody@x.cz'), false)
	assert.equal(canUnmute(''), false)
	// Live: follows the config object, so a mute or an unmute shows on the next listing.
	config.signals.mail.excludeSenders = ''
	assert.equal(canUnmute('hello@eu.ridge.com'), false)
})

test('mute refuses a full exclude list without writing', t => {
	const { path, config } = fixture(t, undefined, `${'x'.repeat(3990)}@b.example`)
	const raw = readConfigFile(path)
	assert.throws(() => createMuteSender(path, config)('petra@psyon.example'), /exclude list is full/)
	assert.equal(readConfigFile(path), raw)
})

test('`i` on muted mail unmutes: off the exclude list, never onto the include list', t => {
	const { path, config } = fixture(t, '', 'ci@builds.example\nhello@eu.ridge.com')
	const include = createIncludeSender(path, config)
	assert.deepEqual(include('hello@eu.ridge.com', { reason: 'excluded' }), {
		address: 'hello@eu.ridge.com',
		added: false,
		unmuted: true,
	})
	assert.deepEqual(lists(path), { include: '', exclude: 'ci@builds.example' })
	assert.equal(config.signals.mail.excludeSenders, 'ci@builds.example')
})

test('`i` on a relay drops the relay’s raw exclude entry too', t => {
	const relay = 'petra_at_psyon_example_abc_0f@privaterelay.appleid.com'
	const { path, config } = fixture(t, '', relay)
	assert.deepEqual(createIncludeSender(path, config)('petra@psyon.example', { raw: relay, reason: 'excluded' }), {
		address: 'petra@psyon.example',
		added: false,
		unmuted: true,
	})
	assert.equal(lists(path).exclude, '')
})

test('`i` on mail an exclude glob still keeps out adds the include entry (include beats exclude)', t => {
	const { path, config } = fixture(t, '', '*@builds.example\nci@builds.example')
	assert.deepEqual(createIncludeSender(path, config)('ci@builds.example', { reason: 'excluded' }), {
		address: 'ci@builds.example',
		added: true,
		unmuted: true,
	})
	assert.deepEqual(lists(path), { include: 'ci@builds.example', exclude: '*@builds.example' })
})

test('`i` on bulk mail always shows the sender and drops a stale exact exclude entry', t => {
	const { path, config } = fixture(t, '', 'news@contember.example')
	assert.deepEqual(createIncludeSender(path, config)('news@contember.example', { reason: 'newsletter' }), {
		address: 'news@contember.example',
		added: true,
		unmuted: true,
	})
	assert.deepEqual(lists(path), { include: 'news@contember.example', exclude: '' })
})

test('mute then `i` on the same sender never leave it on both lists', t => {
	const { path, config } = fixture(t, 'hello@eu.ridge.com', '')
	createMuteSender(path, config)('hello@eu.ridge.com')
	assert.deepEqual(lists(path), { include: '', exclude: 'hello@eu.ridge.com' })
	createIncludeSender(path, config)('hello@eu.ridge.com', { reason: 'newsletter' })
	assert.deepEqual(lists(path), { include: 'hello@eu.ridge.com', exclude: '' })
	createMuteSender(path, config)('hello@eu.ridge.com')
	assert.deepEqual(lists(path), { include: '', exclude: 'hello@eu.ridge.com' })
})
