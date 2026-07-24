import { fileURLToPath } from 'node:url'

/**
 * Build an all-absolute reporter command for both tsx source mode and compiled dist mode.
 * The scheduled agent never relies on PATH or shell expansion.
 */
export function scheduledReporterCommand(
	moduleUrl = import.meta.url,
	nodePath = process.execPath,
): readonly [string, ...string[]] {
	const sourceMode = fileURLToPath(moduleUrl).endsWith('.ts')
	return sourceMode
		? [
				nodePath,
				fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', moduleUrl)),
				fileURLToPath(new URL('./reporter.ts', moduleUrl)),
			]
		: [nodePath, fileURLToPath(new URL('./reporter.js', moduleUrl))]
}
