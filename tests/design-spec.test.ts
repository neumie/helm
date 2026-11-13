// The design spec (docs/design-system.md) stays navigable: every section
// reference resolves, every ruling citation exists, the rulings and
// enforcement tables name real checks, every Storybook title the spec names
// exists, and the index lists every story root. Fix the spec or the
// reference, never this test, when it fails.
// The section sign is escaped in this file so it cites no section itself.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SPEC_PATH = 'docs/design-system.md'
const PLAN_PATH = 'docs/plans/design-system/spec.md'
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const spec = read(SPEC_PATH)
const plan = read(PLAN_PATH)
const agents = read('AGENTS.md')

const SCAN_ROOTS = [
	'AGENTS.md',
	'docs',
	'app/src',
	'app/browser-tests',
	'app/.storybook',
	'app/scripts',
	'extension',
	'packages',
	'scripts',
	'src',
	'tests',
]
const SKIP_DIRS = new Set(['node_modules', 'dist', 'storybook-static', '.git'])
const TEXT_FILE = /\.(md|ts|tsx|js|mjs|cjs|css|html)$/

// Files whose section numbers and rulings belong to another document.
const EXCLUDED_FILES = new Map([
	['docs/plans/design-system/research/tally.md', "quotes Tally's DESIGN.md sections and rulings, not this spec"],
])

// Single references to another document's sections, matched by their text.
const OTHER_DOCUMENT_REFERENCES = [
	{
		file: 'docs/plans/design-system/research/critic.md',
		text: 'infra \u00a71.1',
		reason: 'section 1.1 of the infra research note',
	},
]

// A third numeric level (3.24.9) never resolves: the spec numbers two levels.
const SECTION_REF = /\u00a7\s?(\d+(?:\.\d+)*)/g
const RULING_REF = /\brulings? (\d+)(?:\s*[–-]\s*(\d+))?/gi

/** A symlink to a regular file counts as a file; directory links are not followed. */
function isFileLink(full: string) {
	try {
		return statSync(full).isFile()
	} catch {
		return false
	}
}

function walk(path: string, out: string[]) {
	const full = join(ROOT, path)
	if (!existsSync(full)) return
	if (TEXT_FILE.test(path)) {
		out.push(path)
		return
	}
	let entries: import('node:fs').Dirent[]
	try {
		entries = readdirSync(full, { withFileTypes: true })
	} catch {
		return
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry.name)) continue
		if (entry.isDirectory()) {
			walk(join(path, entry.name), out)
		} else if (TEXT_FILE.test(entry.name) && (entry.isFile() || isFileLink(join(full, entry.name)))) {
			out.push(relative(ROOT, join(full, entry.name)))
		}
	}
}

const scanned: { path: string; text: string }[] = []
{
	const paths: string[] = []
	for (const root of SCAN_ROOTS) walk(root, paths)
	for (const path of paths) if (!EXCLUDED_FILES.has(path)) scanned.push({ path, text: read(path) })
}

const headings = new Set([...spec.matchAll(/^#{2,4}\s+(\d+(?:\.\d+)?)\.?\s/gm)].map(match => match[1]))

/** The text of one `## ` section of the spec, by its heading prefix. */
function section(prefix: string) {
	const start = spec.indexOf(`\n${prefix}`)
	assert.notEqual(start, -1, `spec has a section ${prefix}`)
	const end = spec.indexOf('\n## ', start + 1)
	return spec.slice(start, end === -1 ? undefined : end)
}

/** Body rows of the first Markdown table in a section, as trimmed cells. */
function tableRows(text: string) {
	return text
		.split('\n')
		.filter(line => line.startsWith('| ') && !/^\|\s*-/.test(line))
		.slice(1)
		.map(line =>
			line
				.slice(1, line.endsWith('|') ? -1 : undefined)
				.split('|')
				.map(cell => cell.trim()),
		)
}

test('every section reference resolves to a heading of the design spec', () => {
	const unresolved: string[] = []
	const usedOtherReferences = new Set<string>()
	for (const { path, text } of scanned) {
		const lines = text.split('\n')
		lines.forEach((line, index) => {
			const foreign: [number, number][] = []
			for (const entry of OTHER_DOCUMENT_REFERENCES) {
				if (entry.file !== path) continue
				for (let at = line.indexOf(entry.text); at !== -1; at = line.indexOf(entry.text, at + 1)) {
					foreign.push([at, at + entry.text.length])
					usedOtherReferences.add(entry.text)
				}
			}
			for (const match of line.matchAll(SECTION_REF)) {
				const at = match.index ?? 0
				if (foreign.some(([from, to]) => at >= from && at < to)) continue
				if (!headings.has(match[1])) unresolved.push(`${path}:${index + 1} \u00a7${match[1]}`)
			}
		})
	}
	assert.deepEqual(unresolved, [], 'section references with no heading in docs/design-system.md')
	for (const entry of OTHER_DOCUMENT_REFERENCES)
		assert.ok(usedOtherReferences.has(entry.text), `stale allowlist entry (${entry.reason}): ${entry.file}`)
	for (const [path, reason] of EXCLUDED_FILES)
		assert.ok(existsSync(join(ROOT, path)), `stale exclusion (${reason}): ${path}`)
})

const rulingRows = tableRows(section('## 9. Rulings'))
const rulingNumbers = new Set(rulingRows.map(row => Number(row[0])))

test('the rulings table numbers its rows 1..n with every cell filled', () => {
	assert.ok(rulingRows.length > 0, 'rulings table has rows')
	rulingRows.forEach((row, index) => {
		assert.equal(row.length, 6, `ruling row ${index + 1} has 6 cells: ${row.join(' | ')}`)
		assert.equal(row[0], String(index + 1), `ruling rows are numbered in order (row ${index + 1})`)
		for (const cell of row) assert.ok(cell.length > 0, `ruling ${row[0]} has an empty cell`)
	})
})

test('every ruling citation names an existing ruling', () => {
	const missing: string[] = []
	for (const { path, text } of scanned) {
		for (const match of text.matchAll(RULING_REF)) {
			const from = Number(match[1])
			const to = match[2] ? Number(match[2]) : from
			for (let n = from; n <= to; n++) if (!rulingNumbers.has(n)) missing.push(`${path}: ruling ${n}`)
		}
	}
	assert.deepEqual(missing, [])
})

const TEST_PATH = /^(?:tests|app\/browser-tests)\/.+\.(?:test|spec)\.tsx?$/

/** Problems with the check references in one cell: test files that exist, `pending S<n>` for a planned stage, `D<n>` for an open decision. */
function checkProblems(cell: string): string[] {
	const problems: string[] = []
	for (const [, path] of cell.matchAll(/`([^`]+)`/g)) {
		if (!TEST_PATH.test(path)) problems.push(`not a test file: ${path}`)
		else if (!existsSync(join(ROOT, path))) problems.push(`missing test ${path}`)
	}
	for (const [, stage] of cell.matchAll(/\bpending S(\d+)\b/g))
		if (!plan.includes(`**S${stage} `)) problems.push(`no stage S${stage} in the plan`)
	for (const [, decision] of cell.matchAll(/\bD(\d+)\b/g))
		if (!plan.includes(`**D${decision} `)) problems.push(`no open decision D${decision} in the plan`)
	for (const token of checkTokens(cell))
		if (!/^`[^`]+`$/.test(token) && !/^pending S\d+$/.test(token) && !/^D\d+$/.test(token))
			problems.push(`not a test, pending stage or decision: ${token}`)
	return problems
}

const checkTokens = (cell: string) =>
	cell
		.replace(/\([^)]*\)/g, '')
		.split(/[;,]/)
		.map(token => token.trim())
		.filter(Boolean)

test('every ruling is held by a real test, a planned stage or an open decision', () => {
	const problems: string[] = []
	for (const row of rulingRows) {
		for (const problem of checkProblems(row[5])) problems.push(`ruling ${row[0]}: ${problem}`)
	}
	assert.deepEqual(problems, [])
})

test('the enforcement map names existing checks for enforced rules', () => {
	const rows = tableRows(section('## 10. Enforcement map'))
	assert.ok(rows.length > 0, 'enforcement map has rows')
	const problems: string[] = []
	for (const row of rows) {
		assert.equal(row.length, 4, `enforcement row has 4 cells: ${row.join(' | ')}`)
		const [family, , check, status] = row
		const rest = status.replace(/^enforced/, '')
		for (const problem of checkProblems(rest)) problems.push(`${family}: ${problem}`)
		if (status.startsWith('enforced')) {
			const tests = [...check.matchAll(/`([^`]+)`/g)].map(match => match[1])
			if (!tests.some(path => TEST_PATH.test(path))) problems.push(`${family}: enforced names no test file`)
			for (const path of tests) {
				if (!TEST_PATH.test(path)) problems.push(`${family}: enforced by a non-test ${path}`)
				else if (!existsSync(join(ROOT, path))) problems.push(`${family}: enforced by a missing ${path}`)
			}
		} else {
			assert.ok(checkTokens(rest).length > 0, `${family}: status names a stage or decision`)
		}
	}
	assert.deepEqual(problems, [])
})

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

type StoryFile = { path: string; title: string[]; names: Set<string> }
const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')
const segments = (title: string) => title.split('/').map(segment => segment.trim().toLowerCase())

const storyFiles: StoryFile[] = []
{
	const paths: string[] = []
	walk('app/src/renderer', paths)
	for (const path of paths.filter(path => path.endsWith('.stories.tsx'))) {
		const text = read(path)
		const title = /\btitle:\s*['"]((?:Views|Compositions|Primitives|Proposals)\/[^'"]+)['"]/.exec(text)?.[1]
		assert.ok(title, `${path} declares a Views/Compositions/Primitives/Proposals title`)
		// A story is an exported const; its display name is the top-level `name:` of that object, never a fixture's.
		const names = new Set<string>()
		for (const chunk of text.split(/^(?=export const )/m).slice(1)) {
			const id = /^export const (\w+)/.exec(chunk)?.[1]
			if (!id) continue
			names.add(normalizeName(id))
			const end = chunk.search(/^\}/m)
			const body = end === -1 ? chunk : chunk.slice(0, end)
			const display = /^(?:\t|export const \w+[^=\n]*=\s*\{\s*)name:\s*['"`]([^'"`]+)['"`]/m.exec(body)?.[1]
			if (display) names.add(normalizeName(display))
		}
		storyFiles.push({ path, title: segments(title), names })
	}
}

/** A trailing `*` names a family of stories by prefix; a short prefix would match almost anything. */
const MIN_GLOB = 6

const sameSegments = (a: string[], b: string[]) => a.length === b.length && a.every((segment, i) => segment === b[i])

/** Why a Storybook path the spec names does not exist, or null when it does. */
function storyProblem(path: string, glob: boolean, then: string | null): string | null {
	const parts = segments(path)
	for (let size = parts.length; size > 0; size--) {
		const files = storyFiles.filter(file => sameSegments(file.title, parts.slice(0, size)))
		if (files.length === 0) continue
		const rest = parts.slice(size)
		const wanted = [...(rest.length === 1 ? rest : []), ...(then ? [then] : [])].map(normalizeName)
		if (glob && rest.length === 1 && normalizeName(rest[0]).length < MIN_GLOB)
			return `${path}: a glob needs a prefix of at least ${MIN_GLOB} letters`
		if (rest.length > 1) return `${path}: no title ${parts.slice(0, size + 1).join('/')}`
		for (const name of wanted) {
			const found = files.some(file =>
				[...file.names].some(story => story === name || (glob && rest.length === 1 && story.startsWith(name))),
			)
			if (!found) return `${path}: no story ${name} under ${parts.slice(0, size).join('/')}`
		}
		return null
	}
	const isGroup = storyFiles.some(file => sameSegments(file.title.slice(0, parts.length), parts))
	return isGroup ? null : `${path}: no Storybook title`
}

test('every Storybook title and story the spec names exists', () => {
	const problems: string[] = []
	const named = /\b(?:Views|Compositions|Primitives|Proposals)(?:\s?\/\s?[A-Za-z0-9][A-Za-z0-9 -]*)+/g
	let count = 0
	for (const match of spec.matchAll(named)) {
		const path = match[0].trim()
		const after = spec.slice((match.index ?? 0) + match[0].length)
		const glob = after.startsWith('***') || (after.startsWith('*') && !after.startsWith('**'))
		const then = /^\**\s*→\s*([A-Za-z0-9][A-Za-z0-9 -]*[A-Za-z0-9])/.exec(after)?.[1] ?? null
		const problem = storyProblem(path, glob, then)
		if (problem) problems.push(problem)
		count++
	}
	assert.ok(count > 20, 'the spec names Storybook titles')
	assert.deepEqual(problems, [])
})

test('the index lists every story root outside Proposals', () => {
	const index = section('## 0. Index')
		.replace(/\s*\/\s*/g, '/')
		.toLowerCase()
	const missing = new Set<string>()
	for (const file of storyFiles) {
		if (file.title[0] === 'proposals') continue
		const root = file.title.slice(0, 2).join('/')
		// The root must end there: `Views/Agent dock agents pane` does not list `Views/Agent dock`.
		const listed = new RegExp(`${escapeRegExp(root)}(?![a-z0-9]| [a-z0-9])`).test(index)
		if (!listed) missing.add(`${root} (${file.path})`)
	}
	assert.deepEqual([...missing], [])
})

test('every file the index names exists', () => {
	const files = scanned.map(file => file.path)
	const dirs = new Set(
		files.flatMap(path =>
			path
				.split('/')
				.slice(0, -1)
				.map((_, i, parts) => parts.slice(0, i + 1).join('/')),
		),
	)
	const missing: string[] = []
	for (const row of tableRows(section('## 0. Index'))) {
		for (const cell of [row[1], row[4]]) {
			for (const [, token] of cell.matchAll(/`([^`]+)`/g)) {
				const path = token.replace(/\/$/, '')
				if (path.includes(' ')) continue
				const found = /^(?:app|extension|src|tests|docs)\//.test(path)
					? existsSync(join(ROOT, path))
					: files.some(file => file.endsWith(`/${path}`)) || [...dirs].some(dir => dir.endsWith(`/${path}`))
				if (!found) missing.push(token)
			}
		}
	}
	assert.deepEqual(missing, [])
})

test('every ruling source is a real commit, quote, date or file', () => {
	const shas = new Set<string>()
	const problems: string[] = []
	for (const row of rulingRows) {
		const [n, , , source] = row
		if (/AGENTS\.md:\d/.test(source)) problems.push(`ruling ${n}: cite AGENTS.md by a quoted phrase, not a line number`)
		for (const [, phrase] of source.matchAll(/AGENTS\.md "([^"]+)"/g))
			if (!agents.includes(phrase)) problems.push(`ruling ${n}: AGENTS.md has no "${phrase}"`)
		for (const [, path] of source.matchAll(/`([^`]+)`/g))
			if (/^[\w./-]+\.\w+$/.test(path) && !existsSync(join(ROOT, path))) problems.push(`ruling ${n}: missing ${path}`)
		for (const [, sha] of source.matchAll(/\b([0-9a-f]{7,12}) \d{4}-\d{2}-\d{2}\b/g)) shas.add(sha)
		for (const token of source
			.replace(/\([^)]*\)/g, '')
			.split(';')
			.map(part => part.trim())) {
			const known =
				/^[0-9a-f]{7,12} \d{4}-\d{2}-\d{2}$/.test(token) ||
				/^Jakub \d{4}-\d{2}-\d{2}$/.test(token) ||
				/^AGENTS\.md "[^"]+"$/.test(token) ||
				/^`[^`]+`/.test(token)
			if (!known) problems.push(`ruling ${n}: unknown source form "${token}"`)
		}
	}
	const answer = execFileSync('git', ['cat-file', '--batch-check'], {
		cwd: ROOT,
		input: `${[...shas].join('\n')}\n`,
		encoding: 'utf8',
	})
	for (const line of answer.trim().split('\n')) if (!/ commit \d+$/.test(line)) problems.push(`not a commit: ${line}`)
	assert.deepEqual(problems, [])
})

/** The text of the `## Design system` section of AGENTS.md. */
function agentsSection() {
	const start = agents.indexOf('\n## Design system\n')
	assert.notEqual(start, -1, 'AGENTS.md has a ## Design system section')
	const end = agents.indexOf('\n## ', start + 1)
	return agents.slice(start, end === -1 ? undefined : end)
}

test('AGENTS.md names the design gate, the spec, the rulings and the proposal process', () => {
	const text = agentsSection()
	for (const phrase of [
		'npm run check:design',
		'docs/design-system.md',
		'§9',
		'Proposals/',
		'app/src/design/lint-allowlist.ts',
		'visual-diff.mjs',
	])
		assert.ok(text.includes(phrase), `AGENTS.md ## Design system names ${phrase}`)
	assert.ok(agents.indexOf('\n## Design system\n') < agents.indexOf('\n## Mandatory abstractions\n'))
})

test('the root package.json has the design scripts AGENTS.md names', () => {
	const scripts: Record<string, string> = JSON.parse(read('package.json')).scripts
	for (const name of ['check:design', 'lint:design']) assert.ok(scripts[name], `package.json has a ${name} script`)
	const missing = [...agentsSection().matchAll(/\bnpm run ([\w:-]+)/g)]
		.map(match => match[1])
		.filter(name => name !== 'test' && !scripts[name])
	assert.deepEqual(missing, [], 'npm scripts AGENTS.md ## Design system names')
})

test('every repository path AGENTS.md ## Design system names exists', () => {
	const REPO_PATH = /^(?:app|extension|src|tests|docs|scripts|packages)\/\S*$|^[A-Z][A-Z_]+\.md$/
	const paths = new Set<string>()
	for (const [, token] of agentsSection().matchAll(/`([^`]+)`/g))
		for (const word of token.split(/\s+/)) if (REPO_PATH.test(word)) paths.add(word)
	assert.ok(paths.size > 10, 'the section names repository paths')
	const missing: string[] = []
	for (const path of paths) {
		// A glob or placeholder segment (`**`, `*.ts`, `<dN-topic>`) is checked up to its parent folder.
		const parts = path.replace(/\/$/, '').split('/')
		const cut = parts.findIndex(part => /[*<>]/.test(part))
		const real = (cut === -1 ? parts : parts.slice(0, cut)).join('/')
		if (existsSync(join(ROOT, real))) continue
		// Build output named as the place it goes (gitignored) need not exist in a fresh checkout.
		// A folder pattern (`storybook-static/`) matches only what is inside it, so ask about a child too.
		const ignored = [real, `${real}/x`].some(candidate => {
			try {
				execFileSync('git', ['check-ignore', '-q', candidate], { cwd: ROOT })
				return true
			} catch {
				return false
			}
		})
		if (!ignored) missing.push(path)
	}
	assert.deepEqual(missing, [], 'paths in AGENTS.md ## Design system that do not exist')
})

// Plan notes record history (the research and the S8 stage say the guidance was removed), so they may
// name the tool. Every other doc is guidance an agent follows. A listed file that no longer names it fails.
const SYSBUDGET_PENDING = new Map([
	['docs/remote/README.md', 'Remote runbook commands, outside the design-system stages; rewrite them to run directly'],
])

test('AGENTS.md and docs carry no guidance for the retired CPU-lease tool', () => {
	const docs: string[] = []
	walk('docs', docs)
	const mentions = ['AGENTS.md', ...docs]
		.filter(path => !path.startsWith('docs/plans/'))
		.filter(path => read(path).includes('sysbudget'))
	assert.deepEqual(
		mentions.filter(path => !SYSBUDGET_PENDING.has(path)),
		[],
		'guidance that names sysbudget (deprecated and uninstalled: run builds and tests directly)',
	)
	assert.deepEqual(
		[...SYSBUDGET_PENDING.keys()].filter(path => !mentions.includes(path)),
		[],
		'files listed in SYSBUDGET_PENDING that no longer name sysbudget: remove them from the list',
	)
})

/** Stages the plan reports done: its Status line's `Done:` clause and its `- **S<n>** done` progress lines. */
function doneStages(): Set<number> {
	const done = new Set<number>()
	const status = /^Status:.*?\bDone: ([^;\n]*)/m.exec(plan)?.[1] ?? ''
	for (const [, n] of status.replace(/\([^)]*\)/g, '').matchAll(/\bS(\d+)\b/g)) done.add(Number(n))
	for (const [, n] of plan.matchAll(/^- \*\*S(\d+)\*\* done\b/gm)) done.add(Number(n))
	return done
}

test('the spec names no finished stage as the check still to come', () => {
	const done = doneStages()
	assert.ok(done.has(1) && done.has(5), 'the plan reports S1 and S5 done')
	const stale: string[] = []
	spec.split('\n').forEach((line, index) => {
		for (const [, n] of line.matchAll(/\bpending S(\d+)\b/g))
			if (done.has(Number(n))) stale.push(`${SPEC_PATH}:${index + 1}: pending S${n}`)
	})
	assert.deepEqual(stale, [], 'name the check that holds it now, or the unfinished stage that will')
})
