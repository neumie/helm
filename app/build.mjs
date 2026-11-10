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
		context.onResolve({ filter: /\/data-worker-factory$/ }, args => ({
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
writeFileSync('dist/viewer/meta.json', JSON.stringify(viewer.metafile))
cpSync('src/renderer/index.html', 'dist/index.html')
// Claude in Helm terminals: plain CommonJS run by Bun (preload) and Node (hook client), never bundled.
cpSync('src/claude-remote/preload.cjs', 'dist/claude-remote-preload.cjs')
cpSync('src/claude-remote/hook-client.cjs', 'dist/claude-remote-hook.cjs')
cpSync('src/renderer/run-context-editor.html', 'dist/run-context-editor.html')
console.log('helm built to dist/')
