import { mkdir, writeFile } from 'node:fs/promises'
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
await writeFile(
	`${root}/remote-dist/index.html`,
	'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark"><title>Helm Remote</title><link rel="stylesheet" href="/remote.css"></head><body><div id="remote-root"></div><script type="module" src="/remote.js"></script></body></html>',
)
