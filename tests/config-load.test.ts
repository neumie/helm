import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfig } from '../src/config.js'

test('loadConfig reports malformed JSON with the config path', () => {
	const dir = mkdtempSync(join(tmpdir(), 'helm-config-load-'))
	const path = join(dir, 'helm.config.json')
	writeFileSync(path, '{ invalid json')
	try {
		assert.throws(
			() => loadConfig(path),
			error => {
				assert.ok(error instanceof Error)
				assert.match(error.message, /Invalid JSON in Helm config/)
				assert.match(error.message, /helm\.config\.json/)
				return true
			},
		)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
