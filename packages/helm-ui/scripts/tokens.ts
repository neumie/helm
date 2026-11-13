// Writes every generated copy of the design tokens (docs/design-system.md §2.8, §9 rulings 104 and 106):
//
//   npm run tokens:write                                   write every target that changed
//   node --import tsx packages/helm-ui/scripts/tokens.ts --check   exit 1 and list the stale targets
//
// Change a value in packages/helm-ui/tokens/, run `npm run tokens:write`, commit the source and the outputs together.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGETS } from '../tokens/generate.ts'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const check = process.argv.includes('--check')
const stale: string[] = []
for (const target of TARGETS) {
	const path = join(ROOT, target.file)
	const current = existsSync(path) ? readFileSync(path, 'utf8') : null
	const next = target.render(current)
	if (next === current) continue
	stale.push(target.file)
	if (!check) writeFileSync(path, next)
}
if (check && stale.length > 0) {
	console.error(`Stale generated token files (run \`npm run tokens:write\`):\n${stale.map(f => `  ${f}`).join('\n')}`)
	process.exit(1)
}
console.log(
	check
		? `tokens: ${TARGETS.length} generated files fresh`
		: `tokens: ${stale.length} of ${TARGETS.length} files written${stale.length ? `\n${stale.map(f => `  ${f}`).join('\n')}` : ''}`,
)
