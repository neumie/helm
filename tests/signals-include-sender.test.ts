import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema, loadConfig, readConfigFile, writeConfigFile } from '../src/config.js'
import { IncludeSenderError, createIncludeSender } from '../src/signals/include-sender.js'

function fixture(t: test.TestContext, includeSenders?: string) {
	const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'helm-include-')))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	const path = join(root, 'helm.config.json')
	const raw = {
		provider: { type: 'contember', apiBaseUrl: 'https://example.test', projectSlug: 'p', apiToken: 'test-secret' },
		projects: [{ slug: 'p', repoPath: root }],
		signals: { mail: { enabled: true, ...(includeSenders === undefined ? {} : { includeSenders }) } },
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
