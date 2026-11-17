// A realistic shell session for the terminal frames (scroll thumb, bright black). It goes through the production
// terminal write path: the BrowserHarness story exposes the workspace fixture, whose `emitData` is the PTY output
// event the real workspace subscribes to. Bright black is SGR 90 (palette index 8): git's dim dates, `ls`
// permissions, a comment, zsh-autosuggestions' ghost text (its default `fg=8`).
import type { FrameContext } from './frame'
import { waitFor } from './frame'

const DIM = '\x1b[90m'
const RESET = '\x1b[0m'
const PROMPT = `\x1b[38;5;110m~/code/neumie/helm${RESET} \x1b[38;5;139mfeat/design-system${RESET}`

const COMMITS = [
	['f307343', 'docs(design-system): record the S2 commits in the plan progress', '2 hours ago'],
	['1a94439', 'test(design-system): read motion tokens in the activity and toast checks', '3 hours ago'],
	['b7d1927', 'docs(design-system): record S2 and open D20', '3 hours ago'],
	['eec3f56', 'refactor(design-system): put z-index and motion literals on tokens', '5 hours ago'],
	['d53dd81', 'feat(design-system): token source and generator in packages/helm-ui', '6 hours ago'],
	['0b4934b', 'feat(design-system): D5 contrast picks', '4 days ago'],
	['52e2402', 'feat(design-system): D4 and D12 picks', '4 days ago'],
	['cdc970a', 'feat(icons): Heroicons outline everywhere', '4 days ago'],
] as const

const FILES = [
	['drwxr-xr-x', '  24', '   768', 'Nov 17 09:12', '\x1b[34m.\x1b[0m'],
	['drwxr-xr-x', '  12', '   384', 'Nov 16 18:40', '\x1b[34m..\x1b[0m'],
	['-rw-r--r--', '   1', '  4210', 'Nov 17 08:02', 'AGENTS.md'],
	['drwxr-xr-x', '  18', '   576', 'Nov 17 09:10', '\x1b[34mapp\x1b[0m'],
	['drwxr-xr-x', '   9', '   288', 'Nov 16 21:15', '\x1b[34mdocs\x1b[0m'],
	['-rw-r--r--', '   1', '  1934', 'Nov 15 11:20', 'package.json'],
	['drwxr-xr-x', '   6', '   192', 'Nov 17 07:45', '\x1b[34mpackages\x1b[0m'],
	['drwxr-xr-x', '  31', '   992', 'Nov 17 09:12', '\x1b[34msrc\x1b[0m'],
	['drwxr-xr-x', '  88', '  2816', 'Nov 17 09:01', '\x1b[34mtests\x1b[0m'],
] as const

function session(): string {
	const lines: string[] = []
	// Scrollback first, so the overlay scrollbar has something to show.
	for (let round = 0; round < 5; round++) {
		lines.push(`${PROMPT}`, `\x1b[1m❯${RESET} npm run lint:design`)
		lines.push('design lint: 0 new, 0 stale (412 allowlisted)')
		for (const [file, rule] of [
			['app/src/renderer/sidebar/sidebar.css', 'raw-colour'],
			['app/src/renderer/agent-dock/agent-dock.css', 'font-size-off-scale'],
			['app/src/renderer/remote/remote.css', 'spacing-off-scale'],
		] as const)
			lines.push(`  ${file} ${DIM}${rule} (allowlisted, D16)${RESET}`)
		lines.push('')
	}
	lines.push(PROMPT, `\x1b[1m❯${RESET} git log --oneline -8 --format='%h %s %C(8)%cr'`)
	for (const [sha, subject, when] of COMMITS) lines.push(`\x1b[33m${sha}${RESET} ${subject} ${DIM}${when}${RESET}`)
	lines.push('', PROMPT, `\x1b[1m❯${RESET} ls -la`, 'total 184')
	for (const [mode, links, size, date, name] of FILES)
		lines.push(`${DIM}${mode}${RESET}${links} jakub  staff ${size} ${DIM}${date}${RESET} ${name}`)
	lines.push('', PROMPT, `\x1b[1m❯${RESET} npm test -- tests/design-contrast.test.ts`)
	lines.push(`${DIM}# tests/design-contrast.test.ts${RESET}`)
	lines.push('\x1b[32m✔\x1b[0m every row matches its stored ratio')
	lines.push('\x1b[32m✔\x1b[0m every failing pair is open or exempt')
	lines.push(`${DIM}# 2 tests, 0 failures, 412 ms${RESET}`)
	lines.push('', PROMPT)
	// The prompt ends with typed text and zsh-autosuggestions' ghost completion.
	return `${lines.join('\r\n')}\r\n\x1b[1m❯${RESET} git sta${DIM}tus --short${RESET}`
}

interface WorkspaceFixture {
	emitData(sessionId: string, data: string): void
}

/** Closes the harness's Background popover and writes the session into the active ('shell') terminal. */
export async function writeShellSession({ doc, win }: FrameContext): Promise<void> {
	const fixture = await waitFor(
		() => (win as Window & { __helmWorkspaceFixture?: WorkspaceFixture }).__helmWorkspaceFixture,
		'workspace fixture',
	)
	await waitFor(() => doc.querySelector('.term-holder.active .xterm-rows'), 'terminal rows')
	const toggle = doc.querySelector<HTMLButtonElement>('#bg-toggle')
	if (toggle?.getAttribute('aria-expanded') === 'true') toggle.click()
	fixture.emitData('shell', session())
	await waitFor(
		() => doc.querySelector('.term-holder.active .xterm-rows')?.textContent?.includes('tus --short'),
		'output',
	)
}
