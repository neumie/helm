// Token-only design lint (docs/design-system.md §10; plan stage S3). Run from the repository root:
//
//   node --import tsx app/scripts/design-lint.ts                  new violations and stale baseline entries
//   node --import tsx app/scripts/design-lint.ts --all            every finding, allowlisted or not
//   node --import tsx app/scripts/design-lint.ts --write-baseline regenerate app/src/design/lint-allowlist.ts
//                                                                 (drops stale entries; refuses new ones)
//   node --import tsx app/scripts/design-lint.ts --write-baseline --allow-new
//                                                                 also list new findings, each with a
//                                                                 `TODO:` reason the baseline test rejects
//
// Findings print grouped by rule. Without a flag it exits 1 when a finding is not in the baseline or a
// baseline entry no longer matches (the same check as tests/design-lint.test.ts). `--write-baseline` keeps
// the reason of every entry that still matches and drops entries whose value was fixed. It refuses to add a
// new finding unless `--allow-new` is given; a new entry then gets `TODO: ` plus its rule's default reason
// (`defaultReason` in app/src/design/lint.ts), which tests/design-lint.test.ts rejects until a person writes
// the real reason. The per-rule caps in tests/design-lint.test.ts only go down: growing the baseline means
// editing them, in review.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DESIGN_LINT_ALLOWLIST } from '../src/design/lint-allowlist.ts'
import { RULES, compareBaseline, formatBaseline, nextBaseline, scanRepository } from '../src/design/lint.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ALLOWLIST_FILE = fileURLToPath(new URL('../src/design/lint-allowlist.ts', import.meta.url))

type Row = { rule: string; file: string; selector: string; property: string; value: string; line?: number }

const printGrouped = (title: string, rows: readonly Row[]) => {
	if (!rows.length) return
	console.log(`\n${title}`)
	for (const rule of RULES) {
		const ofRule = rows.filter(r => r.rule === rule)
		if (!ofRule.length) continue
		console.log(`\n  ${rule} (${ofRule.length})`)
		for (const r of ofRule) {
			const at = r.line === undefined ? r.file : `${r.file}:${r.line}`
			console.log(`    ${at}  ${r.selector}  { ${r.property}: ${r.value} }`)
		}
	}
}

const findings = scanRepository(ROOT)
const args = new Set(process.argv.slice(2))

if (args.has('--write-baseline')) {
	const { unlisted: added } = compareBaseline(findings, DESIGN_LINT_ALLOWLIST)
	if (added.length && !args.has('--allow-new')) {
		printGrouped('New violations (not written: fix them, or rerun with --allow-new and write each reason)', added)
		console.log(
			`\n--write-baseline refused: ${added.length} new finding(s); the baseline only shrinks without --allow-new`,
		)
		process.exit(1)
	}
	const entries = nextBaseline(findings, DESIGN_LINT_ALLOWLIST)
	const body = formatBaseline(entries)
	writeFileSync(
		ALLOWLIST_FILE,
		`// Design lint baseline: every finding of app/src/design/lint.ts that is allowed to stay, with the decision
// (docs/plans/design-system/spec.md D<n>), ruling (docs/design-system.md §9 ruling N) or plan stage (S<n>) that
// keeps it. tests/design-lint.test.ts fails on a finding missing here, on an entry with no finding left (the
// value was fixed: remove it), on a \`TODO:\` reason and on a rule count above its cap. Regenerate with
// \`node --import tsx app/scripts/design-lint.ts --write-baseline\`, which keeps the reasons below for entries
// that still match and refuses new entries unless \`--allow-new\` is given; edit reasons by hand. Never add an
// entry to let new code through: use a token, or get a ruling first.
//
// Format, under \`## <rule>\` and \`### <file>\` headers: <selector> | <property> | <value> | <reason>
import { type AllowlistEntry, parseBaseline } from './lint'

export const DESIGN_LINT_BASELINE = String.raw\`
${body}
\`

export const DESIGN_LINT_ALLOWLIST: readonly AllowlistEntry[] = parseBaseline(DESIGN_LINT_BASELINE)
`,
	)
	const counts = RULES.map(rule => `${rule} ${entries.filter(e => e.rule === rule).length}`).join(', ')
	console.log(`app/src/design/lint-allowlist.ts written: ${entries.length} entries (${counts})`)
	if (added.length) console.log(`${added.length} new entries carry a TODO: reason; write each one before committing`)
	process.exit(0)
}

if (args.has('--all')) printGrouped('All findings', findings)

const { unlisted, stale } = compareBaseline(findings, DESIGN_LINT_ALLOWLIST)
printGrouped('New violations (use a token or a scale value; a ruling first if the value must stay)', unlisted)
printGrouped('Stale baseline entries (the value was fixed: remove them, or run --write-baseline)', stale)
const counts = RULES.map(rule => `${rule} ${findings.filter(f => f.rule === rule).length}`).join(', ')
console.log(`\ndesign lint: ${findings.length} findings (${counts}); ${unlisted.length} new, ${stale.length} stale`)
process.exit(unlisted.length || stale.length ? 1 : 0)
