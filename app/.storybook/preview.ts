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
