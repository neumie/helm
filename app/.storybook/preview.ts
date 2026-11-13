// Stories consume the REAL app CSS + tokens (design-system.md §7) — never
// story-local styles. styles.css carries the :root token ladder and body type;
// sidebar.css (+ its detail-redesign.css import) carries every component rule.
import type { Preview } from '@storybook/react-vite'

import '../src/renderer/styles.css'
import '../src/renderer/sidebar/sidebar.css'
import '../src/renderer/sidebar/detail-redesign.css'
import './preview.css'

const preview: Preview = {
	parameters: {
		options: {
			// Full review surfaces are the first thing a designer sees; lower-level
			// inventories follow from composition down to primitive.
			storySort: {
				// Proposals/ (design variants waiting for Jakub's pick) come first so a link lands next to its siblings.
				order: [
					'Proposals',
					// All decisions (the one page to decide everything) first, then numeric D order (the sidebar sorts by text,
					// which put D10 before D4); tests/design-proposals-order.test.ts holds it.
					[
						'All decisions',
						'D4 Radius',
						'D4 Accent text',
						'D5 Contrast',
						'D6 Icons',
						'D7 Surface reach',
						'D8 Scale',
						'D9 Extension popup',
						'D10 Theme files',
						'D11 Toggles',
						'D12 Widget height',
						'D13 UI scale',
						'D14 Toast cap',
					],
					'Views',
					['Sidebar', 'Terminal workspace', 'Run context editor'],
					'Compositions',
					'Primitives',
					'*',
				],
			},
		},
		// Canvas backgrounds mirror the app's background ladder (§2.1); the
		// default matches the sidebar's --pane so components sit on the exact
		// surface they ship on.
		backgrounds: {
			options: {
				pane: { name: 'Pane', value: '#141517' },
				chrome: { name: 'Chrome', value: '#1a1c1f' },
				well: { name: 'Well', value: '#0f1113' },
			},
		},
	},
	initialGlobals: {
		backgrounds: { value: 'pane' },
	},
}

export default preview
