#!/usr/bin/env node
// The design-system gate: `npm run check:design` (AGENTS.md § Design system). Runs every design check in order
// from the repository root, prints each step's result and exits non-zero on the first failure. Run it before any
// UI handoff; the node tests in it also run inside `npm test`.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const designTests = readdirSync(new URL('../../tests', import.meta.url))
	.filter(name => /^design-.+\.test\.ts$/.test(name))
	.sort()
	.map(name => `tests/${name}`)

const steps = [
	{
		name: 'contrast table is fresh',
		command: ['node', '--import', 'tsx', 'app/scripts/contrast-table.ts', '--check'],
	},
	// Reserved for S2: the generated token files are fresh.
	// { name: 'tokens are fresh', command: ['node', '--import', 'tsx', 'app/scripts/tokens.ts', '--check'] },
	{
		name: 'design tests',
		command: ['node', '--import', 'tsx', '--test', ...designTests, 'tests/helm-storybook-coverage.test.ts'],
	},
	// Reserved for S6: accessibility checks over every story.
	// { name: 'accessibility', command: [...] },
	{ name: 'biome', command: ['npx', 'biome', 'check', '.'] },
]

for (const [index, step] of steps.entries()) {
	const label = `[${index + 1}/${steps.length}] ${step.name}`
	console.log(`\n${label}: ${step.command.join(' ')}`)
	const started = Date.now()
	const result = spawnSync(step.command[0], step.command.slice(1), { cwd: ROOT, stdio: 'inherit' })
	const seconds = ((Date.now() - started) / 1000).toFixed(1)
	if (result.error || result.status !== 0) {
		const why = result.error ? result.error.message : `exit ${result.status ?? result.signal}`
		console.error(`\n${label}: FAILED (${why}, ${seconds}s)`)
		process.exit(1)
	}
	console.log(`${label}: ok (${seconds}s)`)
}
console.log('\ncheck:design passed')
