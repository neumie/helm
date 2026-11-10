import { cpSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { buildDocumentCanvas } from './scripts/build-document-canvas.mjs'

await buildDocumentCanvas()

const common = { bundle: true, sourcemap: 'inline', logLevel: 'warning' }

// Main: node-pty stays external (native module, loaded from node_modules at runtime).
await build({
	...common,
	entryPoints: ['src/main.ts'],
	platform: 'node',
	format: 'cjs',
	outfile: 'dist/main.cjs',
	external: ['electron', 'node-pty', '../native/window-zoom-guard/build/Release/helm_native_window_zoom_guard.node'],
})

await build({
	...common,
	entryPoints: ['src/preload.ts'],
	platform: 'node',
	format: 'cjs',
	outfile: 'dist/preload.cjs',
	external: ['electron'],
})

await build({
	...common,
	entryPoints: ['src/preload-run-context.ts'],
	platform: 'node',
	format: 'cjs',
	outfile: 'dist/preload-run-context.cjs',
	external: ['electron'],
})

// CSS imports (xterm.css + styles.css) bundle into dist/renderer.css alongside renderer.js.
// jsx 'automatic' matches tsconfig "jsx": "react-jsx" (sidebar .tsx files).
await build({
	...common,
	entryPoints: ['src/renderer/renderer.ts'],
	platform: 'browser',
	format: 'iife',
	jsx: 'automatic',
	outdir: 'dist',
})

await build({
	...common,
	entryPoints: ['src/renderer/run-context-editor.tsx'],
	platform: 'browser',
	format: 'iife',
	jsx: 'automatic',
	outdir: 'dist',
})

await build({
	...common,
	entryPoints: ['src/preload-document-review.ts'],
	platform: 'node',
	format: 'cjs',
	outfile: 'dist/preload-document-review.cjs',
	external: ['electron'],
})
// The review/viewer window: ESM with code splitting, served from dist/viewer by the helm-viewer: protocol
// (app/src/document-review/viewer-protocol.ts). Hashed chunks would pile up, so the folder is rebuilt whole, and the
// old IIFE files are removed so nothing can load them. Workers are their own entries with stable names: esbuild does
// not bundle `new Worker(new URL(...))`, so the renderer's worker factory is swapped for the built file's URL.
rmSync('dist/viewer', { recursive: true, force: true })
rmSync('dist/document-review.js', { force: true })
rmSync('dist/document-review.css', { force: true })
rmSync('dist/document-review.html', { force: true })
const builtWorkers = {
	name: 'helm-viewer-workers',
	setup(context) {
		context.onResolve({ filter: /\/((data|image)-worker-factory|pdf-assets)$/ }, args => ({
			path: resolve(args.resolveDir, `${args.path.slice(args.path.lastIndexOf('/') + 1)}.built.ts`),
		}))
	},
}
const viewer = await build({
	bundle: true,
	logLevel: 'warning',
	sourcemap: 'linked',
	entryPoints: {
		'document-review': 'src/renderer/document-review.tsx',
		'data-worker': 'src/renderer/viewer/data-worker.ts',
		'image-worker': 'src/renderer/viewer/image-worker.ts',
	},
	platform: 'browser',
	format: 'esm',
	splitting: true,
	target: 'es2022',
	jsx: 'automatic',
	outdir: 'dist/viewer/assets',
	entryNames: '[name]',
	chunkNames: '[name]-[hash]',
	assetNames: '[name]-[hash]',
	metafile: true,
	plugins: [builtWorkers],
})
cpSync('src/renderer/document-review.html', 'dist/viewer/index.html')
// pdf.js runs its own worker and fetches its optional data (CMaps, standard fonts, wasm image decoders, the CMYK
// ICC profile) only when a PDF needs it, from helm-viewer://app/assets/pdfjs/ (app/src/renderer/viewer/pdf-assets.ts).
// Never the scripting sandbox (pdf.sandbox, quickjs) or the no-wasm JS fallbacks: Helm runs no PDF JavaScript.
const pdfjs = 'node_modules/pdfjs-dist'
cpSync(`${pdfjs}/build/pdf.worker.min.mjs`, 'dist/viewer/assets/pdfjs/build/pdf.worker.min.mjs')
cpSync(`${pdfjs}/cmaps`, 'dist/viewer/assets/pdfjs/cmaps', {
	recursive: true,
	filter: source => !/LICENSE$/.test(source),
})
cpSync(`${pdfjs}/standard_fonts`, 'dist/viewer/assets/pdfjs/standard_fonts', {
	recursive: true,
	filter: source => !/LICENSE[^/]*$/.test(source),
})
for (const wasm of ['jbig2.wasm', 'openjpeg.wasm', 'qcms_bg.wasm'])
	cpSync(`${pdfjs}/wasm/${wasm}`, `dist/viewer/assets/pdfjs/wasm/${wasm}`)
cpSync(`${pdfjs}/iccs/CGATS001Compat-v2-micro.icc`, 'dist/viewer/assets/pdfjs/iccs/CGATS001Compat-v2-micro.icc')
// Their license texts ship beside them (THIRD_PARTY_NOTICES.md); the viewer never requests these files.
for (const license of [
	'LICENSE',
	'cmaps/LICENSE',
	'iccs/LICENSE',
	'standard_fonts/LICENSE_FOXIT',
	'standard_fonts/LICENSE_LIBERATION',
	'wasm/LICENSE_JBIG2',
	'wasm/LICENSE_OPENJPEG',
	'wasm/LICENSE_QCMS',
	'wasm/LICENSE_PDFJS_JBIG2',
	'wasm/LICENSE_PDFJS_OPENJPEG',
	'wasm/LICENSE_PDFJS_QCMS',
])
	cpSync(`${pdfjs}/${license}`, `dist/viewer/assets/pdfjs/licenses/${license.replace('/', '-')}.txt`)
writeFileSync('dist/viewer/meta.json', JSON.stringify(viewer.metafile))
cpSync('src/renderer/index.html', 'dist/index.html')
// Claude in Helm terminals: plain CommonJS run by Bun (preload) and Node (hook client), never bundled.
cpSync('src/claude-remote/preload.cjs', 'dist/claude-remote-preload.cjs')
cpSync('src/claude-remote/hook-client.cjs', 'dist/claude-remote-hook.cjs')
cpSync('src/renderer/run-context-editor.html', 'dist/run-context-editor.html')
console.log('helm built to dist/')
