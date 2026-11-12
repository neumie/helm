// helm open S3: pictures in the production DocumentReview window (Views/Document review/Pictures). Bytes come from
// blob: URLs standing in for main's helm-viewer: tokens; the header worker, decode, zoom/pan and copy are real.
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function open(page: Page, story: string, name: string) {
	await page.setViewportSize({ width: 1180, height: 800 })
	await page.goto(`/iframe.html?id=views-document-review-pictures--${story}&viewMode=story`)
	await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 20000 })
}
// Mirrors window.__helmPictureProof from PictureViewer.stories.tsx (Storybook's own Window declaration).
type PictureProof = { zoom(step: 1 | -1 | 0): void; update(scenario: string): Promise<void>; copied: Uint8Array[] }
type ProofWindow = { __helmPictureProof?: PictureProof }
const status = (page: Page) => page.locator('.viewer-status')
const position = (page: Page) => page.locator('.viewer-status-position')
const view = (page: Page) => page.locator('.viewer-picture')
const picture = (page: Page) => page.locator('.viewer-picture-image')

test('a screenshot fits the window; 1, +, −, 0 and the window zoom keys scale it; arrows and drag pan', async ({
	page,
}) => {
	await open(page, 'screenshot', 'company-create-error@2x.png')
	await expect(picture(page)).toBeVisible()
	await expect(position(page)).toHaveText(/^Fit · \d+%$/)
	await expect(status(page)).toContainText('PNG')
	await expect(status(page)).toContainText('2,400 × 1,520')
	await expect(status(page)).toContainText(/\d+ KiB$/)
	await expect(picture(page)).toHaveAttribute('src', /^blob:/)
	const fitted = await picture(page).boundingBox()
	expect(fitted && fitted.width < 1180).toBe(true)
	await view(page).focus()
	await page.keyboard.press('1')
	await expect(position(page)).toHaveText('100%')
	await expect.poll(async () => (await picture(page).boundingBox())?.width).toBe(2400)
	const before = await view(page).evaluate(element => element.scrollLeft)
	await page.keyboard.press('ArrowRight')
	await expect.poll(() => view(page).evaluate(element => element.scrollLeft)).toBeGreaterThan(before)
	// Drag pans when the picture overflows.
	const box = await view(page).boundingBox()
	if (!box) throw new Error('no view')
	const left = await view(page).evaluate(element => element.scrollLeft)
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
	await page.mouse.down()
	await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 40, { steps: 4 })
	await page.mouse.up()
	await expect.poll(() => view(page).evaluate(element => element.scrollLeft)).toBeGreaterThan(left + 60)
	await page.keyboard.press('+')
	await expect(position(page)).toHaveText('150%')
	await page.keyboard.press('-')
	await page.keyboard.press('-')
	await expect(position(page)).toHaveText('75%')
	await page.keyboard.press('0')
	await expect(position(page)).toHaveText(/^Fit · \d+%$/)
	// ⌘= / ⌘0 from main's shortcut dispatcher scale the picture, not the reading text.
	await page.evaluate(() => (window as unknown as ProofWindow).__helmPictureProof?.zoom(1))
	await expect(position(page)).not.toHaveText(/^Fit/)
	await page.evaluate(() => (window as unknown as ProofWindow).__helmPictureProof?.zoom(0))
	await expect(position(page)).toHaveText(/^Fit · \d+%$/)
	// Pinch (ctrl + wheel) zooms at the cursor.
	await page.mouse.move(box.x + 200, box.y + 200)
	await page.keyboard.down('Control')
	await page.mouse.wheel(0, -200)
	await page.keyboard.up('Control')
	await expect(position(page)).not.toHaveText(/^Fit/)
	await expect(page.locator('.review-companion')).toHaveCount(0)
})

test('a live reload keeps the zoom and pan and swaps the picture only once the new one has decoded', async ({
	page,
}) => {
	await open(page, 'screenshot', 'company-create-error@2x.png')
	await expect(picture(page)).toBeVisible()
	await view(page).focus()
	await page.keyboard.press('1')
	await view(page).evaluate(element => {
		element.scrollLeft = 300
		element.scrollTop = 200
	})
	const first = await picture(page).getAttribute('src')
	await page.evaluate(() => (window as unknown as ProofWindow).__helmPictureProof?.update('screenshot'))
	await expect(picture(page)).not.toHaveAttribute('src', first ?? '')
	await expect(picture(page)).toHaveCount(1)
	await expect(position(page)).toHaveText('100%')
	expect(await view(page).evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([300, 200])
})

test('a newer version that is refused leaves the last good picture, zoom and a banner; the next good one says Updated', async ({
	page,
}) => {
	await open(page, 'screenshot', 'company-create-error@2x.png')
	await expect(picture(page)).toBeVisible()
	await view(page).focus()
	await page.keyboard.press('1')
	const first = await picture(page).getAttribute('src')
	await page.evaluate(() => (window as unknown as ProofWindow).__helmPictureProof?.update('too-large'))
	await expect(page.getByRole('alert')).toContainText('15,100 × 10,000 pixels (151.0 MP)')
	await expect(page.getByRole('alert')).toContainText('The last readable version remains visible.')
	await expect(picture(page)).toHaveAttribute('src', first ?? '')
	await expect(position(page)).toHaveText('100%')
	await expect(status(page)).toContainText('Last readable version')
	await page.evaluate(() => (window as unknown as ProofWindow).__helmPictureProof?.update('screenshot'))
	await expect(page.getByRole('alert')).toHaveCount(0)
	await expect(status(page)).toContainText(/Updated \d\d:\d\d/)
	await expect(position(page)).toHaveText('100%')
})

test('EXIF orientation 6: a photo stored 760 × 520 is shown upright at 520 × 760', async ({ page }) => {
	await open(page, 'exif-rotated', 'IMG_2231.jpg')
	await expect(picture(page)).toBeVisible()
	await expect(status(page)).toContainText('520 × 760')
	await expect(status(page)).toContainText('Rotated 90° by EXIF')
	expect(
		await picture(page).evaluate(image => [
			(image as HTMLImageElement).naturalWidth,
			(image as HTMLImageElement).naturalHeight,
		]),
	).toEqual([520, 760])
	const box = await picture(page).boundingBox()
	expect(box && box.height > box.width).toBe(true)
})

test('an SVG renders as an image: its script never runs and its external images never load', async ({ page }) => {
	const external: string[] = []
	page.on('request', request => {
		if (!/^(https?:\/\/127\.0\.0\.1|blob:|data:)/.test(request.url())) external.push(request.url())
	})
	await page.addInitScript(() => {
		;(window as unknown as { __svgMessages: unknown[] }).__svgMessages = []
		window.addEventListener('message', event =>
			(window as unknown as { __svgMessages: unknown[] }).__svgMessages.push(event.data),
		)
	})
	await open(page, 'svg', 'release-badge.svg')
	await expect(picture(page)).toBeVisible()
	await expect(status(page)).toContainText('SVG')
	await expect(status(page)).toContainText('480 × 320')
	expect(await picture(page).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(480)
	await expect(picture(page)).toHaveAttribute('src', /^blob:/)
	// Never inline: no <svg> from the file in the window's DOM, no script effect, nothing fetched from outside.
	await expect(page.locator('.viewer-stage svg title', { hasText: 'Release badge' })).toHaveCount(0)
	await expect(page.locator('script', { hasText: 'svg-script-ran' })).toHaveCount(0)
	await page.waitForTimeout(400)
	expect(await page.evaluate(() => (window as unknown as { __svgMessages: unknown[] }).__svgMessages)).not.toContain(
		'svg-script-ran',
	)
	expect(await page.title()).not.toBe('svg-script-ran')
	expect(external.filter(url => url.includes('example.invalid'))).toEqual([])
})

test('a 151 MP header is refused with the numbers before anything decodes', async ({ page }) => {
	await open(page, 'too-large', 'panorama-151mp.png')
	await expect(page.getByRole('alert')).toHaveText(
		'panorama-151mp.png is 15,100 × 10,000 pixels (151.0 MP); Helm shows images up to 150 MP.',
	)
	await expect(picture(page)).toHaveCount(0)
})

test('a HEIC shows the PNG sips made and says so', async ({ page }) => {
	await open(page, 'heic', 'IMG_0412.HEIC')
	await expect(picture(page)).toBeVisible()
	await expect(status(page)).toContainText('HEIC, shown as PNG')
	await expect(status(page)).toContainText('760 × 520')
	await expect(status(page)).toContainText('8 KiB') // 7,442 bytes of HEIC, rounded up like every size Helm shows
})

test('Copy image (menu and the Edit menu’s copy) hands main a PNG of the picture at its pixel size', async ({
	page,
}) => {
	await open(page, 'exif-rotated', 'IMG_2231.jpg')
	await expect(picture(page)).toBeVisible()
	await page.getByRole('button', { name: 'Document options' }).click()
	await page.getByRole('menuitem', { name: /Copy image/ }).click()
	await expect(status(page)).toContainText('Copied as PNG')
	const header = await page.evaluate(() => {
		const png = (window as unknown as ProofWindow).__helmPictureProof?.copied[0]
		if (!png) return null
		const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
		return { signature: Array.from(png.subarray(0, 8)), width: view.getUint32(16), height: view.getUint32(20) }
	})
	// The copy matches the screen: EXIF orientation applied.
	expect(header).toEqual({ signature: [137, 80, 78, 71, 13, 10, 26, 10], width: 520, height: 760 })
	// The Edit menu's ⌘C reaches the window as a copy command.
	await view(page).focus()
	await page.evaluate(() => document.execCommand('copy'))
	await expect
		.poll(() => page.evaluate(() => (window as unknown as ProofWindow).__helmPictureProof?.copied.length))
		.toBe(2)
})

test('transparency shows a checkerboard only where the picture has alpha', async ({ page }) => {
	await open(page, 'transparent', 'app-icon.png')
	await expect(picture(page)).toHaveAttribute('data-transparent', '')
	await expect(position(page)).toHaveText('Fit · 100%')
	await open(page, 'screenshot', 'company-create-error@2x.png')
	await expect(picture(page)).toBeVisible()
	await expect(picture(page)).not.toHaveAttribute('data-transparent', '')
})

for (const [story, name, size, word] of [
	['gif', 'form-error.gif', '760 × 520', 'GIF'],
	['web-p', 'form-error.webp', '760 × 520', 'WebP'],
	['avif', 'form-error.avif', '760 × 520', 'AVIF'],
	['bmp', 'form-error.bmp', '120 × 80', 'BMP'],
	['ico', 'favicon.ico', '48 × 48', 'ICO'],
] as const)
	test(`${word} decodes with its header size`, async ({ page }) => {
		await open(page, story, name)
		await expect(picture(page)).toBeVisible()
		await expect(status(page)).toContainText(word)
		await expect(status(page)).toContainText(size)
	})

test('the light window changes only the chrome', async ({ page }) => {
	await open(page, 'screenshot-light-window', 'company-create-error@2x.png')
	await expect(page.locator('.viewer-window')).toHaveAttribute('data-review-theme', 'light')
	await expect(picture(page)).toBeVisible()
	await page.getByRole('button', { name: 'Document options' }).click()
	await page.getByRole('menuitem', { name: 'Dark window' }).click()
	await expect(page.locator('.viewer-window')).toHaveAttribute('data-review-theme', 'dark')
})
