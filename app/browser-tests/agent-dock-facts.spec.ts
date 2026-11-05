import { type Page, expect, test } from '@playwright/test'

// Jakub's report ("tohle je křivý"): the turn pane's PR links sat 1.3px right of the message text
// above them. The facts row starts on the message's text column — the ● gutter's 2ch at the dock's
// 12px, the same column Reply's text starts on after its > — with even gaps between its facts.

const story = (id: string) => `/iframe.html?id=compositions-agent-dock--${id}&viewMode=story`

interface Geometry {
	messageText: number
	reply: number
	facts: Array<{ left: number; right: number; fontSize: string; lineHeight: string }>
	gapAbove: number
	gapBelow: number
}

async function geometry(page: Page, id: string): Promise<Geometry> {
	await page.setViewportSize({ width: 1280, height: 800 })
	await page.goto(story(id))
	await expect(page.locator('.agent-dock-pane .agent-dock-facts')).toBeVisible()
	return page.evaluate(() => {
		const pane = document.querySelector('.agent-dock-pane')
		const block = pane?.querySelector('.agent-dock-message')
		const message = block?.querySelector(':scope > :not(.agent-dock-message-mark)')
		const row = pane?.querySelector('.agent-dock-facts')
		const prompt = pane?.querySelector('.agent-dock-prompt')
		const reply = prompt?.querySelector('textarea')
		if (!block || !message || !row || !prompt || !reply) throw new Error('Missing turn pane parts')
		const facts = [...row.children].map(fact => {
			const rect = fact.getBoundingClientRect()
			const style = getComputedStyle(fact)
			return { left: rect.left, right: rect.right, fontSize: style.fontSize, lineHeight: style.lineHeight }
		})
		const rowRect = row.getBoundingClientRect()
		return {
			messageText: message.getBoundingClientRect().left,
			reply: reply.getBoundingClientRect().left,
			facts,
			gapAbove: rowRect.top - block.getBoundingClientRect().bottom,
			gapBelow: prompt.getBoundingClientRect().top - rowRect.bottom,
		}
	})
}

test('the PR links start on the message text column, evenly spaced, on the pane rhythm', async ({ page }) => {
	const at = await geometry(page, 'turn-pr-links')
	expect(at.facts).toHaveLength(4)
	expect(Math.abs(at.facts[0].left - at.messageText)).toBeLessThanOrEqual(0.5)
	expect(Math.abs(at.reply - at.messageText)).toBeLessThanOrEqual(0.5)
	const gaps = at.facts.slice(1).map((fact, index) => fact.left - at.facts[index].right)
	for (const gap of gaps) expect(Math.abs(gap - 16)).toBeLessThanOrEqual(0.5)
	for (const fact of at.facts) expect([fact.fontSize, fact.lineHeight]).toEqual(['13px', '20px'])
	expect(at.gapAbove).toBeCloseTo(8, 0)
	expect(at.gapBelow).toBeCloseTo(8, 0)
	await expect(page.locator('.agent-dock-pane .agent-dock-facts')).toHaveText(/^PR #166\s*PR #164\s*PR #159\s*PR #136$/)
})

test('a note in the facts row starts on the same column', async ({ page }) => {
	const at = await geometry(page, 'background-shell-turn')
	const note = at.facts.at(-1)
	expect(note).toBeDefined()
	expect(Math.abs(at.facts[0].left - at.messageText)).toBeLessThanOrEqual(0.5)
	expect([note?.fontSize, note?.lineHeight]).toEqual(['13px', '20px'])
})
