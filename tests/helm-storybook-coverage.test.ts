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
	['app/src/renderer/sidebar/FlatGroup.stories.tsx', 'Compositions/Flat group'],
	['app/src/renderer/sidebar/Disclosure.stories.tsx', 'Compositions/Disclosure group'],
	['app/src/renderer/sidebar/ActivityIndicator.stories.tsx', 'Primitives/Activity indicator'],
	['app/src/renderer/sidebar/RunContextEditor.stories.tsx', 'Views/Run context editor'],
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
