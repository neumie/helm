// Config file resolution order (src/config.ts resolveConfigPath): explicit arg
// > $HELM_CONFIG > $VIGIL_CONFIG (legacy) > ./helm.config.json >
// ./vigil.config.json (legacy name — warns, asking for a rename). Uses tmp
// dirs + env/cwd manipulation, restored in finally.

import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { resolveConfigPath } from '../src/config.js'

const CONFIG_ENV_KEYS = ['HELM_CONFIG', 'VIGIL_CONFIG'] as const

/**
 * Run `fn` chdir'd into a fresh tmp dir with HELM_CONFIG/VIGIL_CONFIG forced to
 * the given values (undefined = unset), restoring cwd + env afterwards. The tmp
 * dir is realpath'd because resolveConfigPath resolves against process.cwd(),
 * which macOS reports post-symlink (/var -> /private/var).
 */
function withEnvAndTmpCwd(env: Partial<Record<(typeof CONFIG_ENV_KEYS)[number], string>>, fn: (dir: string) => void) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'helm-config-')))
	const savedCwd = process.cwd()
	const savedEnv: Record<string, string | undefined> = {}
	for (const key of CONFIG_ENV_KEYS) savedEnv[key] = process.env[key]
	try {
		for (const key of CONFIG_ENV_KEYS) {
			const value = env[key]
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		process.chdir(dir)
		fn(dir)
	} finally {
		process.chdir(savedCwd)
		for (const key of CONFIG_ENV_KEYS) {
			const value = savedEnv[key]
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		rmSync(dir, { recursive: true, force: true })
	}
}

function captureWarns(fn: () => void): string[] {
	const warns: string[] = []
	const original = console.warn
	console.warn = (...args: unknown[]) => {
		warns.push(args.map(String).join(' '))
	}
	try {
		fn()
	} finally {
		console.warn = original
	}
	return warns
}

test('explicit arg beats HELM_CONFIG, VIGIL_CONFIG and cwd files', () => {
	withEnvAndTmpCwd({ HELM_CONFIG: '/env/helm.json', VIGIL_CONFIG: '/env/vigil.json' }, dir => {
		writeFileSync(join(dir, 'helm.config.json'), '{}')
		assert.equal(resolveConfigPath('/explicit/config.json'), '/explicit/config.json')
	})
})

test('HELM_CONFIG beats VIGIL_CONFIG and cwd files', () => {
	withEnvAndTmpCwd({ HELM_CONFIG: '/env/helm.json', VIGIL_CONFIG: '/env/vigil.json' }, dir => {
		writeFileSync(join(dir, 'helm.config.json'), '{}')
		assert.equal(resolveConfigPath(), '/env/helm.json')
	})
})

test('VIGIL_CONFIG (legacy) is honored when HELM_CONFIG is unset', () => {
	withEnvAndTmpCwd({ VIGIL_CONFIG: '/env/vigil.json' }, dir => {
		writeFileSync(join(dir, 'helm.config.json'), '{}')
		assert.equal(resolveConfigPath(), '/env/vigil.json')
	})
})

test('./helm.config.json beats ./vigil.config.json, no warning', () => {
	withEnvAndTmpCwd({}, dir => {
		writeFileSync(join(dir, 'helm.config.json'), '{}')
		writeFileSync(join(dir, 'vigil.config.json'), '{}')
		let path = ''
		const warns = captureWarns(() => {
			path = resolveConfigPath()
		})
		assert.equal(path, resolve(dir, 'helm.config.json'))
		assert.deepEqual(warns, [])
	})
})

test('legacy ./vigil.config.json is used as last file fallback and warns', () => {
	withEnvAndTmpCwd({}, dir => {
		writeFileSync(join(dir, 'vigil.config.json'), '{}')
		let path = ''
		const warns = captureWarns(() => {
			path = resolveConfigPath()
		})
		assert.equal(path, resolve(dir, 'vigil.config.json'))
		assert.equal(warns.length, 1)
		assert.match(warns[0] ?? '', /legacy config/)
		assert.match(warns[0] ?? '', /rename it to helm\.config\.json/)
	})
})

test('nothing set and no files -> defaults to ./helm.config.json', () => {
	withEnvAndTmpCwd({}, dir => {
		const warns = captureWarns(() => {
			assert.equal(resolveConfigPath(), resolve(dir, 'helm.config.json'))
		})
		assert.deepEqual(warns, [])
	})
})
