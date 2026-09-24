import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const root = fileURLToPath(new URL('..', import.meta.url))
await build({
	entryPoints: [new URL('../src/renderer/remote/entry.tsx', import.meta.url).pathname],
	bundle: true,
	format: 'esm',
	jsx: 'automatic',
	outfile: `${root}/remote-dist/remote.js`,
	minify: true,
	sourcemap: false,
})
await mkdir(`${root}/remote-dist`, { recursive: true })
for (const name of ['manifest.webmanifest', 'remote-sw.js', 'icon-180.png', 'icon-192.png', 'icon-512.png'])
	await copyFile(`${root}/assets/remote/${name}`, `${root}/remote-dist/${name}`)
await writeFile(
	`${root}/remote-dist/index.html`,
	'<!doctype html><html lang="en" class="remote-page"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#0d0d0d"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-180.png"><title>Helm Remote</title><link rel="stylesheet" href="/remote.css"></head><body class="remote-page"><div id="remote-root"></div><script type="module" src="/remote.js"></script></body></html>',
)
