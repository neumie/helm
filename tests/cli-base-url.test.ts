// CLI daemon base URL precedence (src/cli/helm.ts resolveBaseUrl):
// --url > $HELM_URL > $VIGIL_URL (legacy compat) > http://localhost:7474.
// helm.ts dispatches on process.argv at import time, so the import shim pins
// argv to the harmless `help` command and swallows its console output.

import assert from 'node:assert/strict'
import test from 'node:test'

type HelmCliModule = typeof import('../src/cli/helm.js')

async function importHelmCli(): Promise<HelmCliModule> {
	const savedArgv = process.argv
	const savedLog = console.log
	process.argv = [savedArgv[0] ?? 'node', savedArgv[1] ?? 'helm', 'help']
	console.log = () => undefined
	try {
		return await import('../src/cli/helm.js')
	} finally {
		process.argv = savedArgv
		console.log = savedLog
	}
}

const URL_ENV_KEYS = ['HELM_URL', 'VIGIL_URL'] as const

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key]
	else process.env[key] = value
}

/** Run `fn` with HELM_URL/VIGIL_URL forced to the given values (undefined = unset), restoring env in finally. */
async function withUrlEnv(
	env: Partial<Record<(typeof URL_ENV_KEYS)[number], string>>,
	fn: () => void | Promise<void>,
): Promise<void> {
	const savedEnv: Record<string, string | undefined> = {}
	for (const key of URL_ENV_KEYS) savedEnv[key] = process.env[key]
	try {
		for (const key of URL_ENV_KEYS) setEnv(key, env[key])
		await fn()
	} finally {
		for (const key of URL_ENV_KEYS) setEnv(key, savedEnv[key])
	}
}

test('resolveBaseUrl precedence: --url > HELM_URL > VIGIL_URL > default', async () => {
	const { resolveBaseUrl } = await importHelmCli()

	await withUrlEnv({ HELM_URL: 'http://helm-env:1111', VIGIL_URL: 'http://vigil-env:2222' }, () => {
		assert.equal(resolveBaseUrl(['--url', 'http://cli:3333']), 'http://cli:3333')
		assert.equal(resolveBaseUrl([]), 'http://helm-env:1111')
	})

	await withUrlEnv({ VIGIL_URL: 'http://vigil-env:2222' }, () => {
		assert.equal(resolveBaseUrl([]), 'http://vigil-env:2222')
	})

	await withUrlEnv({}, () => {
		assert.equal(resolveBaseUrl([]), 'http://localhost:7474')
	})
})

test('resolveBaseUrl strips trailing slashes from every source', async () => {
	const { resolveBaseUrl } = await importHelmCli()

	await withUrlEnv({}, () => {
		assert.equal(resolveBaseUrl(['--url', 'http://cli:3333///']), 'http://cli:3333')
	})

	await withUrlEnv({ HELM_URL: 'http://helm-env:1111/' }, () => {
		assert.equal(resolveBaseUrl([]), 'http://helm-env:1111')
	})
})
