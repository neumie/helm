import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Page, expect, test } from '@playwright/test'
import { openRemoteDestination } from './remote-navigation.js'

const STORY = '/iframe.html?id=views-helm-remote--usage&viewMode=story'
const GLOBAL_CSS = readFileSync(resolve('src/renderer/styles.css'), 'utf8')
const REMOTE_CSS = readFileSync(resolve('src/renderer/remote/remote.css'), 'utf8')
const SIZES = [
	{ name: 'phone', width: 390, height: 844 },
	{ name: 'desktop', width: 1280, height: 844 },
] as const

type Destination = 'list' | 'conversation' | 'usage'

async function show(page: Page, destination: Destination) {
	if (destination === 'usage') {
		await openRemoteDestination(page, 'Usage')
		await expect(page.getByRole('region', { name: 'Usage' })).toBeVisible()
		return
	}
	if (destination === 'conversation') {
		await page.getByRole('button', { name: /Helm conversation/ }).click()
		await expect(page.locator('.remote-conversation')).toBeVisible()
	}
}

for (const size of SIZES) {
	for (const destination of ['list', 'conversation', 'usage'] as const) {
		test(`the top-left menu is reachable from ${destination} at ${size.name}`, async ({ page }) => {
			await page.setViewportSize({ width: size.width, height: size.height })
			await page.goto(STORY)
			await show(page, destination)

			const trigger = page.getByRole('button', { name: 'Open navigation', exact: true })
			await expect(trigger).toBeVisible()
			const triggerBox = await trigger.boundingBox()
			// Chromium can serialize a 44px transformed target a few millionths under 44.
			expect(triggerBox?.width).toBeGreaterThanOrEqual(43.99)
			expect(triggerBox?.height).toBeGreaterThanOrEqual(43.99)
			await trigger.click()

			const menu = page.getByRole('dialog', { name: 'Navigation' })
			await expect(menu).toBeVisible()
			await expect(menu).toHaveCSS('animation-name', 'remote-navigation-in')
			await expect(menu).toHaveCSS('animation-duration', '0.18s')
			await expect(page.locator('.remote-navigation-dismiss')).toHaveCSS('animation-name', 'remote-scrim-in')
			await expect(menu.getByRole('button', { name: 'Sessions', exact: true })).toBeVisible()
			await expect(menu.getByRole('button', { name: 'Usage', exact: true })).toBeVisible()
			await expect
				.poll(async () => (await menu.boundingBox())?.x ?? Number.NEGATIVE_INFINITY)
				.toBeGreaterThanOrEqual(-0.5)
			const bounds = await menu.boundingBox()
			expect(bounds?.y).toBe(0)
			expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeCloseTo(size.height, 0)
			expect(bounds?.width).toBeCloseTo(320, 2)
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width)
			await page.getByRole('button', { name: 'Close navigation', exact: true }).last().click()
			await expect(trigger).toBeFocused()
		})
	}
}

test('every destination is reachable from the menu at phone size', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(STORY)

	await show(page, 'conversation')
	await openRemoteDestination(page, 'Usage')
	await expect(page.getByRole('region', { name: 'Usage' })).toBeVisible()
	await expect(page.getByRole('region', { name: 'Usage' })).toHaveCSS('animation-name', 'remote-reading-view-in')
	await openRemoteDestination(page, 'Sessions')
	await expect(page.getByRole('navigation', { name: 'Live sessions' })).toBeVisible()
	await expect(page.locator('.remote-conversation')).toHaveCount(0)
})

function productionShell(css: string) {
	return `
		<style>${GLOBAL_CSS}\n${css}</style>
		<div id="remote-root">
			<main class="remote-workspace" data-open="true">
				<section class="remote-conversation">
					<div class="remote-chat">
						<header class="remote-header"><button class="icon-btn remote-navigation-trigger" aria-label="Open navigation"></button><h2 class="sr-only">Conversation</h2></header>
						<div class="remote-reading-stage">
							<div class="remote-reading-area"><div class="remote-transcript"></div></div>
							<footer class="remote-composer">
								<div class="remote-compose-surface">
									<div class="remote-composer-actions">
										<label class="remote-prompt-field"><textarea aria-label="Message"></textarea></label>
										<button class="btn remote-send" aria-label="Send"></button>
									</div>
								</div>
							</footer>
						</div>
					</div>
				</section>
			</main>
		</div>
	`
}

for (const bottomInset of [0, 24, 34])
	test(`the PWA shell keeps its composer inside the viewport with a ${bottomInset}px bottom inset`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 })
		// Storybook owns a different document shell. Mount the production height
		// chain and a real composer shape so this catches both an oversized workspace
		// and a capsule lifted by unused footer space.
		const shellCss = REMOTE_CSS.replace(/env\(safe-area-inset-bottom,\s*0px\)/g, `${bottomInset}px`)
		await page.setContent(productionShell(shellCss))
		const geometry = await page.evaluate(() => {
			document.documentElement.classList.add('remote-page')
			document.body.classList.add('remote-page')
			const root = document.getElementById('remote-root')
			const workspace = document.querySelector<HTMLElement>('.remote-workspace')
			const composer = document.querySelector<HTMLElement>('.remote-composer')
			const surface = document.querySelector<HTMLElement>('.remote-compose-surface')
			const send = document.querySelector<HTMLElement>('.remote-send')
			if (!root || !workspace || !composer || !surface || !send) throw new Error('Missing Remote shell')
			return {
				html: getComputedStyle(document.documentElement).backgroundColor,
				body: getComputedStyle(document.body).backgroundColor,
				root: getComputedStyle(root).backgroundColor,
				rootMinimum: getComputedStyle(root).minHeight,
				workspaceBottom: workspace.getBoundingClientRect().bottom,
				workspaceHeight: workspace.getBoundingClientRect().height,
				composerFloor: getComputedStyle(composer).paddingBottom,
				surfaceBottom: surface.getBoundingClientRect().bottom,
				sendBottom: send.getBoundingClientRect().bottom,
				viewportHeight: innerHeight,
			}
		})
		const floor = Math.max(12, bottomInset - 16)
		expect(geometry.html).toBe('rgb(13, 13, 13)')
		expect(geometry.body).toBe('rgb(13, 13, 13)')
		expect(geometry.root).toBe('rgb(13, 13, 13)')
		expect(geometry.rootMinimum).toBe('100%')
		expect(geometry.workspaceHeight).toBeCloseTo(geometry.viewportHeight, 1)
		expect(geometry.workspaceBottom).toBeCloseTo(geometry.viewportHeight, 1)
		expect(geometry.composerFloor).toBe(`${floor}px`)
		expect(geometry.surfaceBottom).toBeCloseTo(geometry.viewportHeight - floor, 1)
		expect(geometry.sendBottom).toBeLessThanOrEqual(geometry.surfaceBottom)
	})

test('the measured installed iPhone viewport keeps the whole composer inside 797px, not its 844px vh', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 797 })
	// On the physical standalone PWA: inner/visual/dvh = 797, vh = 844,
	// safe top = 47, safe bottom = 34. Chromium cannot reproduce that unit
	// divergence, so force only the old standalone vh override to 844px.
	const css = REMOTE_CSS.replace('@media (display-mode: standalone) {', '@media all {')
		.replace('height: 100vh;', 'height: 844px;')
		.replace(/env\(safe-area-inset-top,\s*0px\)/g, '47px')
		.replace(/env\(safe-area-inset-bottom,\s*0px\)/g, '34px')
	await page.setContent(productionShell(css))
	const geometry = await page.evaluate(() => {
		const workspace = document.querySelector<HTMLElement>('.remote-workspace')
		const surface = document.querySelector<HTMLElement>('.remote-compose-surface')
		const send = document.querySelector<HTMLElement>('.remote-send')
		if (!workspace || !surface || !send) throw new Error('Missing Remote shell')
		return {
			workspaceBottom: workspace.getBoundingClientRect().bottom,
			surfaceBottom: surface.getBoundingClientRect().bottom,
			sendBottom: send.getBoundingClientRect().bottom,
			viewportHeight: innerHeight,
		}
	})
	expect(geometry.viewportHeight).toBe(797)
	expect(geometry.workspaceBottom).toBeCloseTo(797, 1)
	expect(geometry.surfaceBottom).toBeCloseTo(779, 1)
	expect(geometry.sendBottom).toBeLessThanOrEqual(geometry.surfaceBottom)
})

test('the transparent chat tail keeps its last message readable above the input', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 797 })
	await page.setContent(productionShell(REMOTE_CSS))
	const edge = await page.evaluate(() => {
		const reading = document.querySelector<HTMLElement>('.remote-reading-area')
		const transcript = document.querySelector<HTMLElement>('.remote-transcript')
		if (!reading || !transcript) throw new Error('Missing Remote reading area')
		for (let index = 0; index < 30; index++) {
			const message = document.createElement('div')
			message.className = 'remote-message'
			const text = document.createElement('span')
			text.textContent = `Message ${index}`
			message.append(text)
			transcript.append(message)
		}
		transcript.scrollTop = transcript.scrollHeight
		const text = transcript.lastElementChild?.firstElementChild
		if (!text) throw new Error('Missing last message')
		return {
			background: getComputedStyle(reading, '::after').backgroundImage,
			bottomSpace: Number.parseFloat(getComputedStyle(transcript).paddingBottom),
			lastTextBottom: text.getBoundingClientRect().bottom,
			readingBottom: reading.getBoundingClientRect().bottom,
			isScrolled: transcript.scrollTop > 0,
		}
	})
	expect(edge.isScrolled).toBe(true)
	expect(edge.background).toBe('none')
	expect(edge.bottomSpace).toBeGreaterThanOrEqual(28)
	expect(edge.lastTextBottom).toBeLessThanOrEqual(edge.readingBottom - 28)
})

test('the chat scrolls behind the transparent composer but its last line rests above the capsule', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 797 })
	await page.setContent(productionShell(REMOTE_CSS))
	const geometry = await page.evaluate(() => {
		const transcript = document.querySelector<HTMLElement>('.remote-transcript')
		if (!transcript) throw new Error('Missing transcript')
		for (let index = 0; index < 30; index++) {
			const message = document.createElement('div')
			message.className = 'remote-message'
			message.textContent = `Message ${index} with enough detail to wrap onto several lines.`
			transcript.append(message)
		}
		const reading = document.querySelector<HTMLElement>('.remote-reading-area')
		const composer = document.querySelector<HTMLElement>('.remote-composer')
		const surface = document.querySelector<HTMLElement>('.remote-compose-surface')
		const pane = document.querySelector<HTMLElement>('.remote-transcript')
		if (!reading || !composer || !surface || !pane) throw new Error('Missing chat surfaces')
		// Static shell has no React ResizeObserver. Supply the same measured CSS
		// value; the mounted-browser test checks that the observer updates it.
		const stage = reading.closest<HTMLElement>('.remote-reading-stage')
		if (!stage) throw new Error('Missing reading stage')
		stage.style.setProperty('--remote-composer-overlap', `${Math.ceil(composer.getBoundingClientRect().height)}px`)
		pane.scrollTop = pane.scrollHeight
		const tail = pane.querySelector<HTMLElement>('.remote-message:last-of-type')
		const tailBottom = tail?.getBoundingClientRect().bottom
		pane.scrollTop -= 80
		const scrolledTextBottom = tail?.getBoundingClientRect().bottom
		const blankFooterHit = document.elementFromPoint(8, composer.getBoundingClientRect().top + 12)
		return {
			readingBottom: reading.getBoundingClientRect().bottom,
			composerTop: composer.getBoundingClientRect().top,
			composerBottom: composer.getBoundingClientRect().bottom,
			surfaceTop: surface.getBoundingClientRect().top,
			tailBottom,
			scrolledTextBottom,
			blankFooterHitsTranscript: blankFooterHit === pane || pane.contains(blankFooterHit),
			bottomPadding: Number.parseFloat(getComputedStyle(pane).paddingBottom),
			composerHeight: composer.getBoundingClientRect().height,
		}
	})
	expect(geometry.readingBottom).toBeCloseTo(geometry.composerBottom, 1)
	expect(geometry.composerTop).toBeLessThan(geometry.readingBottom)
	expect(geometry.bottomPadding).toBeGreaterThanOrEqual(geometry.composerHeight + 28)
	expect(geometry.tailBottom).toBeLessThanOrEqual(geometry.surfaceTop - 20)
	expect(geometry.scrolledTextBottom).toBeGreaterThan(geometry.composerTop)
	expect(geometry.scrolledTextBottom).toBeLessThan(geometry.readingBottom)
	expect(geometry.blankFooterHitsTranscript).toBe(true)
})

test('conversation text scrolls behind the transparent header without obscuring its first line', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 797 })
	await page.setContent(productionShell(REMOTE_CSS))
	const geometry = await page.evaluate(() => {
		const header = document.querySelector<HTMLElement>('.remote-chat > .remote-header')
		const reading = document.querySelector<HTMLElement>('.remote-reading-area')
		const transcript = document.querySelector<HTMLElement>('.remote-transcript')
		if (!header || !reading || !transcript) throw new Error('Missing conversation surfaces')
		for (let index = 0; index < 30; index++) {
			const message = document.createElement('p')
			message.className = 'remote-message'
			message.textContent = `Message ${index} with enough detail to wrap onto several lines.`
			transcript.append(message)
		}
		transcript.scrollTop = 0
		const firstTextTop = transcript.firstElementChild?.getBoundingClientRect().top
		const headerBottom = header.getBoundingClientRect().bottom
		transcript.scrollTop = 80
		const scrollingTextTop = transcript.firstElementChild?.getBoundingClientRect().top
		return {
			headerBottom,
			readingTop: reading.getBoundingClientRect().top,
			background: getComputedStyle(header).backgroundColor,
			firstTextTop,
			scrollingTextTop,
			blankHeaderHitsTranscript: document.elementFromPoint(200, 22)?.closest('.remote-transcript') === transcript,
		}
	})
	expect(geometry.background).toBe('rgba(0, 0, 0, 0)')
	expect(geometry.readingTop).toBeCloseTo(0, 1)
	expect(geometry.firstTextTop).toBeGreaterThanOrEqual(geometry.headerBottom + 24)
	expect(geometry.scrollingTextTop).toBeLessThan(geometry.headerBottom)
	expect(geometry.blankHeaderHitsTranscript).toBe(true)
})

test('only the floating menu circle is frosted; the header and bottom stay transparent', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto('/iframe.html?id=views-helm-remote--reading-edge&viewMode=story')
	const header = page.locator('.remote-chat > .remote-header')
	const control = header.locator('.remote-navigation-trigger:visible')
	await expect(header.locator('button')).toHaveCount(1)
	await expect(header).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
	await expect(header).toHaveCSS('backdrop-filter', 'none')
	await expect(control).toHaveCSS('border-radius', '999px')
	expect(await control.evaluate(node => getComputedStyle(node).backdropFilter)).toContain('blur(5px)')
	const menuRim = await control.evaluate(node => getComputedStyle(node).boxShadow)
	expect(menuRim).toContain('inset')
	expect(menuRim.match(/inset/g)).toHaveLength(2)
	const fill = () => control.evaluate(node => getComputedStyle(node, '::before').backgroundColor)
	expect(await fill()).toBe('rgba(0, 0, 0, 0)')
	await control.hover()
	await expect.poll(fill).not.toBe('rgba(0, 0, 0, 0)')
	await page.mouse.move(390, 400)
	await expect.poll(fill).toBe('rgba(0, 0, 0, 0)')
	expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44)
	await expect(page.locator('.remote-composer')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
	const surface = page.locator('.remote-compose-surface')
	await expect(surface).toHaveCSS('backdrop-filter', 'none')
	const frostedLayer = await surface.evaluate(node => {
		const style = getComputedStyle(node, '::before')
		return {
			background: style.backgroundColor,
			blur: style.backdropFilter,
			rim: style.boxShadow,
			pointerEvents: style.pointerEvents,
		}
	})
	expect(frostedLayer.background).not.toBe('rgba(0, 0, 0, 0)')
	expect(frostedLayer.blur).toBe('blur(12px)')
	expect(frostedLayer.rim.match(/inset/g)).toHaveLength(2)
	expect(frostedLayer.pointerEvents).toBe('none')
	await expect(page.locator('.remote-information-footer')).toHaveCount(0)
})

test('the document paints beyond a short installed-PWA layout viewport without enlarging the workspace', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.setContent(productionShell(REMOTE_CSS))
	const geometry = await page.evaluate(() => {
		document.documentElement.classList.add('remote-page')
		document.body.classList.add('remote-page')
		const workspace = document.querySelector<HTMLElement>('.remote-workspace')
		if (!workspace) throw new Error('Missing workspace')
		return {
			rootMinHeight: getComputedStyle(document.documentElement).minHeight,
			rootColor: getComputedStyle(document.documentElement).backgroundColor,
			bodyColor: getComputedStyle(document.body).backgroundColor,
			workspaceHeight: getComputedStyle(workspace).height,
		}
	})
	// WebKit has reported 100dvh=797px and 100vh=844px on the installed
	// 390x844 phone. The document may paint the latter; the clipped workspace
	// must still use the former, never a 100vh layout override.
	expect(geometry.rootMinHeight).toBe('844px')
	expect(geometry.rootColor).toBe('rgb(13, 13, 13)')
	expect(geometry.bodyColor).toBe('rgb(13, 13, 13)')
	expect(geometry.workspaceHeight).toBe('844px')
})

test('the chat top has no overlay fade and its first message clears the floating control', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 797 })
	await page.setContent(productionShell(REMOTE_CSS))
	const edge = await page.evaluate(() => {
		const header = document.querySelector<HTMLElement>('.remote-chat > .remote-header')
		const reading = document.querySelector<HTMLElement>('.remote-reading-area')
		const transcript = document.querySelector<HTMLElement>('.remote-transcript')
		if (!header || !reading || !transcript) throw new Error('Missing Remote reading area')
		for (let index = 0; index < 30; index++) {
			const message = document.createElement('div')
			message.className = 'remote-message'
			const text = document.createElement('span')
			text.textContent = `Message ${index}`
			message.append(text)
			transcript.append(message)
		}
		transcript.scrollTop = 0
		const text = transcript.firstElementChild?.firstElementChild
		if (!text) throw new Error('Missing first message')
		return {
			headerHeight: header.getBoundingClientRect().height,
			background: getComputedStyle(reading, '::before').backgroundImage,
			topSpace: Number.parseFloat(getComputedStyle(transcript).paddingTop),
			firstTextTop: text.getBoundingClientRect().top,
			readingTop: reading.getBoundingClientRect().top,
		}
	})
	expect(edge.background).toBe('none')
	expect(edge.topSpace).toBeGreaterThanOrEqual(edge.headerHeight + 24)
	expect(edge.firstTextTop).toBeGreaterThanOrEqual(edge.readingTop + edge.headerHeight + 24)
})

test('no hover styling can stick to a touch device', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 })
	await page.goto(STORY)
	await expect(page.locator('.remote-session-row').first()).toBeVisible()

	// A phone applies :hover to whatever was last touched and leaves it there, so a
	// drag down the session list would light up the row the finger stopped over. Every
	// hover rule must therefore sit behind a hover-capable guard.
	const unguarded = await page.evaluate(() => {
		const found: string[] = []
		const walk = (rules: CSSRuleList, guarded: boolean) => {
			for (const rule of Array.from(rules)) {
				if (rule instanceof CSSMediaRule) {
					walk(rule.cssRules, guarded || rule.conditionText.includes('hover: hover'))
					continue
				}
				if (!(rule instanceof CSSStyleRule) || !rule.selectorText.includes(':hover') || guarded) continue
				const reaches = rule.selectorText
					.split(',')
					.map(selector => selector.replace(/:hover/g, '').trim())
					.some(selector => {
						try {
							return selector !== '' && document.querySelector(selector) !== null
						} catch {
							return false
						}
					})
				if (reaches) found.push(rule.selectorText)
			}
		}
		for (const sheet of Array.from(document.styleSheets)) {
			try {
				walk(sheet.cssRules, false)
			} catch {
				/* A cross-origin workbench sheet owns none of this. */
			}
		}
		return found
	})
	expect(unguarded).toEqual([])
})
