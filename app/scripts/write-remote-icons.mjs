// Authoring tool, not part of ordinary builds. Generated PNGs are checked in.
// Heroicons v2.2.0 native geometry; see THIRD_PARTY_NOTICES.md.
import { readFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'
const assets = new URL('../assets/remote/', import.meta.url)
const svg = await readFile(new URL('command-line.svg', assets), 'utf8')
const css = await readFile(new URL('../src/renderer/styles.css', import.meta.url), 'utf8')
const color = token => {
	const value = css.match(new RegExp(`--${token}: (#[0-9a-f]+);`))?.[1]
	if (!value) throw new Error(`Missing Helm token ${token}`)
	return value
}
const browser = await chromium.launch({ headless: true })
try {
	for (const size of [180, 192, 512]) {
		const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
		await page.setContent(
			`<style>body{margin:0;display:grid;place-items:center;width:100vw;height:100vh;background:${color('pane')};color:${color('text-0')}}svg{width:50%;height:50%}</style>${svg}`,
		)
		await page.screenshot({ path: new URL(`icon-${size}.png`, assets).pathname })
		await page.close()
	}
} finally {
	await browser.close()
}
