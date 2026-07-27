import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import { scheduledAgentSchema } from '../src/scheduled-runs/schema.js'
import { MODEL_CATALOG, defaultHelperModel } from '../src/solver/models.js'
import { runOneShot } from '../src/solver/one-shot.js'

test('Pi is accepted by canonical config and scheduled-run schemas', () => {
	const config = configSchema.parse({
		provider: {
			type: 'contember',
			apiBaseUrl: 'https://example.test',
			projectSlug: 'helm',
			apiToken: 'token',
		},
		projects: [{ slug: 'helm', repoPath: '/repo', baseBranch: 'main' }],
		solver: { agent: 'pi' },
	})
	assert.equal(config.solver.agent, 'pi')
	assert.equal(scheduledAgentSchema.parse('pi'), 'pi')
	assert.equal(defaultHelperModel('pi'), 'anthropic/claude-haiku-4-5')
	assert.ok(MODEL_CATALOG.pi.some(model => model.id === 'openai-codex/gpt-5.6-luna'))
})

test('Pi helper one-shot disables tools, project trust, and resource discovery', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'helm-pi-agent-'))
	const executable = join(dir, 'pi')
	const argsPath = join(dir, 'args.txt')
	const stdinPath = join(dir, 'stdin.txt')
	writeFileSync(
		executable,
		`#!/bin/sh\nprintf '%s\\n' "$@" > "$HELM_PI_ARGS"\ncat > "$HELM_PI_STDIN"\nprintf 'pi-result\\n'\n`,
	)
	chmodSync(executable, 0o755)
	const previousPath = process.env.PATH
	const previousArgs = process.env.HELM_PI_ARGS
	const previousStdin = process.env.HELM_PI_STDIN
	process.env.PATH = `${dir}:${previousPath ?? ''}`
	process.env.HELM_PI_ARGS = argsPath
	process.env.HELM_PI_STDIN = stdinPath
	try {
		assert.equal(
			await runOneShot({
				agent: 'pi',
				model: 'openai-codex/gpt-5.6-luna',
				prompt: 'name this branch',
			}),
			'pi-result',
		)
		assert.deepEqual(readFileSync(argsPath, 'utf8').trim().split('\n'), [
			'-p',
			'--no-session',
			'--no-approve',
			'--no-tools',
			'--no-extensions',
			'--no-skills',
			'--no-prompt-templates',
			'--no-themes',
			'--no-context-files',
			'--model',
			'openai-codex/gpt-5.6-luna',
		])
		assert.equal(readFileSync(stdinPath, 'utf8'), 'name this branch')
	} finally {
		process.env.PATH = previousPath
		if (previousArgs === undefined) Reflect.deleteProperty(process.env, 'HELM_PI_ARGS')
		else process.env.HELM_PI_ARGS = previousArgs
		if (previousStdin === undefined) Reflect.deleteProperty(process.env, 'HELM_PI_STDIN')
		else process.env.HELM_PI_STDIN = previousStdin
		rmSync(dir, { recursive: true, force: true })
	}
})
