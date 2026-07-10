import { build } from 'esbuild'
import { cpSync } from 'node:fs'

const common = { bundle: true, sourcemap: 'inline', logLevel: 'warning' }

// Main: node-pty stays external (native module, loaded from node_modules at runtime).
await build({
	...common,
	entryPoints: ['src/main.ts'],
	platform: 'node',
	format: 'cjs',
	outfile: 'dist/main.cjs',
	external: ['electron', 'node-pty'],
})

await build({
	...common,
	entryPoints: ['src/preload.ts'],
	platform: 'node',
	format: 'cjs',
	outfile: 'dist/preload.cjs',
	external: ['electron'],
})

// CSS imports (xterm.css + styles.css) bundle into dist/renderer.css alongside renderer.js.
await build({
	...common,
	entryPoints: ['src/renderer/renderer.ts'],
	platform: 'browser',
	format: 'iife',
	outdir: 'dist',
})

cpSync('src/renderer/index.html', 'dist/index.html')
console.log('helm built to dist/')
