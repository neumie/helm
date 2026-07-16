// Storybook workbench for the sidebar components (docs/design-system.md §7).
// This is a workbench, not a build target: it stays out of `bun run build`
// and the root `make check` (stories are excluded from the app tsconfig).
import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
	framework: '@storybook/react-vite',
	stories: ['../src/renderer/sidebar/**/*.stories.tsx'],
}

export default config
