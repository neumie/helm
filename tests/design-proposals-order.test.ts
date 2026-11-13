// Storybook sorts sidebar groups by text, so `D10` lands before `D4`. The preview's storySort lists every
// Proposals/ group in numeric D order; this test keeps that list complete and ordered.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
const proposalsDir = join(root, 'app/src/renderer/proposals')
const previewPath = join(root, 'app/.storybook/preview.ts')

function proposalGroups(): Set<string> {
	const groups = new Set<string>()
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) walk(path)
			else if (entry.name.endsWith('.stories.tsx')) {
				for (const match of readFileSync(path, 'utf8').matchAll(/title:\s*'Proposals\/([^/']+)/g)) {
					groups.add(match[1] as string)
				}
			}
		}
	}
	walk(proposalsDir)
	return groups
}

function previewProposalOrder(): string[] {
	const source = readFileSync(previewPath, 'utf8')
	const block = source.match(/'Proposals',[^[]*\[([^\]]*)\]/)
	assert.ok(block, "preview.ts storySort must follow 'Proposals' with its group order array")
	return [...(block[1] as string).matchAll(/'([^']+)'/g)].map(match => match[1] as string)
}

const decisionNumber = (group: string): number => {
	const match = group.match(/^D(\d+)\b/)
	assert.ok(match, `Proposals group "${group}" must start with D<n>`)
	return Number(match[1])
}

test('every Proposals/ group is listed in the Storybook sort order', () => {
	const order = previewProposalOrder()
	const groups = proposalGroups()
	assert.ok(groups.size > 0, 'found no Proposals/ stories')
	assert.deepEqual([...groups].filter(group => !order.includes(group)).sort(), [], 'missing from preview.ts storySort')
	assert.deepEqual(
		order.filter(group => !groups.has(group)),
		[],
		'listed in preview.ts storySort but no story has that title',
	)
})

test('Proposals/ groups sort by decision number', () => {
	const numbers = previewProposalOrder().map(decisionNumber)
	assert.deepEqual(
		numbers,
		[...numbers].sort((a, b) => a - b),
	)
})
