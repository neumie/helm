// Writes the measured-contrast table (docs/design-system.md §2.9) from app/src/design/contrast-pairs.ts,
// only between its markers. Run from the repository root: `node --import tsx app/scripts/contrast-table.ts`
// (`--check` exits 1 instead of writing when the table is stale). tests/design-contrast.test.ts checks
// the table is fresh.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spliceContrastTable } from '../src/design/contrast-pairs.ts'

const SPEC = fileURLToPath(new URL('../../docs/design-system.md', import.meta.url))

const current = readFileSync(SPEC, 'utf8')
const next = spliceContrastTable(current)
if (next === current) {
	console.log('docs/design-system.md contrast table is up to date')
} else if (process.argv.includes('--check')) {
	console.error('docs/design-system.md contrast table is stale: run node --import tsx app/scripts/contrast-table.ts')
	process.exit(1)
} else {
	writeFileSync(SPEC, next)
	console.log('docs/design-system.md contrast table written')
}
