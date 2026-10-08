import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
// Storybook workbench for renderer views, compositions, and primitives (docs/design-system.md §7).
// This is a workbench, not a build target: it stays out of `bun run build`
// and the root `make check` (stories are excluded from the app tsconfig).
import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
	framework: '@storybook/react-vite',
	stories: ['../src/renderer/**/*.stories.tsx'],
	viteFinal: config => {
		const cacheDirectory = process.env.HELM_STORYBOOK_CACHE_DIR
		if (cacheDirectory !== undefined) {
			if (!isAbsolute(cacheDirectory)) throw new Error('HELM_STORYBOOK_CACHE_DIR must be an absolute path.')
			config.cacheDir = cacheDirectory
		}
		config.server ??= {}
		config.server.fs ??= {}
		config.server.fs.allow = [
			...(config.server.fs.allow ?? [fileURLToPath(new URL('../', import.meta.url))]),
			fileURLToPath(new URL('../../extension/dist/workbench.js', import.meta.url)),
		]
		return config
	},
}

export default config
