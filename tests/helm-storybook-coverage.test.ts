import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const storyCoverage = [
	['app/src/renderer/sidebar/Button.stories.tsx', 'Primitives/Button'],
	['app/src/renderer/sidebar/Segmented.stories.tsx', 'Primitives/Segmented control'],
	['app/src/renderer/sidebar/ListRow.stories.tsx', 'Compositions/List row'],
	['app/src/renderer/sidebar/ChipAndDot.stories.tsx', 'Primitives/Chip and dot'],
	['app/src/renderer/Toast.stories.tsx', 'Compositions/Toast'],
	['app/src/renderer/sidebar/Field.stories.tsx', 'Primitives/Field'],
	['app/src/renderer/sidebar/Menus.stories.tsx', 'Compositions/Menu and navigation'],
	['app/src/renderer/sidebar/Banner.stories.tsx', 'Primitives/Banner'],
	['app/src/renderer/sidebar/EmptyState.stories.tsx', 'Primitives/Empty state'],
	['app/src/renderer/TerminalWorkspace.stories.tsx', 'Views/Terminal workspace'],
	['app/src/renderer/TabNumbers.stories.tsx', 'Views/Tab numbers'],
	['app/src/renderer/TopbarBackground.stories.tsx', 'Views/Topbar background terminals'],
	['app/src/renderer/sidebar/FlatGroup.stories.tsx', 'Compositions/Flat group'],
	['app/src/renderer/sidebar/Disclosure.stories.tsx', 'Compositions/Disclosure group'],
	['app/src/renderer/sidebar/ActivityIndicator.stories.tsx', 'Primitives/Activity indicator'],
	['app/src/renderer/sidebar/RunContextEditor.stories.tsx', 'Views/Run context editor'],
	['app/src/renderer/signals/SignalsColumn.stories.tsx', 'Views/Signals/Column'],
	['app/src/renderer/signals/SignalsFlows.stories.tsx', 'Views/Signals/Flows'],
	['app/src/renderer/signals/SignalsDone.stories.tsx', 'Views/Signals/Done'],
	['app/src/renderer/signals/SignalsLookToday.stories.tsx', 'Views/Signals/Sidebar look/0 Today'],
	['app/src/renderer/signals/SignalsLookCard.stories.tsx', 'Views/Signals/Sidebar look/1 Dashed card'],
	['app/src/renderer/signals/SignalsLookCalm.stories.tsx', 'Views/Signals/Sidebar look/2 Calm dots'],
	['app/src/renderer/signals/SignalsLookTerminal.stories.tsx', 'Views/Signals/Sidebar look/3 Terminal transcript'],
	['app/src/renderer/signals/SignalsLookSummary.stories.tsx', 'Views/Signals/Sidebar look/4 Folded summary'],
	['app/src/renderer/signals/SignalsLookLedger.stories.tsx', 'Views/Signals/Sidebar look/5 Ledger and legend'],
	[
		'app/src/renderer/signals/SignalsLookFolded.stories.tsx',
		'Views/Signals/Sidebar look/6 Folded summary with calm dots',
	],
	[
		'app/src/renderer/signals/SignalsLookFoldedTitle.stories.tsx',
		'Views/Signals/Sidebar look/7 Folded, counts in the title',
	],
	[
		'app/src/renderer/signals/SignalsLookFoldedNumber.stories.tsx',
		'Views/Signals/Sidebar look/8 Folded, one big number',
	],
	['app/src/renderer/signals/SignalsLookFoldedBare.stories.tsx', 'Views/Signals/Sidebar look/9 Folded, nothing on top'],
	[
		'app/src/renderer/signals/SignalsLookFoldedRule.stories.tsx',
		'Views/Signals/Sidebar look/10 Folded, sections under a rule',
	],
	[
		'app/src/renderer/signals/SignalsLookFoldedBand.stories.tsx',
		'Views/Signals/Sidebar look/11 Folded, sections on a band',
	],
	[
		'app/src/renderer/signals/SignalsLookFoldedRail.stories.tsx',
		'Views/Signals/Sidebar look/12 Folded, sections on a rail',
	],
] as const

test('Storybook discovers the whole renderer and sorts large review views first', () => {
	assert.match(read('app/.storybook/main.ts'), /stories: \['\.\.\/src\/renderer\/\*\*\/\*\.stories\.tsx'\]/)
	assert.match(read('app/.storybook/preview.ts'), /order: \['Views'/)
})

test('every design-system component family has a named Storybook home', () => {
	for (const [path, title] of storyCoverage) assert.ok(read(path).includes(`title: '${title}'`), path)
})

test('large Sidebar views cover primary review destinations', () => {
	const views = read('app/src/renderer/sidebar/SidebarViews.stories.tsx')
	for (const story of [
		'WorkList',
		'ItemDetail',
		'TaskReading',
		'PlanDocuments',
		'Settings',
		'Appearance',
		'TerminalSettings',
		'AgentIntegrations',
	]) {
		assert.ok(views.includes(`export const ${story}: Story`), story)
	}
})
