// Stories consume the REAL app CSS + tokens (design-system.md §7) — never
// story-local styles. styles.css carries the :root token ladder and body type;
// sidebar.css (+ its detail-redesign.css import) carries every component rule.
import type { Preview } from '@storybook/react-vite'
import { BACKGROUNDS } from './backgrounds.generated'

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
						'D7 Surface reach',
						'D15 Contrast',
						'D16 Remote values',
						'D17 Off-scale values',
						'D18 Shortcut alias divider',
						'D19 Z-index and motion',
					],
					'Views',
					['Sidebar', 'Terminal workspace', 'Run context editor'],
					'Compositions',
					'Primitives',
					'*',
				],
			},
		},
		// Canvas backgrounds mirror the app's background ladder (§2.1), generated from the token source; the
		// default matches the sidebar's --pane so components sit on the exact surface they ship on.
		backgrounds: { options: BACKGROUNDS },
	},
	initialGlobals: {
		backgrounds: { value: 'pane' },
	},
}

export default preview
