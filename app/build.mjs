import { cpSync } from 'node:fs'
import { build } from 'esbuild'

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

cpSync('src/renderer/index.html', 'dist/index.html')
cpSync('src/renderer/run-context-editor.html', 'dist/run-context-editor.html')
console.log('helm built to dist/')
