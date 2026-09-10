import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { promisify } from 'node:util'

for (const mode of ['count', 'bytes', 'oversize', 'truncated']) {
	test(
		`private controlRequest handles ${mode} device responses in an isolated child`,
		{ timeout: 20_000 },
		async () => {
			const result = await promisify(execFile)(
				process.execPath,
				['--import', 'tsx', 'tests/fixtures/remote-control-capacity.ts', mode],
				{ timeout: 15_000 },
			)
			assert.match(result.stdout, /handled control proof completed/)
			assert.equal(result.stderr, '')
		},
	)
}
