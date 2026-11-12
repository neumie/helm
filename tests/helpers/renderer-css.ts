// The renderer stylesheet as tests see it. `app/src/renderer/styles.css` is an ordered @import manifest
// (component CSS lives beside its component); bundlers inline those files in manifest order. Tests that
// regex over "all renderer CSS" read the same text here, independent of which file holds a rule.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const RENDERER_DIR = join(import.meta.dirname, '..', '..', 'app', 'src', 'renderer')

/** The manifest's imports, relative to `app/src/renderer`, in cascade order. */
export function rendererCssFiles(): string[] {
	const manifest = readFileSync(join(RENDERER_DIR, 'styles.css'), 'utf8')
	const files = [...manifest.matchAll(/^@import "\.\/([^"]+)";$/gm)].map(match => match[1] as string)
	if (files.length === 0) throw new Error('app/src/renderer/styles.css lists no @import')
	return files
}

/** Every file the manifest imports, concatenated in cascade order (one blank line between files). */
export function readRendererCss(): string {
	return rendererCssFiles()
		.map(file => readFileSync(join(RENDERER_DIR, file), 'utf8'))
		.join('\n')
}
